import Foundation
import AVFoundation
import AudioToolbox
import CoreAudio
import ScreenCaptureKit
import CoreMedia
import CoreGraphics

// ─── CLI args ────────────────────────────────────────────────────────────────

enum Source: String { case mic, system }

func parseArgs() -> Source {
  var source: Source = .mic
  var i = 1
  let argv = CommandLine.arguments
  while i < argv.count {
    if argv[i] == "--source", i + 1 < argv.count {
      if let s = Source(rawValue: argv[i + 1]) {
        source = s
      } else {
        emitError(code: "bad_source", message: "unknown --source: \(argv[i + 1])")
        exit(2)
      }
      i += 2
    } else {
      i += 1
    }
  }
  return source
}

// ─── stderr JSON events ──────────────────────────────────────────────────────

let stderr = FileHandle.standardError
let stderrLock = NSLock()

func emitJSON(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj),
        let str = String(data: data, encoding: .utf8) else { return }
  stderrLock.lock()
  defer { stderrLock.unlock() }
  if let line = (str + "\n").data(using: .utf8) {
    stderr.write(line)
  }
}

func emitError(code: String, message: String) {
  emitJSON(["event": "error", "code": code, "message": message])
}

// ─── stdout PCM writer ───────────────────────────────────────────────────────

let stdoutHandle = FileHandle.standardOutput
let stdoutLock = NSLock()
var totalSamplesWritten: Int = 0
let totalSamplesLock = NSLock()
// Recent-window RMS state: sum of squared sample values + count, reset each
// heartbeat tick. Lets the heartbeat report whether the audio is actually
// loud enough to be voice (>~0.005 normalized) or just silence/zero
// samples coming through (AirPods connected wrong, mic muted, etc.).
var rmsSquaredSum: Double = 0
var rmsSampleCount: Int = 0
let rmsLock = NSLock()

func writePCM(_ data: Data) {
  stdoutLock.lock()
  defer { stdoutLock.unlock() }
  stdoutHandle.write(data)
}

func bumpSamples(_ n: Int) {
  totalSamplesLock.lock()
  totalSamplesWritten += n
  totalSamplesLock.unlock()
}

// Update RMS accumulator with the just-emitted Int16 PCM. Called in the
// audio thread, kept cheap (no allocations).
func bumpRMS(_ ptr: UnsafePointer<Int16>, count: Int) {
  var sumSq: Double = 0
  for i in 0..<count {
    let s = Double(ptr[i]) / 32768.0
    sumSq += s * s
  }
  rmsLock.lock()
  rmsSquaredSum += sumSq
  rmsSampleCount += count
  rmsLock.unlock()
}

func drainRMS() -> Double {
  rmsLock.lock()
  let sum = rmsSquaredSum
  let cnt = rmsSampleCount
  rmsSquaredSum = 0
  rmsSampleCount = 0
  rmsLock.unlock()
  if cnt == 0 { return 0 }
  return (sum / Double(cnt)).squareRoot()
}

// ─── Output format: 16 kHz mono Int16 ────────────────────────────────────────

let outputFormat = AVAudioFormat(
  commonFormat: .pcmFormatInt16,
  sampleRate: 16000,
  channels: 1,
  interleaved: true
)!

// Software post-tap mic gain. Multiplies every Int16 sample by `micGain`
// with saturation arithmetic before writePCM. Knob for the AirPods /
// built-in low-RMS case where the mic is producing samples but they sit
// well below whisper's voice floor. AUVoiceProcessing (AGC) is a fancier
// fix but on some hardware/macOS combos it produces zero-length tap
// buffers (total dropout) — this is the simpler, no-fragility alternative.
// Defaults to 4.0 (~12 dB) because the built-in MacBook mic sits ~50 cm
// from the speaker and produces RMS right around whisper's voice-floor
// gate, so the unboosted path drops most chunks pre-whisper. Override
// with MEEPCALL_MIC_GAIN=1 to disable when using a close mic (AirPods
// as input, USB mic, etc.) where 4× would clip. Only applied to mic;
// system audio doesn't suffer from low-gain capture.
let micGain: Float = {
  guard let raw = ProcessInfo.processInfo.environment["MEEPCALL_MIC_GAIN"],
        let v = Float(raw), v > 0 else { return 4.0 }
  return v
}()

// ─── AVAudioConverter helper ─────────────────────────────────────────────────

func convertAndEmit(
  buffer inputBuffer: AVAudioPCMBuffer,
  converter: AVAudioConverter,
  gain: Float = 1.0
) {
  let inputSR = inputBuffer.format.sampleRate
  let outFrameCapacity = AVAudioFrameCount(
    Double(inputBuffer.frameLength) * 16000.0 / inputSR + 32
  )
  guard let outBuffer = AVAudioPCMBuffer(
    pcmFormat: outputFormat,
    frameCapacity: outFrameCapacity
  ) else {
    emitError(code: "alloc_failed", message: "could not allocate output AVAudioPCMBuffer")
    return
  }

  var error: NSError?
  var inputProvided = false
  let status = converter.convert(to: outBuffer, error: &error) { _, statusPtr in
    if inputProvided {
      statusPtr.pointee = .noDataNow
      return nil
    }
    inputProvided = true
    statusPtr.pointee = .haveData
    return inputBuffer
  }
  if status == .error {
    emitError(code: "convert_failed", message: error?.localizedDescription ?? "unknown")
    return
  }

  let frameCount = Int(outBuffer.frameLength)
  guard frameCount > 0, let int16Ptr = outBuffer.int16ChannelData?[0] else { return }

  // Apply software gain in-place BEFORE the Data copy + writePCM + RMS
  // measurement so downstream sees the boosted signal. Int32 widening +
  // Int16(clamping:) gives saturation arithmetic — peaks pin to ±32767
  // instead of wrapping, which would sound like nasty clicks. RMS is
  // measured post-gain so the voice-floor diagnostic reflects what
  // whisper-cli actually receives.
  if gain != 1.0 {
    for i in 0..<frameCount {
      int16Ptr[i] = Int16(clamping: Int32(Float(int16Ptr[i]) * gain))
    }
  }

  let byteCount = frameCount * MemoryLayout<Int16>.size
  let data = Data(bytes: int16Ptr, count: byteCount)
  writePCM(data)
  bumpSamples(frameCount)
  bumpRMS(int16Ptr, count: frameCount)
}

// ─── Input device selection ─────────────────────────────────────────────────

// Find the AudioDeviceID of the built-in microphone, if present. Walks the
// global device list, filters by `kAudioDevicePropertyTransportType ==
// kAudioDeviceTransportTypeBuiltIn`, and requires at least one input
// stream (the built-in speaker output device shares transport type but
// has no input scope). Returns nil on Macs with no built-in mic
// (Mac Pro, some Mac mini configurations).
//
// Why force built-in: when AirPods are connected, macOS routes them in
// A2DP mode (high-quality stereo output, no mic). AirPods microphones
// only activate in HFP/SCO mode — and toggling to HFP downgrades audio
// output to narrowband. Default macOS behavior with AirPods + a mic
// request is unpredictable: sometimes it switches to HFP (degrades
// output), sometimes it stays in A2DP and hands back zero-sample mic
// buffers (the symptom you see as "RMS 0.00000"). Pinning input to the
// built-in mic keeps AirPods in A2DP and captures voice from the Mac
// itself — the standard pattern for desk-attached calls.
func findBuiltInInputDevice() -> AudioDeviceID? {
  var listAddr = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDevices,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  let sysObj = AudioObjectID(kAudioObjectSystemObject)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(sysObj, &listAddr, 0, nil, &size) == noErr,
        size > 0 else { return nil }
  let count = Int(size) / MemoryLayout<AudioDeviceID>.size
  var devices = [AudioDeviceID](repeating: 0, count: count)
  size = UInt32(count * MemoryLayout<AudioDeviceID>.size)
  guard AudioObjectGetPropertyData(sysObj, &listAddr, 0, nil, &size, &devices) == noErr else {
    return nil
  }

  for device in devices {
    var transport: UInt32 = 0
    var transSize: UInt32 = UInt32(MemoryLayout<UInt32>.size)
    var transAddr = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyTransportType,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    if AudioObjectGetPropertyData(device, &transAddr, 0, nil, &transSize, &transport) != noErr {
      continue
    }
    if transport != kAudioDeviceTransportTypeBuiltIn { continue }

    // Must have at least one input stream — the built-in speaker output
    // shares transport type but has no input scope.
    var streamAddr = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyStreams,
      mScope: kAudioDevicePropertyScopeInput,
      mElement: kAudioObjectPropertyElementMain
    )
    var streamSize: UInt32 = 0
    if AudioObjectGetPropertyDataSize(device, &streamAddr, 0, nil, &streamSize) != noErr {
      continue
    }
    if streamSize == 0 { continue }

    return device
  }
  return nil
}

// Read a CoreAudio device's name for logging.
func deviceName(for device: AudioDeviceID) -> String? {
  var nameAddr = AudioObjectPropertyAddress(
    mSelector: kAudioObjectPropertyName,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var name: CFString = "" as CFString
  var size: UInt32 = UInt32(MemoryLayout<CFString>.size)
  let status = withUnsafeMutablePointer(to: &name) { ptr -> OSStatus in
    return AudioObjectGetPropertyData(device, &nameAddr, 0, nil, &size, ptr)
  }
  guard status == noErr else { return nil }
  return name as String
}

// ─── Mic capture ─────────────────────────────────────────────────────────────

final class MicCapture {
  let engine = AVAudioEngine()
  var converter: AVAudioConverter?
  var observer: NSObjectProtocol?
  let lock = NSLock()

  func start() throws {
    try installTapAndStart()

    if micGain != 1.0 {
      emitJSON(["event": "mic_gain", "gain": Double(micGain)])
    }

    // AVAudioEngine fires this when the input/output device changes (AirPods
    // plugging in, headphones, sample-rate switch). The engine's nodes are
    // stopped and the existing tap+converter are stale — rebuild from the new
    // input format or the helper goes silent.
    observer = NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange,
      object: engine,
      queue: .main
    ) { [weak self] _ in
      self?.handleConfigChange()
    }
  }

  private func installTapAndStart() throws {
    let input = engine.inputNode

    // Bind the engine's input AudioUnit to the built-in mic by default.
    // See findBuiltInInputDevice() for the rationale (AirPods A2DP zero-
    // sample bug). Set MEEPCALL_USE_DEFAULT_INPUT=1 to opt out and keep
    // the system-default behavior (rare — only useful if you actually
    // want the AirPods/USB-headset mic and accept the HFP audio
    // degradation that comes with it).
    let useDefault = ProcessInfo.processInfo.environment["MEEPCALL_USE_DEFAULT_INPUT"] == "1"
    if !useDefault, let builtInID = findBuiltInInputDevice(), let au = input.audioUnit {
      var deviceID = builtInID
      let status = AudioUnitSetProperty(
        au,
        kAudioOutputUnitProperty_CurrentDevice,
        kAudioUnitScope_Global,
        0,
        &deviceID,
        UInt32(MemoryLayout<AudioDeviceID>.size)
      )
      if status == noErr {
        emitJSON([
          "event": "input_device",
          "type": "built_in",
          "name": deviceName(for: builtInID) ?? "unknown"
        ])
      } else {
        emitJSON([
          "event": "input_device",
          "type": "default",
          "reason": "AudioUnitSetProperty failed: \(status)"
        ])
      }
    } else if useDefault {
      emitJSON(["event": "input_device", "type": "default", "reason": "MEEPCALL_USE_DEFAULT_INPUT=1"])
    } else {
      emitJSON(["event": "input_device", "type": "default", "reason": "no built-in mic found"])
    }

    // Voice processing (AGC + noise suppression + acoustic echo cancellation
    // via Apple's AUVoiceProcessing AU) is OPT-IN. It would be the right fix
    // for AirPods low-gain RMS, but on some configurations enabling it
    // produces zero-length buffers (the tap fires but every frame is empty)
    // — total mic dropout. Default behavior is now raw mic, matching the
    // pre-VP baseline that was known-working. Set MEEPCALL_VOICE_PROCESSING=1
    // to opt in if your hardware tolerates it; useful for AirPods + quiet
    // voice setups where the alternative is silent samples.
    if ProcessInfo.processInfo.environment["MEEPCALL_VOICE_PROCESSING"] == "1" {
      do {
        try input.setVoiceProcessingEnabled(true)
        emitJSON(["event": "voice_processing", "enabled": true])
      } catch {
        emitJSON([
          "event": "voice_processing",
          "enabled": false,
          "error": error.localizedDescription
        ])
      }
    }
    let inputFormat = input.outputFormat(forBus: 0)
    guard inputFormat.sampleRate > 0 else {
      throw NSError(
        domain: "audio-helper",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "input format invalid (no mic permission?)"]
      )
    }
    let conv = AVAudioConverter(from: inputFormat, to: outputFormat)
    guard let conv else {
      throw NSError(
        domain: "audio-helper",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: "could not create AVAudioConverter for mic"]
      )
    }
    converter = conv

    input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
      guard let self, let conv = self.converter else { return }
      convertAndEmit(buffer: buffer, converter: conv, gain: micGain)
    }

    engine.prepare()
    try engine.start()
  }

  private func handleConfigChange() {
    lock.lock()
    defer { lock.unlock() }

    emitJSON(["event": "route_change", "source": "mic"])

    engine.inputNode.removeTap(onBus: 0)
    if engine.isRunning { engine.stop() }
    converter = nil

    // Devices can be mid-transition for ~100ms (sampleRate=0). Retry briefly.
    for attempt in 1...5 {
      do {
        try installTapAndStart()
        emitJSON(["event": "route_recovered", "source": "mic", "attempt": attempt])
        return
      } catch {
        if attempt == 5 {
          emitError(code: "route_recover_failed", message: error.localizedDescription)
          return
        }
        Thread.sleep(forTimeInterval: 0.2)
      }
    }
  }

  func stop() {
    if let observer { NotificationCenter.default.removeObserver(observer) }
    observer = nil
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
  }
}

// ─── System audio capture (ScreenCaptureKit) ────────────────────────────────

final class SystemCapture: NSObject, SCStreamDelegate, SCStreamOutput {
  var stream: SCStream?
  var converter: AVAudioConverter?
  var inputFormat: AVAudioFormat?
  let queue = DispatchQueue(label: "ai.recall.audio-helper.sck", qos: .userInteractive)
  // Diagnostics for "stream started but no samples" symptom. Counts every
  // delegate invocation so we can tell whether buffers are arriving at all,
  // arriving as invalid, or failing the PCM conversion.
  var rawCallbackCount: Int = 0
  var invalidBufferCount: Int = 0
  var pcmConvertFailCount: Int = 0
  let diagLock = NSLock()

  func start() async throws {
    // TCC pre-flight. SCStream.startCapture() does NOT throw when Screen
    // Recording is denied — it silently produces zero audio buffers, which
    // is exactly the symptom we're debugging. Check explicitly so we can
    // surface a real error instead of a silent helper.
    if !CGPreflightScreenCaptureAccess() {
      // Trigger the system prompt so the user sees the right entry in
      // Privacy & Security. For unbundled CLI binaries the prompt may be
      // attributed to the parent (Electron) — that's expected.
      _ = CGRequestScreenCaptureAccess()
      throw NSError(
        domain: "audio-helper",
        code: 4,
        userInfo: [NSLocalizedDescriptionKey:
          "Screen Recording permission denied for this binary. Open System Settings → Privacy & Security → Screen & System Audio Recording, remove any stale 'audio-helper' / 'meepcall' / 'Electron' entries, then re-launch and approve when prompted."]
      )
    }

    let content = try await SCShareableContent.excludingDesktopWindows(
      false,
      onScreenWindowsOnly: true
    )
    guard let display = content.displays.first else {
      throw NSError(
        domain: "audio-helper",
        code: 3,
        userInfo: [NSLocalizedDescriptionKey: "no displays available for SCStream"]
      )
    }

    let filter = SCContentFilter(
      display: display,
      excludingApplications: [],
      exceptingWindows: []
    )

    let config = SCStreamConfiguration()
    config.capturesAudio = true
    config.excludesCurrentProcessAudio = true
    config.sampleRate = 48000
    config.channelCount = 2
    // Video config is required even though we ignore it.
    config.width = 2
    config.height = 2
    config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    config.queueDepth = 5

    let s = SCStream(filter: filter, configuration: config, delegate: self)
    try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
    try await s.startCapture()
    self.stream = s
  }

  func stop() async {
    guard let s = stream else { return }
    do {
      try await s.stopCapture()
    } catch {
      emitError(code: "scstream_stop_failed", message: error.localizedDescription)
    }
    stream = nil
  }

  // MARK: SCStreamOutput
  func stream(
    _ stream: SCStream,
    didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
    of type: SCStreamOutputType
  ) {
    diagLock.lock()
    rawCallbackCount += 1
    diagLock.unlock()
    guard type == .audio else { return }
    guard sampleBuffer.isValid else {
      diagLock.lock(); invalidBufferCount += 1; diagLock.unlock()
      return
    }
    guard let pcmBuffer = pcmBufferFromSampleBuffer(sampleBuffer) else {
      diagLock.lock(); pcmConvertFailCount += 1; diagLock.unlock()
      return
    }
    if converter == nil {
      converter = AVAudioConverter(from: pcmBuffer.format, to: outputFormat)
      inputFormat = pcmBuffer.format
      if converter == nil {
        emitError(
          code: "convert_init_failed",
          message: "could not create AVAudioConverter for system audio"
        )
        return
      }
    }
    if let conv = converter {
      convertAndEmit(buffer: pcmBuffer, converter: conv)
    }
  }

  func snapshotDiagnostics() -> (raw: Int, invalid: Int, pcmFail: Int) {
    diagLock.lock()
    defer { diagLock.unlock() }
    return (rawCallbackCount, invalidBufferCount, pcmConvertFailCount)
  }

  // MARK: SCStreamDelegate
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    emitError(code: "scstream_stopped", message: error.localizedDescription)
  }
}

nonisolated(unsafe) var pcmFailReasonLogged = Set<String>()
let pcmFailReasonLock = NSLock()

func logPcmFailOnce(_ reason: String) {
  pcmFailReasonLock.lock()
  let isNew = pcmFailReasonLogged.insert(reason).inserted
  pcmFailReasonLock.unlock()
  if isNew {
    emitJSON(["event": "pcm_fail_reason", "reason": reason])
  }
}

// Build an AVAudioPCMBuffer from a CMSampleBuffer's audio buffer list.
func pcmBufferFromSampleBuffer(_ sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
  guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer) else {
    logPcmFailOnce("no_format_description")
    return nil
  }
  guard let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription) else {
    logPcmFailOnce("no_asbd")
    return nil
  }
  var asbd = asbdPtr.pointee
  guard let format = AVAudioFormat(streamDescription: &asbd) else {
    logPcmFailOnce("avaudioformat_init_nil_sr=\(asbd.mSampleRate)_ch=\(asbd.mChannelsPerFrame)_fmt=\(asbd.mFormatID)_flags=\(asbd.mFormatFlags)_bits=\(asbd.mBitsPerChannel)")
    return nil
  }

  let frameCount = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
  if frameCount == 0 {
    logPcmFailOnce("zero_frames")
    return nil
  }
  guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else {
    logPcmFailOnce("pcm_buffer_alloc_nil_sr=\(format.sampleRate)_ch=\(format.channelCount)_interleaved=\(format.isInterleaved)")
    return nil
  }
  buffer.frameLength = frameCount

  // SCStream returns multi-channel non-interleaved audio (2 separate buffers
  // for stereo Float32). The stack-allocated `AudioBufferList()` only has
  // room for ONE `AudioBuffer` slot — the second buffer's metadata won't
  // fit and CoreMedia returns kCMSampleBufferError_ArrayTooSmall (-12737).
  // Query the needed size first, then heap-allocate an AudioBufferList that
  // can hold every channel buffer.
  var sizeNeeded: Int = 0
  let probeStatus = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
    sampleBuffer,
    bufferListSizeNeededOut: &sizeNeeded,
    bufferListOut: nil,
    bufferListSize: 0,
    blockBufferAllocator: nil,
    blockBufferMemoryAllocator: nil,
    flags: 0,
    blockBufferOut: nil
  )
  guard probeStatus == noErr, sizeNeeded > 0 else {
    logPcmFailOnce("abl_size_probe_status_\(probeStatus)_size_\(sizeNeeded)")
    return nil
  }

  let ablRaw = UnsafeMutableRawPointer.allocate(
    byteCount: sizeNeeded,
    alignment: MemoryLayout<AudioBufferList>.alignment
  )
  defer { ablRaw.deallocate() }
  let ablPtr = ablRaw.assumingMemoryBound(to: AudioBufferList.self)

  var blockBuffer: CMBlockBuffer?
  let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
    sampleBuffer,
    bufferListSizeNeededOut: nil,
    bufferListOut: ablPtr,
    bufferListSize: sizeNeeded,
    blockBufferAllocator: nil,
    blockBufferMemoryAllocator: nil,
    flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
    blockBufferOut: &blockBuffer
  )
  guard status == noErr else {
    logPcmFailOnce("audiobufferlist_status_\(status)")
    return nil
  }

  let dst = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
  let src = UnsafeMutableAudioBufferListPointer(ablPtr)
  for i in 0..<min(dst.count, src.count) {
    let dstBuf = dst[i]
    let srcBuf = src[i]
    if let d = dstBuf.mData, let s = srcBuf.mData {
      let n = Int(min(dstBuf.mDataByteSize, srcBuf.mDataByteSize))
      memcpy(d, s, n)
    }
  }

  return buffer
}

// ─── Heartbeat ───────────────────────────────────────────────────────────────

nonisolated(unsafe) var systemDiagSource: SystemCapture?

func startHeartbeat() {
  Thread {
    while true {
      Thread.sleep(forTimeInterval: 1.0)
      totalSamplesLock.lock()
      let n = totalSamplesWritten
      totalSamplesLock.unlock()
      let rms = drainRMS()
      // Round to 4 decimals to keep the JSON line compact.
      let rmsRounded = (rms * 10000).rounded() / 10000
      var beat: [String: Any] = [
        "event": "heartbeat",
        "samplesWritten": n,
        "rms": rmsRounded
      ]
      if let sys = systemDiagSource {
        let d = sys.snapshotDiagnostics()
        beat["scCallbacks"] = d.raw
        beat["scInvalidBuffers"] = d.invalid
        beat["scPcmFails"] = d.pcmFail
      }
      emitJSON(beat)
    }
  }.start()
}

// ─── Signal handling ─────────────────────────────────────────────────────────

let exitSemaphore = DispatchSemaphore(value: 0)
nonisolated(unsafe) var teardown: (@Sendable () async -> Void)?

func installSignalHandlers() {
  let handler: @convention(c) (Int32) -> Void = { _ in
    exitSemaphore.signal()
  }
  signal(SIGTERM, handler)
  signal(SIGINT, handler)
}

// ─── Main ────────────────────────────────────────────────────────────────────

let source = parseArgs()
emitJSON(["event": "starting", "source": source.rawValue])
installSignalHandlers()
startHeartbeat()

let mic = MicCapture()
let sys = SystemCapture()

do {
  switch source {
  case .mic:
    try mic.start()
    teardown = { mic.stop() }
    emitJSON(["event": "started", "source": source.rawValue])
  case .system:
    // Async startup. Only emit "started" after startCapture() actually
    // returns, otherwise the parent thinks SCStream is up while we're
    // still negotiating with TCC. On failure, emit the real error and
    // shut down so the parent doesn't sit waiting on silent audio.
    systemDiagSource = sys
    let task = Task {
      do {
        try await sys.start()
        emitJSON(["event": "started", "source": source.rawValue])
      } catch {
        emitError(code: "sck_start_failed", message: error.localizedDescription)
        exitSemaphore.signal()
      }
    }
    _ = task  // keep reference alive
    teardown = { await sys.stop() }
  }
} catch {
  emitError(code: "start_failed", message: error.localizedDescription)
  exit(1)
}

// Block until SIGTERM
exitSemaphore.wait()

// Graceful teardown
let teardownDone = DispatchSemaphore(value: 0)
Task {
  await teardown?()
  teardownDone.signal()
}
_ = teardownDone.wait(timeout: .now() + .seconds(2))

try? stdoutHandle.synchronize()
emitJSON(["event": "stopped", "source": source.rawValue])
exit(0)
