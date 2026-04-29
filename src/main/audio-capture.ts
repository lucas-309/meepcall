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
import { createWhisperSession, type WhisperSession, type WhisperSource } from './whisper'
import { sendToRenderer } from './window'
import { runPostRecording } from './post-recording'
import { startRecallAdHocRecording, stopRecallRecording } from './recall-sdk'

// Reversible eval flag: when on, route ALL ad-hoc recordings through the
// Recall SDK's prepareDesktopAudioRecording flow instead of the local Swift +
// whisper pipeline. Flip off (unset / =0) to return to local. Read on each
// call so toggling between runs is enough — no code changes needed.
function useRecallForAdHoc(): boolean {
  return process.env.MEEPCALL_USE_RECALL_FOR_ADHOC === '1'
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
const OVERLAP_MS = OVERLAP_SECONDS * 1000

interface SourceState {
  proc: ChildProcessByStdio<null, Readable, Readable>
  pending: Buffer[]
  pendingBytes: number
  chunkIndex: number
  // Last OVERLAP_BYTES of the most recently emitted chunk. Prepended to the
  // next chunk so whisper sees a 3-second window every time.
  tail: Buffer
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
  }
}

function spawnHelper(source: WhisperSource): ChildProcessByStdio<null, Readable, Readable> {
  const bin = resolveBinPath('audio-helper')
  const proc = spawn(bin, ['--source', source], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  proc.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    if (!text) return
    for (const line of text.split('\n')) {
      try {
        const evt = JSON.parse(line)
        if (evt.event === 'error') {
          log.err('audio', `${source} helper: ${evt.code} ${evt.message}`)
        } else if (evt.event === 'starting' || evt.event === 'started' || evt.event === 'stopped') {
          log.local(`audio-helper(${source}): ${evt.event}`)
        }
      } catch {
        log.warn('audio', `${source} helper non-json: ${line}`)
      }
    }
  })
  return proc
}

function attachStdoutPipeline(
  source: WhisperSource,
  handle: RecorderHandle,
  ss: SourceState
): void {
  ss.proc.stdout.on('data', (chunk: Buffer) => {
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
      const skipBeforeMs = isFirst ? 0 : OVERLAP_MS
      void flushChunk(source, handle, chunkBuf, idx, chunkStartMs, skipBeforeMs)
    }
  })
}

async function flushChunk(
  source: WhisperSource,
  handle: RecorderHandle,
  pcm: Buffer,
  chunkIndex: number,
  chunkStartMs: number,
  skipBeforeMs: number
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
      chunkStartMs,
      skipBeforeMs
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
  // Tail-only (no fresh audio since last chunk) would emit nothing past the
  // overlap-skip — bail.
  if (ss.pendingBytes === 0) return

  const flat = Buffer.concat(ss.pending, ss.pendingBytes)
  const isFirst = ss.chunkIndex === 0
  const chunkBuf = isFirst ? flat : Buffer.concat([ss.tail, flat])
  ss.pending = []
  ss.pendingBytes = 0

  const idx = ss.chunkIndex++
  const chunkStartMs = idx * STEP_MS
  const skipBeforeMs = isFirst ? 0 : OVERLAP_MS
  // Await this final chunk so the transcript is complete before the summary runs.
  await flushChunk(source, handle, chunkBuf, idx, chunkStartMs, skipBeforeMs)
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
    closed
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
