import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptEntry } from '@shared/types'
import { resolveBinPath, resolveModelPath } from './assets'
import { log } from './log'

export type WhisperSource = 'mic' | 'system'

export interface WhisperSession {
  transcribeChunk(
    wavPath: string,
    chunkIndex: number,
    source: WhisperSource,
    chunkStartMs: number
  ): Promise<TranscriptEntry[]>
  flush(): Promise<void>
  destroy(): void
}

// Default to the multilingual `medium` model (~1.5 GB). Override via env var:
//   WHISPER_MODEL=ggml-small.bin   (multilingual, smaller/faster, more hallucinations)
//   WHISPER_MODEL=ggml-base.en.bin (English-only, smallest, fastest)
//   WHISPER_MODEL=ggml-large-v3.bin (multilingual, ~3 GB, best quality, slowest)
const MODEL_NAME = process.env.WHISPER_MODEL?.trim() || 'ggml-medium.bin'
// `auto` lets whisper detect the language per chunk. Override via env var:
//   WHISPER_LANGUAGE=en (force English, skip auto-detect)
//   WHISPER_LANGUAGE=es / zh / ja / ko / fr / etc. (force specific)
const LANGUAGE = process.env.WHISPER_LANGUAGE?.trim() || 'auto'
// No-speech threshold. Whisper marks segments below this confidence as
// silence and drops them before they reach our JSON output. Default 0.6 is
// tuned for spoken speech; lower (0.3-0.4) when transcribing music since
// singing has different acoustic features than speech. Higher (0.7-0.8)
// suppresses more hallucinations on quiet/noisy audio.
const NO_SPEECH_THOLD = process.env.MEEPCALL_NO_SPEECH_THOLD?.trim() || '0.6'
// Whisper hallucinations on silence / noise: bracketed annotations
// ([BLANK_AUDIO], [Music]), parenthesized stage directions ((music),
// (speaking in foreign language)), and a few classic ghost lines.
const HALLUCINATION_RE =
  /^\s*(thank you[.!]?|thanks for watching[.!]?|you|\[.*\]|\(.*\))\s*$/i

// Decoder repetition loop: one character repeated 10+ times in a row.
// Catches වවවවවවවවවව (and the much longer real loops we saw in the wild),
// "eeeeeeeeeeeee", "..............". Songs use sustained vowels like
// "yeahhhhhhh" (~7 chars) — keep the threshold above that.
const CHAR_LOOP_RE = /(.)\1{9,}/

// Decoder token-loop: a short token (1–4 chars) repeated 6+ times separated
// by whitespace. Catches "ʔ ʔ ʔ ʔ ʔ ʔ", "the the the the the the". Songs
// commonly do "no no no no" (4×) and "yeah yeah yeah yeah" (4×) — keep the
// threshold above those legitimate chorus patterns.
const TOKEN_LOOP_RE = /(\S{1,4})(\s+\1){5,}/

// Verbose mode: log every segment whisper produces and what (if anything)
// filters it. MEEPCALL_DEBUG_WHISPER=1 to enable. Useful for "where did my
// lyrics go?" debugging.
function debugEnabled(): boolean {
  return process.env.MEEPCALL_DEBUG_WHISPER === '1'
}

// Bypass all post-whisper text filters (hallucination + dedup). Overlap-skip
// still runs since it's correctness, not a heuristic. MEEPCALL_WHISPER_NO_FILTERS=1.
function filtersDisabled(): boolean {
  return process.env.MEEPCALL_WHISPER_NO_FILTERS === '1'
}

function isHallucination(text: string): boolean {
  if (HALLUCINATION_RE.test(text)) return true
  if (CHAR_LOOP_RE.test(text)) return true
  if (TOKEN_LOOP_RE.test(text)) return true
  return false
}

interface WhisperJSON {
  transcription?: Array<{
    text?: string
    offsets?: { from?: number; to?: number }
  }>
}

interface SegmentInternal {
  text: string
  offsetMs: number
}

async function runWhisperCli(wavPath: string, jsonPath: string): Promise<SegmentInternal[]> {
  const bin = resolveBinPath('whisper-cli')
  const model = resolveModelPath(MODEL_NAME)

  return new Promise((resolve, reject) => {
    const args = [
      '-m',
      model,
      '-f',
      wavPath,
      '-oj',
      '-of',
      jsonPath,
      '--no-prints',
      '--no-speech-thold',
      NO_SPEECH_THOLD,
      '--language',
      LANGUAGE,
      '--threads',
      '4'
    ]
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    proc.on('error', reject)
    proc.on('close', async (code) => {
      if (code !== 0) {
        log.warn('audio', `whisper-cli exited ${code}: ${stderr.slice(0, 400)}`)
        resolve([])
        return
      }
      try {
        const fullPath = jsonPath.endsWith('.json') ? jsonPath : `${jsonPath}.json`
        const raw = await fsp.readFile(fullPath, 'utf8')
        const parsed = JSON.parse(raw) as WhisperJSON
        const out: SegmentInternal[] = []
        for (const seg of parsed.transcription ?? []) {
          const text = (seg.text ?? '').trim()
          if (!text) continue
          out.push({ text, offsetMs: seg.offsets?.from ?? 0 })
        }
        resolve(out)
      } catch (err) {
        log.warn('audio', `whisper-cli json parse failed: ${(err as Error).message}`)
        resolve([])
      }
    })
  })
}

// How long an emitted segment stays in the dedup ring buffer (audio-time ms).
// Long enough to cover the overlap region (1s here, but allow slack for
// whisper's offset jitter); short enough that a repeated chorus line 8 s
// later is NOT considered a duplicate.
const DEDUP_WINDOW_MS = 3000

export function createWhisperSession(recordingId: string, startedAt: number): WhisperSession {
  // Per-source serial queue: chunk N for a source awaits chunk N-1 for that source.
  const queues: Record<WhisperSource, Promise<unknown>> = {
    mic: Promise.resolve(),
    system: Promise.resolve()
  }
  // Recent emissions per source for overlap dedup. Keyed by absolute audio
  // time (ms since recording started).
  const recent: Record<WhisperSource, { text: string; absMs: number }[]> = {
    mic: [],
    system: []
  }
  let destroyed = false

  async function transcribeChunk(
    wavPath: string,
    chunkIndex: number,
    source: WhisperSource,
    chunkStartMs: number
  ): Promise<TranscriptEntry[]> {
    if (destroyed) return []
    const speaker = source === 'mic' ? 'You' : 'Other'
    const jsonBase = join(tmpdir(), `meepcall-${recordingId}-${source}-chunk-${chunkIndex}`)
    const segs = await runWhisperCli(wavPath, jsonBase)

    // Cleanup temp files.
    void fsp.unlink(`${jsonBase}.json`).catch(() => {})
    void fsp.unlink(wavPath).catch(() => {})

    const verbose = debugEnabled()
    const noFilters = filtersDisabled()
    if (verbose) {
      log.local(
        `whisper(${source} #${chunkIndex}): ${segs.length} raw segments, noFilters=${noFilters}`
      )
    }

    // GC entries older than the dedup window relative to this chunk.
    const chunkEndMs = chunkStartMs + 3000
    recent[source] = recent[source].filter((e) => chunkEndMs - e.absMs < DEDUP_WINDOW_MS)

    const entries: TranscriptEntry[] = []
    for (const seg of segs) {
      const segAbsMs = chunkStartMs + seg.offsetMs

      if (!noFilters && isHallucination(seg.text)) {
        if (verbose) log.local(`  drop[hallucination]: ${seg.text}`)
        continue
      }
      // Dedup against recently-emitted segments with matching text, within
      // the overlap window. This is what catches the duplicate emissions
      // of the same audio across overlapping chunks — superior to skipping
      // by offset because whisper segments often start at offsetMs=0 even
      // when they cover the chunk's middle/end.
      if (!noFilters) {
        const dup = recent[source].find(
          (e) => e.text === seg.text && Math.abs(e.absMs - segAbsMs) < DEDUP_WINDOW_MS
        )
        if (dup) {
          if (verbose)
            log.local(`  drop[dup ${segAbsMs - dup.absMs}ms after prev]: ${seg.text}`)
          continue
        }
      }

      recent[source].push({ text: seg.text, absMs: segAbsMs })
      entries.push({
        text: seg.text,
        speaker,
        timestamp: new Date(startedAt + segAbsMs).toISOString()
      })
    }
    return entries
  }

  return {
    transcribeChunk(wavPath, chunkIndex, source, chunkStartMs) {
      const next = queues[source].then(() =>
        transcribeChunk(wavPath, chunkIndex, source, chunkStartMs)
      )
      // Keep the queue chain alive but don't propagate rejections.
      queues[source] = next.catch(() => undefined)
      return next
    },
    async flush(): Promise<void> {
      await Promise.all([queues.mic, queues.system])
    },
    destroy(): void {
      destroyed = true
    }
  }
}
