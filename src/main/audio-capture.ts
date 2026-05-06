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

// Fixed-window chunking. Each whisper chunk is CHUNK_SECONDS wide; the
// pipeline advances by exactly CHUNK_SECONDS per chunk (no overlap, no
// tail). Smaller chunks keep live latency low — end-to-end is roughly
// CHUNK_SECONDS (audio wait) + whisper inference time. We dropped the
// 1 s overlap that used to bridge cut boundaries because it doubled the
// dedup machinery and only helped if a word fell exactly on a chunk
// edge; for live debugging the occasional clipped boundary word is a
// fine trade for halving end-to-end latency.
const CHUNK_SECONDS = 2
const CHUNK_BYTES = CHUNK_SECONDS * 16000 * 2 // 64,000 — bytes per chunk
const CHUNK_MS = CHUNK_SECONDS * 1000

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

// Backpressure for the per-source whisper pipeline. Each chunk's
// transcribeChunk call is awaited inside whisper.ts's per-source serial
// queue, so a single slow chunk (CPU spike, swap, paged-out model weights)
// stalls the chain. Without a cap, chunks pile up monotonically — by minute
// 20 of a recording the backlog can be tens of seconds and live captions
// drift far behind audio with no recovery path. Cap the number of in-flight
// chunks per source: if we'd exceed it, drop the new chunk so audio loss
// during slowdowns replaces live-caption lag. Default 3 = 6 s of backlog
// at the 2 s chunk step before we start shedding.
const MAX_INFLIGHT_CHUNKS = (() => {
  const raw = Number(process.env.MEEPCALL_MAX_INFLIGHT_CHUNKS)
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw)
  return 3
})()

// Pre-whisper silence gate. If a chunk's RMS amplitude is below this
// threshold, skip the whisper-cli invocation entirely — the chunk is
// silence, whisper would either return nothing or hallucinate ghost lines
// like "Okay." / "Thanks for watching." / "[Music]". Skipping fixes BOTH
// the hallucination spam AND the CPU pressure that triggers backpressure
// for real speech later.
//
// Threshold rationale: 0.001 is "essentially silent" (1/1000 of full
// scale Int16). The Swift heartbeat reports voice activity above ~0.005;
// background hum sits between 0.0003 and 0.0008. 0.001 splits the
// difference — drops chunks below background hum but keeps anything that
// could plausibly be quiet voice. Set MEEPCALL_SILENCE_RMS_SKIP=0 to
// disable (forwards every chunk to whisper unconditionally).
const SILENCE_RMS_SKIP = (() => {
  const raw = process.env.MEEPCALL_SILENCE_RMS_SKIP
  if (raw === undefined || raw === '') return 0.001
  const v = Number(raw)
  return Number.isFinite(v) && v >= 0 ? v : 0.001
})()

// RMS amplitude of an interleaved Int16 LE PCM buffer, normalized to
// [-1, 1]. Used by the pre-whisper silence gate. Single pass over ~32k
// Int16 samples (2 s @ 16 kHz) takes ~1 ms — cheap relative to the ~2 s
// whisper inference it lets us skip.
function rmsOfPcm(pcm: Buffer): number {
  const samples = pcm.length >> 1
  if (samples === 0) return 0
  let sumSq = 0
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const s = pcm.readInt16LE(i) / 32768
    sumSq += s * s
  }
  return Math.sqrt(sumSq / samples)
}


interface SourceState {
  proc: ChildProcessByStdio<null, Readable, Readable>
  pending: Buffer[]
  pendingBytes: number
  chunkIndex: number
  // Phrase-VAD only: silero VAD instance; per-source serial queue so async
  // VAD inference calls don't interleave (silero's LSTM state must be fed
  // sequentially); ms of trailing silence detected; absolute audio start
  // time of the next chunk to emit (ms since recording start).
  vad: SileroVad | null
  vadQueue: Promise<unknown>
  silenceMs: number
  chunkStartMs: number
  closed: Promise<void>
  // Backpressure counters: chunks currently between flushChunk entry and
  // exit (whisper-cli still working) and total chunks shed because the
  // queue was full. The dropped count is logged once on stop so the user
  // sees how much audio they lost to slowdowns. recentInferMs is a small
  // rolling window of the most recent whisper-cli wall-clock times for
  // this source — surfaced in the backpressure-drop warn so the user can
  // see WHY whisper is behind (slow inference vs queue stuck for some
  // other reason).
  inFlight: number
  droppedChunks: number
  recentInferMs: number[]
}

const RECENT_INFER_LEN = 5

interface RecorderHandle {
  recordingId: string
  noteId: string
  startedAt: number
  whisper: WhisperSession
  mic: SourceState | null
  system: SourceState | null
}

const handles = new Map<string, RecorderHandle>()

// Cross-source bleed dedup. Mic picks up speaker bleed whenever the user
// isn't on headphones — a song, a video, the other side of a call — so
// the same utterance lands in BOTH sources at slightly different times.
// Whisper transcribes each independently from different waveforms, so we
// don't get IDENTICAL strings — we get FRAGMENTS of each other ("to how
// do you" / "How do you make it?") emitted seconds apart, because mic
// and system chunkers buffer audio independently.
//
// Two-direction defense:
//   1. **Forward** — when mic emits, check the recent-system ring and
//      drop the mic entry before it's persisted. Catches the
//      system-first race.
//   2. **Backward** — when system emits, scan recent mic entries already
//      in the transcript and remove any that fuzzy-match. Catches the
//      mic-first race (which is most of the user's data because mic
//      chunks complete decoding faster than system chunks under load).
//
// Backward removal is destructive (mutates the persisted transcript) but
// the alternative — holding mic emissions for 3 s before persisting —
// adds caption latency that's worse for the live use case. The brief
// flicker as bleed entries appear and disappear is acceptable.
//
// Fuzzy match: exact normalized equality, OR substring containment (one
// is fragment of the other), OR ≥3 shared tokens with ≥60% overlap. The
// 3-token + 60% combination is conservative enough to not catch real
// conversation ("yes I agree" / "I agree completely" share only 2 tokens,
// kept) while catching real bleed fragments.
const CROSS_SOURCE_AUDIO_DELTA_MS = 4000
const CROSS_SOURCE_RETENTION_MS = 8000
const CROSS_SOURCE_MIN_LEN = 4
const CROSS_SOURCE_FUZZY_MIN_CHARS = 8
const CROSS_SOURCE_FUZZY_MIN_TOKENS = 3
const CROSS_SOURCE_FUZZY_OVERLAP = 0.6

interface RecentSysEntry {
  norm: string
  tokens: Set<string>
  tsMs: number
}
const recentSystemByNote = new Map<string, RecentSysEntry[]>()

function normalizeForDedup(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenize(norm: string): Set<string> {
  if (!norm) return new Set()
  return new Set(norm.split(/\s+/).filter((t) => t.length > 0))
}

function fuzzyDedupMatch(
  aNorm: string,
  aTokens: Set<string>,
  bNorm: string,
  bTokens: Set<string>
): boolean {
  if (aNorm.length < CROSS_SOURCE_MIN_LEN || bNorm.length < CROSS_SOURCE_MIN_LEN) return false
  if (aNorm === bNorm) return true
  const minLen = Math.min(aNorm.length, bNorm.length)
  if (minLen >= CROSS_SOURCE_FUZZY_MIN_CHARS) {
    if (aNorm.includes(bNorm) || bNorm.includes(aNorm)) return true
    let intersect = 0
    for (const t of aTokens) if (bTokens.has(t)) intersect++
    if (intersect >= CROSS_SOURCE_FUZZY_MIN_TOKENS) {
      const overlap = intersect / Math.min(aTokens.size, bTokens.size)
      if (overlap >= CROSS_SOURCE_FUZZY_OVERLAP) return true
    }
  }
  return false
}

function pruneRecentSystem(noteId: string, nowMs: number): RecentSysEntry[] {
  const arr = (recentSystemByNote.get(noteId) ?? []).filter(
    (e) => nowMs - e.tsMs <= CROSS_SOURCE_RETENTION_MS
  )
  recentSystemByNote.set(noteId, arr)
  return arr
}

function isMicBleed(noteId: string, entry: TranscriptEntry): boolean {
  const norm = normalizeForDedup(entry.text)
  if (norm.length < CROSS_SOURCE_MIN_LEN) return false
  const tokens = tokenize(norm)
  const entryMs = Date.parse(entry.timestamp)
  const recent = pruneRecentSystem(noteId, Date.now())
  return recent.some(
    (r) =>
      Math.abs(r.tsMs - entryMs) <= CROSS_SOURCE_AUDIO_DELTA_MS &&
      fuzzyDedupMatch(norm, tokens, r.norm, r.tokens)
  )
}

function recordSystemEmission(noteId: string, entry: TranscriptEntry): void {
  const norm = normalizeForDedup(entry.text)
  if (norm.length < CROSS_SOURCE_MIN_LEN) return
  const arr = pruneRecentSystem(noteId, Date.now())
  arr.push({ norm, tokens: tokenize(norm), tsMs: Date.parse(entry.timestamp) })
}

function fireTranscript(noteId: string, entries: TranscriptEntry[]): void {
  if (entries.length === 0) return
  const source: WhisperSource = entries[0].speaker === 'You' ? 'mic' : 'system'

  if (source === 'mic') {
    const toPersist: TranscriptEntry[] = []
    for (const entry of entries) {
      if (isMicBleed(noteId, entry)) {
        log.local(`drop[bleed forward]: ${entry.text}`)
        continue
      }
      toPersist.push(entry)
    }
    if (toPersist.length === 0) return
    void scheduleOperation((data) => {
      const meeting = data.pastMeetings.find((m) => m.id === noteId)
      if (!meeting) return null
      if (!meeting.transcript) meeting.transcript = []
      meeting.transcript.push(...toPersist)
      sendToRenderer('transcript-updated', noteId)
      return data
    })
    for (const entry of toPersist) {
      log.local(`Transcript [${entry.speaker}]: ${entry.text}`)
      queueTranslation(noteId, entry)
    }
    return
  }

  // System path: record for forward dedup, then both push the new system
  // entries AND retroactively remove recent mic entries that fuzzy-match
  // any of them (backward dedup for the mic-first race).
  const sysMeta = entries.map((entry) => {
    recordSystemEmission(noteId, entry)
    const norm = normalizeForDedup(entry.text)
    return { entry, norm, tokens: tokenize(norm), tsMs: Date.parse(entry.timestamp) }
  })

  void scheduleOperation((data) => {
    const meeting = data.pastMeetings.find((m) => m.id === noteId)
    if (!meeting) return null
    if (!meeting.transcript) meeting.transcript = []
    let removed = 0
    meeting.transcript = meeting.transcript.filter((t) => {
      if (t.speaker !== 'You') return true
      const tNorm = normalizeForDedup(t.text)
      if (tNorm.length < CROSS_SOURCE_MIN_LEN) return true
      const tMs = Date.parse(t.timestamp)
      const tTokens = tokenize(tNorm)
      for (const sys of sysMeta) {
        if (Math.abs(sys.tsMs - tMs) > CROSS_SOURCE_AUDIO_DELTA_MS) continue
        if (fuzzyDedupMatch(tNorm, tTokens, sys.norm, sys.tokens)) {
          removed++
          return false
        }
      }
      return true
    })
    meeting.transcript.push(...entries)
    sendToRenderer('transcript-updated', noteId)
    if (removed > 0) {
      log.local(`drop[bleed backward]: removed ${removed} mic entries on system arrival`)
    }
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
  let silentRmsWarned = false
  let silenceTimer: NodeJS.Timeout | null = null
  // RMS amplitude tracking. The Swift helper reports the per-second mean
  // RMS; we keep a small ring of the last few seconds so the diagnostic
  // doesn't trip on a single quiet beat.
  const rmsHistory: number[] = []
  const RMS_HISTORY_LEN = 8
  // Voice is loud — even quiet conversational speech sits well above 0.005
  // normalized RMS, while a "silent but live" mic (route wrong, muted,
  // AirPods-output-only) reports near-zero (1e-5 to 1e-4).
  const RMS_VOICE_FLOOR = 0.005

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
          // RMS check: detects "samples flowing but silent" — the AirPods
          // route bug where the mic node hands us frames of near-zero
          // amplitude. Wait for RMS_HISTORY_LEN seconds of history before
          // judging so we don't trip on natural pauses, then warn once.
          if (typeof evt.rms === 'number') {
            rmsHistory.push(evt.rms)
            if (rmsHistory.length > RMS_HISTORY_LEN) rmsHistory.shift()
            if (
              !silentRmsWarned &&
              firstSamplesLogged &&
              rmsHistory.length === RMS_HISTORY_LEN &&
              rmsHistory.every((v) => v < RMS_VOICE_FLOOR)
            ) {
              silentRmsWarned = true
              if (source === 'mic') {
                const rms = rmsHistory[rmsHistory.length - 1]
                if (rms === 0) {
                  log.warn(
                    'audio',
                    'mic samples are flowing but EXACTLY zero — the input device is producing silence (samples × any gain = silence). Most common cause: AirPods or other Bluetooth headset is the system default input but is in A2DP mode (no mic). The helper now binds to the built-in mic by default; if you still see this, check System Settings → Sound → Input and switch to "MacBook Microphone" (or your built-in mic), or unset MEEPCALL_USE_DEFAULT_INPUT.'
                  )
                } else {
                  log.warn(
                    'audio',
                    `mic samples are flowing but RMS is ${rms.toFixed(5)} — well below the ${RMS_VOICE_FLOOR} voice floor. Possible causes: input level too low (System Settings → Sound → Input → raise the slider), wrong input device selected, or mic muted. Try MEEPCALL_MIC_GAIN=4 (software gain) or MEEPCALL_VOICE_PROCESSING=1 (AGC).`
                  )
                }
              } else {
                log.warn(
                  'audio',
                  `system audio RMS is ${rmsHistory[rmsHistory.length - 1].toFixed(5)} (voice floor ${RMS_VOICE_FLOOR}) — apps may be silent or muted, or system output is routed to a non-captured device.`
                )
              }
            }
          }
        } else if (evt.event === 'route_change' || evt.event === 'route_recovered') {
          log.local(`audio-helper(${source}): ${evt.event}`)
        } else if (evt.event === 'voice_processing') {
          if (evt.enabled) {
            log.local(`audio-helper(${source}): voice_processing on (AGC + NS + AEC)`)
          } else {
            log.warn(
              'audio',
              `voice_processing failed: ${evt.error ?? 'unknown'} — proceeding with raw mic`
            )
          }
        } else if (evt.event === 'mic_gain') {
          log.local(`audio-helper(${source}): software gain ×${evt.gain}`)
        } else if (evt.event === 'input_device') {
          if (evt.type === 'built_in') {
            log.local(`audio-helper(${source}): input bound to built-in mic (${evt.name})`)
          } else {
            log.local(
              `audio-helper(${source}): input using system default (${evt.reason ?? 'unknown'})`
            )
          }
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

  // Fixed window: emit one chunk per CHUNK_BYTES of accumulated audio,
  // then keep going until we drain. No overlap, no tail, no first-vs-rest
  // distinction. The chunk's audio-time start is just `idx * CHUNK_MS`.
  while (ss.pendingBytes >= CHUNK_BYTES) {
    const flat = Buffer.concat(ss.pending, ss.pendingBytes)
    const chunkBuf = Buffer.from(flat.subarray(0, CHUNK_BYTES))
    const remainder = flat.subarray(CHUNK_BYTES)
    ss.pending = remainder.length > 0 ? [remainder] : []
    ss.pendingBytes = remainder.length

    const idx = ss.chunkIndex++
    const chunkStartMs = idx * CHUNK_MS
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
  chunkStartMs: number,
  force = false
): Promise<void> {
  const ss = source === 'mic' ? handle.mic : handle.system
  // Backpressure: if whisper is too far behind, drop this chunk instead of
  // letting the queue grow unbounded. `force` is set by the final-drain
  // path (after SIGTERM) where the chunk is the LAST one for this source
  // and must not be dropped.
  if (!force && ss && ss.inFlight >= MAX_INFLIGHT_CHUNKS) {
    ss.droppedChunks++
    const recent = ss.recentInferMs.length > 0
      ? ` (recent inference: ${ss.recentInferMs.map((m) => `${(m / 1000).toFixed(1)}s`).join(' ')})`
      : ''
    log.warn(
      'audio',
      `${source}: queue depth ${ss.inFlight} ≥ ${MAX_INFLIGHT_CHUNKS}, dropping chunk #${chunkIndex}${recent}`
    )
    return
  }

  // Pre-whisper silence gate. Whisper-cli on a silent chunk wastes ~1.5–2 s
  // of CPU AND tends to hallucinate ghost lines (Okay. / Thanks for
  // watching. / [Music]). Skipping silent chunks here recovers both the
  // CPU and the transcript hygiene.
  if (SILENCE_RMS_SKIP > 0) {
    const rms = rmsOfPcm(pcm)
    if (rms < SILENCE_RMS_SKIP) {
      if (process.env.MEEPCALL_DEBUG_WHISPER === '1') {
        log.local(
          `${source}: chunk #${chunkIndex} silent (rms=${rms.toFixed(5)} < ${SILENCE_RMS_SKIP}), skipping whisper`
        )
      }
      return
    }
  }

  if (ss) ss.inFlight++
  const t0 = Date.now()
  try {
    const wavPath = join(
      tmpdir(),
      `meepcall-${handle.recordingId}-${source}-chunk-${chunkIndex}.wav`
    )
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
  } finally {
    if (ss) {
      ss.inFlight--
      const took = Date.now() - t0
      ss.recentInferMs.push(took)
      if (ss.recentInferMs.length > RECENT_INFER_LEN) ss.recentInferMs.shift()
    }
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

  const chunkBuf = Buffer.concat(ss.pending, ss.pendingBytes)
  ss.pending = []
  ss.pendingBytes = 0

  const idx = ss.chunkIndex++
  const chunkStartMs = vad ? ss.chunkStartMs : idx * CHUNK_MS
  if (vad) ss.chunkStartMs += chunkBuf.length / 32
  // Await this final chunk so the transcript is complete before the summary
  // runs. Force=true bypasses backpressure — we never want to drop the
  // residual chunk just because earlier chunks are still in flight.
  await flushChunk(source, handle, chunkBuf, idx, chunkStartMs, true)
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
    vad: null,
    vadQueue: Promise.resolve(),
    silenceMs: 0,
    chunkStartMs: 0,
    closed,
    inFlight: 0,
    droppedChunks: 0,
    recentInferMs: []
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
  if (ss.droppedChunks > 0) {
    log.warn(
      'audio',
      `${source}: ${ss.droppedChunks} chunks dropped due to whisper backpressure during this recording (raise MEEPCALL_MAX_INFLIGHT_CHUNKS, reduce MEEPCALL_WHISPER_THREADS contention, or use a smaller WHISPER_MODEL)`
    )
  }
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
    recentSystemByNote.delete(handle.noteId)
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
