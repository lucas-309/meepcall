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
    chunkStartMs: number,
    skipBeforeMs: number
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
// Whisper hallucinations on silence / noise: bracketed annotations
// ([BLANK_AUDIO], [Music]), parenthesized stage directions ((music),
// (speaking in foreign language)), and a few classic ghost lines.
const HALLUCINATION_RE =
  /^\s*(thank you[.!]?|thanks for watching[.!]?|you|\[.*\]|\(.*\))\s*$/i

// Decoder repetition loop: one character repeated 7+ times in a row.
// Catches වවවවවව, "eeeeeee", "..............", etc.
const CHAR_LOOP_RE = /(.)\1{6,}/

// Decoder token-loop: a short token (1–4 chars) repeated 4+ times separated
// by whitespace. Catches "ʔ ʔ ʔ ʔ", "the the the the the".
const TOKEN_LOOP_RE = /(\S{1,4})(\s+\1){3,}/

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
      '0.6',
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

export function createWhisperSession(recordingId: string, startedAt: number): WhisperSession {
  // Per-source serial queue: chunk N for a source awaits chunk N-1 for that source.
  const queues: Record<WhisperSource, Promise<unknown>> = {
    mic: Promise.resolve(),
    system: Promise.resolve()
  }
  const lastEntry: Record<WhisperSource, string> = { mic: '', system: '' }
  let destroyed = false

  async function transcribeChunk(
    wavPath: string,
    chunkIndex: number,
    source: WhisperSource,
    chunkStartMs: number,
    skipBeforeMs: number
  ): Promise<TranscriptEntry[]> {
    if (destroyed) return []
    const speaker = source === 'mic' ? 'You' : 'Other'
    const jsonBase = join(tmpdir(), `meepcall-${recordingId}-${source}-chunk-${chunkIndex}`)
    const segs = await runWhisperCli(wavPath, jsonBase)

    // Cleanup temp files.
    void fsp.unlink(`${jsonBase}.json`).catch(() => {})
    void fsp.unlink(wavPath).catch(() => {})

    const entries: TranscriptEntry[] = []
    for (const seg of segs) {
      // Skip the overlap region — those audio frames were already covered by
      // the previous chunk and any segments inside them are duplicates.
      if (seg.offsetMs < skipBeforeMs) continue
      if (isHallucination(seg.text)) continue
      if (seg.text === lastEntry[source]) continue
      lastEntry[source] = seg.text
      entries.push({
        text: seg.text,
        speaker,
        timestamp: new Date(startedAt + chunkStartMs + seg.offsetMs).toISOString()
      })
    }
    return entries
  }

  return {
    transcribeChunk(wavPath, chunkIndex, source, chunkStartMs, skipBeforeMs) {
      const next = queues[source].then(() =>
        transcribeChunk(wavPath, chunkIndex, source, chunkStartMs, skipBeforeMs)
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
