import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import type { Meeting, TranscriptEntry } from '@shared/types'
import { resolveBinPath } from './assets'
import { log } from './log'
import { state } from './state'
import { readMeetingsData, scheduleOperation, writeMeetingsData } from './storage'
import { writeWavFile } from './wav'
import { createSileroVad, FRAME_DURATION_MS, type SileroVad } from './silero-vad'
import { createWhisperSession, type WhisperSession, type WhisperSource } from './whisper'
import { sendToRenderer } from './window'
import { runPostRecording } from './post-recording'
import { queueTranslation } from './translator'
import {
  startCompareModeRecallRecording,
  startRecallAdHocRecording,
  stopCompareModeRecallRecording,
  stopRecallRecording
} from './recall-sdk'

// Reversible eval flag: when on, route ALL ad-hoc recordings through the
// Recall SDK's prepareDesktopAudioRecording flow instead of the local Swift +
// whisper pipeline. Flip off (unset / =0) to return to local. Read on each
// call so toggling between runs is enough — no code changes needed.
function useRecallForAdHoc(): boolean {
  return process.env.MEEPCALL_USE_RECALL_FOR_ADHOC === '1'
}

// Side-by-side eval: when on, run BOTH local whisper and a shadow Recall
// recording on the same audio. Local writes to the meeting note as normal;
// Recall transcripts print to terminal only ([recall] tag) for comparison.
// Costs Recall credits ($0.65/hr) for the duration of the recording.
function compareModeEnabled(): boolean {
  return process.env.MEEPCALL_COMPARE_MODE === '1'
}

// Sliding-window chunking. Each whisper chunk is CHUNK_SECONDS wide; the
// pipeline advances by STEP_SECONDS per chunk, so adjacent chunks overlap
// by (CHUNK_SECONDS - STEP_SECONDS). The overlap gives whisper context
// across cut boundaries; segments inside the overlap region are dropped
// at transcript-emit time to avoid duplicate entries.
const CHUNK_SECONDS = 3
const STEP_SECONDS = 2
const OVERLAP_SECONDS = CHUNK_SECONDS - STEP_SECONDS

const STEP_BYTES = STEP_SECONDS * 16000 * 2 // 64,000 — fresh audio per chunk
const OVERLAP_BYTES = OVERLAP_SECONDS * 16000 * 2 // 32,000 — tail kept around
const CHUNK_BYTES = CHUNK_SECONDS * 16000 * 2 // 96,000 — full chunk fed to whisper
const STEP_MS = STEP_SECONDS * 1000

// Phrase-VAD chunking (MEEPCALL_PHRASE_VAD=1). Cut on natural silence
// boundaries detected by silero-vad (a small ONNX speech-detection model)
// instead of fixed time slices. Chunks are 1–5 s wide depending on where
// real speech pauses fall.
const PHRASE_MIN_BYTES = 1 * 16000 * 2 // 1 s — don't emit too-short chunks
const PHRASE_MAX_BYTES = 5 * 16000 * 2 // 5 s — hard cap if no silence detected
const PHRASE_SILENCE_END_MS = 400 // 400 ms of trailing silence = phrase end
// Silero outputs a speech probability 0..1 per 32 ms frame. 0.5 is the
// canonical threshold from the model card; higher = more selective (less
// likely to count quiet speech as silence), lower = more permissive.
const VAD_SPEECH_THRESHOLD = 0.5

function usePhraseVad(): boolean {
  return process.env.MEEPCALL_PHRASE_VAD === '1'
}

// If a helper's heartbeat shows 0 samplesWritten this many ms after the
// 'started' event, log a warning ONCE so the user sees their system source
// is silent. The most common cause is missing Screen Recording permission.
const SILENT_SOURCE_WARN_MS = 5000

interface SourceState {
  proc: ChildProcessByStdio<null, Readable, Readable>
  pending: Buffer[]
  pendingBytes: number
  chunkIndex: number
  // Sliding-window only: last OVERLAP_BYTES of previous chunk.
  tail: Buffer
  // Phrase-VAD only: silero VAD instance; per-source serial queue so async
  // VAD inference calls don't interleave (silero's LSTM state must be fed
  // sequentially); ms of trailing silence detected; absolute audio start
  // time of the next chunk to emit (ms since recording start).
  vad: SileroVad | null
  vadQueue: Promise<unknown>
  silenceMs: number
  chunkStartMs: number
  closed: Promise<void>
}

interface RecorderHandle {
  recordingId: string
  noteId: string
  startedAt: number
  whisper: WhisperSession
  mic: SourceState | null
  system: SourceState | null
}

const handles = new Map<string, RecorderHandle>()

function fireTranscript(noteId: string, entries: TranscriptEntry[]): void {
  if (entries.length === 0) return
  void scheduleOperation((data) => {
    const meeting = data.pastMeetings.find((m) => m.id === noteId)
    if (!meeting) return null
    if (!meeting.transcript) meeting.transcript = []
    meeting.transcript.push(...entries)
    sendToRenderer('transcript-updated', noteId)
    return data
  })
  for (const entry of entries) {
    log.local(`Transcript [${entry.speaker}]: ${entry.text}`)
    queueTranslation(noteId, entry)
  }
}

function spawnHelper(source: WhisperSource): ChildProcessByStdio<null, Readable, Readable> {
  const bin = resolveBinPath('audio-helper')
  const proc = spawn(bin, ['--source', source], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let lastSamples = 0
  let firstSamplesLogged = false
  let silenceWarned = false
  let silenceTimer: NodeJS.Timeout | null = null

  proc.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    if (!text) return
    for (const line of text.split('\n')) {
      try {
        const evt = JSON.parse(line)
        if (evt.event === 'error') {
          log.err('audio', `${source} helper: ${evt.code} ${evt.message}`)
        } else if (evt.event === 'starting' || evt.event === 'stopped') {
          log.local(`audio-helper(${source}): ${evt.event}`)
        } else if (evt.event === 'started') {
          log.local(`audio-helper(${source}): started`)
          // If no samples after SILENT_SOURCE_WARN_MS, the source is dead.
          // For system audio, that's almost always a missing Screen
          // Recording permission — the SCStream "starts" cleanly but
          // produces only silence. Tell the user directly so they don't
          // have to read source code to figure it out.
          silenceTimer = setTimeout(() => {
            if (!silenceWarned && lastSamples === 0) {
              silenceWarned = true
              if (source === 'system') {
                log.warn(
                  'audio',
                  'system audio is producing 0 samples — grant Screen Recording permission in System Settings → Privacy & Security → Screen & System Audio Recording, then restart meepcall. Until then "Other" labels will be empty and mic will catch speaker bleed as "You".'
                )
              } else {
                log.warn(
                  'audio',
                  'mic is producing 0 samples — check Microphone permission or input device.'
                )
              }
            }
          }, SILENT_SOURCE_WARN_MS)
        } else if (evt.event === 'heartbeat') {
          lastSamples = typeof evt.samplesWritten === 'number' ? evt.samplesWritten : lastSamples
          // One-shot confirmation that audio is actually flowing for this
          // source. Non-spammy: fires once per recording when the first
          // non-zero heartbeat lands.
          if (!firstSamplesLogged && lastSamples > 0) {
            firstSamplesLogged = true
            log.local(`audio-helper(${source}): receiving audio (${lastSamples} samples so far)`)
          }
        } else if (evt.event === 'route_change' || evt.event === 'route_recovered') {
          log.local(`audio-helper(${source}): ${evt.event}`)
        }
      } catch {
        log.warn('audio', `${source} helper non-json: ${line}`)
      }
    }
  })
  proc.on('close', () => {
    if (silenceTimer) clearTimeout(silenceTimer)
  })
  return proc
}

function attachStdoutPipeline(
  source: WhisperSource,
  handle: RecorderHandle,
  ss: SourceState
): void {
  const vad = usePhraseVad()
  ss.proc.stdout.on('data', (chunk: Buffer) => {
    if (vad) {
      // Serialize through the per-source VAD queue. Silero's LSTM state must
      // be fed sequentially or it corrupts.
      ss.vadQueue = ss.vadQueue.then(() => handlePhraseVadData(chunk, source, handle, ss))
    } else {
      handleSlidingWindowData(chunk, source, handle, ss)
    }
  })
}

function handleSlidingWindowData(
  chunk: Buffer,
  source: WhisperSource,
  handle: RecorderHandle,
  ss: SourceState
): void {
  ss.pending.push(chunk)
  ss.pendingBytes += chunk.length

  // Emit as many chunks as we have data for. The first chunk needs a full
  // CHUNK_BYTES of fresh audio (no tail yet); every chunk after that needs
  // STEP_BYTES of fresh audio and prepends the saved tail.
  while (true) {
    const isFirst = ss.chunkIndex === 0
    const needed = isFirst ? CHUNK_BYTES : STEP_BYTES
    if (ss.pendingBytes < needed) break

    const flat = Buffer.concat(ss.pending, ss.pendingBytes)
    const fresh = flat.subarray(0, needed)
    const chunkBuf = isFirst ? fresh : Buffer.concat([ss.tail, fresh])
    // Save last OVERLAP_BYTES of this chunk for the next one. Buffer.from
    // copies so we don't keep the full `flat` alive longer than needed.
    ss.tail = Buffer.from(chunkBuf.subarray(chunkBuf.length - OVERLAP_BYTES))

    const remainder = flat.subarray(needed)
    ss.pending = remainder.length > 0 ? [remainder] : []
    ss.pendingBytes = remainder.length

    const idx = ss.chunkIndex++
    const chunkStartMs = idx * STEP_MS
    void flushChunk(source, handle, chunkBuf, idx, chunkStartMs)
  }
}

async function handlePhraseVadData(
  chunk: Buffer,
  source: WhisperSource,
  handle: RecorderHandle,
  ss: SourceState
): Promise<void> {
  ss.pending.push(chunk)
  ss.pendingBytes += chunk.length

  // Run silero on this incoming buffer. It returns one speech probability
  // per 32 ms frame (FRAME_DURATION_MS). Frames are accumulated inside the
  // VAD instance — leftover sub-frame samples are carried over.
  const vad = ss.vad
  if (vad) {
    try {
      const probs = await vad.process(chunk)
      for (const p of probs) {
        if (p < VAD_SPEECH_THRESHOLD) ss.silenceMs += FRAME_DURATION_MS
        else ss.silenceMs = 0
      }
    } catch (err) {
      log.err('audio', `silero-vad inference failed: ${(err as Error).message}`)
    }
  }

  // Cut conditions: hit the hard cap, OR have enough audio AND a trailing
  // silence period long enough to be a phrase boundary.
  const hitMax = ss.pendingBytes >= PHRASE_MAX_BYTES
  const hitPause = ss.pendingBytes >= PHRASE_MIN_BYTES && ss.silenceMs >= PHRASE_SILENCE_END_MS

  if (!hitMax && !hitPause) return

  const chunkBuf = Buffer.concat(ss.pending, ss.pendingBytes)
  ss.pending = []
  ss.pendingBytes = 0
  ss.silenceMs = 0

  const idx = ss.chunkIndex++
  const chunkStartMs = ss.chunkStartMs
  // Each Int16 sample is 2 bytes at 16 kHz → 32 bytes per ms of audio.
  ss.chunkStartMs += chunkBuf.length / 32

  void flushChunk(source, handle, chunkBuf, idx, chunkStartMs)
}

async function flushChunk(
  source: WhisperSource,
  handle: RecorderHandle,
  pcm: Buffer,
  chunkIndex: number,
  chunkStartMs: number
): Promise<void> {
  const wavPath = join(tmpdir(), `meepcall-${handle.recordingId}-${source}-chunk-${chunkIndex}.wav`)
  try {
    await writeWavFile(wavPath, pcm)
  } catch (err) {
    log.err('audio', `failed to write chunk wav: ${(err as Error).message}`)
    return
  }
  try {
    const entries = await handle.whisper.transcribeChunk(
      wavPath,
      chunkIndex,
      source,
      chunkStartMs
    )
    fireTranscript(handle.noteId, entries)
  } catch (err) {
    log.err('audio', `whisper chunk failed: ${(err as Error).message}`)
  }
}

async function drainAndFlushFinal(
  source: WhisperSource,
  handle: RecorderHandle,
  ss: SourceState
): Promise<void> {
  const vad = usePhraseVad()
  // In phrase-VAD mode, wait for any in-flight inference on the queue to
  // finish first so the chunker has fully reacted to the last bytes.
  if (vad) {
    try {
      await ss.vadQueue
    } catch {
      /* ignore */
    }
  }

  // Nothing fresh since the last chunk — bail.
  if (ss.pendingBytes === 0) return

  const flat = Buffer.concat(ss.pending, ss.pendingBytes)
  const isFirst = ss.chunkIndex === 0
  // Phrase-VAD chunks don't overlap, so no tail to prepend.
  const chunkBuf = vad ? flat : isFirst ? flat : Buffer.concat([ss.tail, flat])
  ss.pending = []
  ss.pendingBytes = 0

  const idx = ss.chunkIndex++
  const chunkStartMs = vad ? ss.chunkStartMs : idx * STEP_MS
  if (vad) ss.chunkStartMs += chunkBuf.length / 32
  // Await this final chunk so the transcript is complete before the summary runs.
  await flushChunk(source, handle, chunkBuf, idx, chunkStartMs)
}

function startSource(handle: RecorderHandle, source: WhisperSource): SourceState {
  const proc = spawnHelper(source)
  const closed = new Promise<void>((resolve) => {
    proc.on('close', () => resolve())
    proc.on('exit', () => resolve())
  })
  const ss: SourceState = {
    proc,
    pending: [],
    pendingBytes: 0,
    chunkIndex: 0,
    tail: Buffer.alloc(0),
    vad: null,
    vadQueue: Promise.resolve(),
    silenceMs: 0,
    chunkStartMs: 0,
    closed
  }
  // Lazily create the silero VAD only when phrase-VAD mode is on. The first
  // session creation pays a ~150 ms onnxruntime warm-up; subsequent sources
  // reuse the cached InferenceSession via getSession().
  if (usePhraseVad()) {
    void createSileroVad()
      .then((v) => {
        ss.vad = v
      })
      .catch((err) => {
        log.err('audio', `silero-vad init failed: ${(err as Error).message}`)
      })
  }
  attachStdoutPipeline(source, handle, ss)
  return ss
}

async function stopSource(
  ss: SourceState,
  handle: RecorderHandle,
  source: WhisperSource
): Promise<void> {
  try {
    ss.proc.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  // Wait up to 3s for clean exit, then SIGKILL.
  const timeout = new Promise<void>((resolve) =>
    setTimeout(() => {
      try {
        ss.proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      resolve()
    }, 3000)
  )
  await Promise.race([ss.closed, timeout])
  await drainAndFlushFinal(source, handle, ss)
}

async function createRecording(
  noteId: string,
  recordingId: string,
  platformLabel: string
): Promise<void> {
  state.activeMeetingIds[recordingId] = { platformName: platformLabel, noteId }
  state.addRecording(recordingId, noteId, platformLabel)

  const handle: RecorderHandle = {
    recordingId,
    noteId,
    startedAt: Date.now(),
    whisper: createWhisperSession(recordingId, Date.now()),
    mic: null,
    system: null
  }
  handle.mic = startSource(handle, 'mic')
  handle.system = startSource(handle, 'system')
  handles.set(recordingId, handle)
  log.ok('audio', `Recording STARTED: id=${recordingId.slice(0, 8)}… note=${noteId}`)
}

export async function startAdHocRecording(
  label?: string
): Promise<
  { success: true; meetingId: string; recordingId: string } | { success: false; error: string }
> {
  if (useRecallForAdHoc()) {
    log.local('MEEPCALL_USE_RECALL_FOR_ADHOC=1 — routing ad-hoc recording through Recall SDK')
    return startRecallAdHocRecording(label)
  }

  const now = new Date()
  const id = `meeting-${Date.now()}`
  const recordingId = randomUUID()
  const title =
    label?.trim() ||
    `Audio Recording — ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`

  log.local(`Ad-hoc recording: creating note ${id} ("${title}")`)

  const data = await readMeetingsData()
  const newMeeting: Meeting = {
    id,
    type: 'document',
    title,
    subtitle: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    hasDemo: false,
    date: now.toISOString(),
    participants: [],
    content: `# ${title}\nRecording: In Progress...`,
    recordingId,
    platform: 'Desktop Audio',
    transcript: []
  }
  data.pastMeetings.unshift(newMeeting)
  await writeMeetingsData(data)

  try {
    await createRecording(id, recordingId, 'Desktop Audio')
  } catch (err) {
    state.removeRecording(recordingId)
    delete state.activeMeetingIds[recordingId]
    return { success: false, error: (err as Error).message }
  }

  if (compareModeEnabled()) {
    log.local('MEEPCALL_COMPARE_MODE=1 — starting parallel shadow Recall recording')
    void startCompareModeRecallRecording()
  }

  setTimeout(() => sendToRenderer('open-meeting-note', id), 300)
  return { success: true, meetingId: id, recordingId }
}

export async function startManualRecording(
  meetingId: string
): Promise<{ success: true; recordingId: string } | { success: false; error: string }> {
  const data = await readMeetingsData()
  const meeting = data.pastMeetings.find((m) => m.id === meetingId)
  if (!meeting) return { success: false, error: 'Meeting not found' }

  const recordingId = randomUUID()
  meeting.recordingId = recordingId
  if (!meeting.transcript) meeting.transcript = []
  await writeMeetingsData(data)

  try {
    await createRecording(meetingId, recordingId, 'Desktop Recording')
    return { success: true, recordingId }
  } catch (err) {
    state.removeRecording(recordingId)
    delete state.activeMeetingIds[recordingId]
    return { success: false, error: (err as Error).message }
  }
}

export async function stopManualRecording(
  recordingId: string
): Promise<{ success: true } | { success: false; error: string }> {
  const handle = handles.get(recordingId)
  if (!handle) {
    // No local handle — this might be a Recall-routed ad-hoc recording.
    // The recording-ended event handler will fire runPostRecording.
    if (state.activeMeetingIds[recordingId]) {
      log.local(`stopManualRecording: routing to Recall (window=${recordingId.slice(0, 8)}…)`)
      return stopRecallRecording(recordingId)
    }
    return { success: false, error: 'Recording not found' }
  }
  state.updateRecordingState(recordingId, 'stopping')

  try {
    const stops: Promise<void>[] = []
    if (handle.mic) stops.push(stopSource(handle.mic, handle, 'mic'))
    if (handle.system) stops.push(stopSource(handle.system, handle, 'system'))
    if (compareModeEnabled()) stops.push(stopCompareModeRecallRecording())
    await Promise.all(stops)
    await handle.whisper.flush()
    handle.whisper.destroy()
    handles.delete(recordingId)
    log.ok('audio', `Recording ENDED: id=${recordingId.slice(0, 8)}…`)

    try {
      await runPostRecording(handle.noteId)
    } catch (err) {
      log.err('audio', `post-recording failed: ${(err as Error).message}`)
    }

    state.removeRecording(recordingId)
    delete state.activeMeetingIds[recordingId]
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

export async function stopAll(): Promise<void> {
  const ids = [...handles.keys()]
  await Promise.all(ids.map((id) => stopManualRecording(id)))
}

// Best-effort kill of any running audio-helper child processes. Used on app
// quit so we don't leave Swift sidecars dangling. Skips post-recording
// (summary generation, etc.) since the app is shutting down.
export function killAllHelpers(): void {
  for (const handle of handles.values()) {
    try {
      handle.mic?.proc.kill('SIGTERM')
    } catch {
      /* ignore */
    }
    try {
      handle.system?.proc.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
}
