import Foundation
import AVFoundation
import ScreenCaptureKit
import CoreMedia

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

// ─── Output format: 16 kHz mono Int16 ────────────────────────────────────────

let outputFormat = AVAudioFormat(
  commonFormat: .pcmFormatInt16,
  sampleRate: 16000,
  channels: 1,
  interleaved: true
)!

// ─── AVAudioConverter helper ─────────────────────────────────────────────────

func convertAndEmit(buffer inputBuffer: AVAudioPCMBuffer, converter: AVAudioConverter) {
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
  let byteCount = frameCount * MemoryLayout<Int16>.size
  let data = Data(bytes: int16Ptr, count: byteCount)
  writePCM(data)
  bumpSamples(frameCount)
}

// ─── Mic capture ─────────────────────────────────────────────────────────────

final class MicCapture {
  let engine = AVAudioEngine()
  var converter: AVAudioConverter?
  var observer: NSObjectProtocol?
  let lock = NSLock()

  func start() throws {
    try installTapAndStart()

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
      convertAndEmit(buffer: buffer, converter: conv)
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

  func start() async throws {
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

    let myPID = ProcessInfo.processInfo.processIdentifier
    let myApp = content.applications.first { $0.processID == myPID }
    let excluded: [SCRunningApplication] = myApp.map { [$0] } ?? []

    let filter = SCContentFilter(
      display: display,
      excludingApplications: excluded,
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
    guard type == .audio, sampleBuffer.isValid else { return }
    guard let pcmBuffer = pcmBufferFromSampleBuffer(sampleBuffer) else { return }
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

  // MARK: SCStreamDelegate
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    emitError(code: "scstream_stopped", message: error.localizedDescription)
  }
}

// Build an AVAudioPCMBuffer from a CMSampleBuffer's audio buffer list.
func pcmBufferFromSampleBuffer(_ sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
  guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer) else {
    return nil
  }
  guard let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription) else {
    return nil
  }
  var asbd = asbdPtr.pointee
  guard let format = AVAudioFormat(streamDescription: &asbd) else {
    return nil
  }

  let frameCount = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
  guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else {
    return nil
  }
  buffer.frameLength = frameCount

  var bufferList = AudioBufferList()
  var blockBuffer: CMBlockBuffer?
  let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
    sampleBuffer,
    bufferListSizeNeededOut: nil,
    bufferListOut: &bufferList,
    bufferListSize: MemoryLayout<AudioBufferList>.size,
    blockBufferAllocator: nil,
    blockBufferMemoryAllocator: nil,
    flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
    blockBufferOut: &blockBuffer
  )
  guard status == noErr else { return nil }

  let abl = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
  let src = UnsafeMutableAudioBufferListPointer(&bufferList)
  for i in 0..<min(abl.count, src.count) {
    let dstBuf = abl[i]
    let srcBuf = src[i]
    if let dst = dstBuf.mData, let s = srcBuf.mData {
      let n = Int(min(dstBuf.mDataByteSize, srcBuf.mDataByteSize))
      memcpy(dst, s, n)
    }
  }

  return buffer
}

// ─── Heartbeat ───────────────────────────────────────────────────────────────

func startHeartbeat() {
  Thread {
    while true {
      Thread.sleep(forTimeInterval: 1.0)
      totalSamplesLock.lock()
      let n = totalSamplesWritten
      totalSamplesLock.unlock()
      emitJSON(["event": "heartbeat", "samplesWritten": n])
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
  case .system:
    let task = Task {
      do {
        try await sys.start()
      } catch {
        emitError(code: "sck_start_failed", message: error.localizedDescription)
        exitSemaphore.signal()
      }
    }
    _ = task  // keep reference alive
    teardown = { await sys.stop() }
  }
  emitJSON(["event": "started", "source": source.rawValue])
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
