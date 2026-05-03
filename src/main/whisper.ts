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

// Default to `large-v3-turbo` (~1.6 GB) — distilled from large-v3, ~99% of
// SOTA quality at medium-model speed. Per-chunk inference fits inside the
// 2-second pipeline step on M1+, so live transcripts stay in real time.
//   WHISPER_MODEL=ggml-large-v3.bin     (true SOTA, ~3 GB, M3 Max+ only)
//   WHISPER_MODEL=ggml-medium.bin       (smaller/older, more hallucinations)
//   WHISPER_MODEL=ggml-small.bin        (multilingual, smaller/faster)
//   WHISPER_MODEL=ggml-base.en.bin      (English-only, smallest, fastest)
const MODEL_NAME = process.env.WHISPER_MODEL?.trim() || 'ggml-large-v3-turbo.bin'
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

// Allowed-language filter. whisper auto-detect occasionally flips to the
// wrong language on a noisy chunk (Mandarin → Japanese, English → German),
// producing nonsense. Default `en,zh` matches the common bilingual case.
// Set MEEPCALL_WHISPER_LANGS=auto (or empty) to accept any language. List
// is comma-separated ISO codes: en,zh,ja,ko,es,fr,de,ru,ar,hi,pt,it,vi,th
// (anything whisper supports).
const ALLOWED_LANGS: Set<string> | null = (() => {
  const raw = (process.env.MEEPCALL_WHISPER_LANGS ?? 'en,zh').trim().toLowerCase()
  if (raw === 'auto' || raw === '') return null
  const set = new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  )
  return set.size > 0 ? set : null
})()

// How much of the recent transcript to feed back to whisper as `--prompt`.
// whisper.cpp's prompt context is ~224 tokens; ~200 chars covers ~50 Chinese
// chars or ~30 English words — enough for language-continuity + name/term
// continuity without crowding the decoder. Held per-source in the session.
const PROMPT_CHARS_MAX = 200
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
  result?: { language?: string }
  transcription?: Array<{
    text?: string
    offsets?: { from?: number; to?: number }
  }>
}

interface SegmentInternal {
  text: string
  offsetMs: number
}

type WhisperRunResult =
  | { ok: true; segs: SegmentInternal[]; detectedLang: string }
  | { ok: false; reason: string }

async function runWhisperCliOnce(
  wavPath: string,
  jsonPath: string,
  prompt: string
): Promise<WhisperRunResult> {
  const bin = resolveBinPath('whisper-cli')
  const model = resolveModelPath(MODEL_NAME)

  return new Promise((resolve) => {
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
    // `--prompt` biases the decoder toward content + language similar to
    // the prompt without forcing it. Empty prompt = no bias (first chunk).
    if (prompt) {
      args.push('--prompt', prompt)
    }
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    proc.on('error', (err) => resolve({ ok: false, reason: `spawn: ${err.message}` }))
    proc.on('close', async (code) => {
      if (code !== 0) {
        resolve({ ok: false, reason: `exit ${code}: ${stderr.slice(0, 400)}` })
        return
      }
      try {
        const fullPath = jsonPath.endsWith('.json') ? jsonPath : `${jsonPath}.json`
        const raw = await fsp.readFile(fullPath, 'utf8')
        const parsed = JSON.parse(raw) as WhisperJSON
        // Language filter: drop the chunk if whisper's auto-detected
        // language isn't in the allow list. Better to lose a beat than
        // emit garbled cross-language transliteration. Skip the filter
        // when LANGUAGE is pinned (user already constrained whisper).
        const detected = (parsed.result?.language ?? '').toLowerCase()
        if (
          ALLOWED_LANGS &&
          LANGUAGE === 'auto' &&
          detected &&
          !ALLOWED_LANGS.has(detected)
        ) {
          if (debugEnabled()) {
            log.local(`whisper: dropping chunk, detected lang=${detected} not in allow list`)
          }
          resolve({ ok: true, segs: [], detectedLang: detected })
          return
        }
        const out: SegmentInternal[] = []
        for (const seg of parsed.transcription ?? []) {
          const text = (seg.text ?? '').trim()
          if (!text) continue
          out.push({ text, offsetMs: seg.offsets?.from ?? 0 })
        }
        resolve({ ok: true, segs: out, detectedLang: detected })
      } catch (err) {
        resolve({ ok: false, reason: `parse: ${(err as Error).message}` })
      }
    })
  })
}

// One retry budget. whisper-cli crashes (non-zero exit, spawn error, malformed
// JSON) are usually transient — a second pass on the same WAV is cheap and
// salvages the chunk. After 2 attempts, give up and return [] so the pipeline
// keeps moving.
async function runWhisperCli(
  wavPath: string,
  jsonPath: string,
  prompt: string
): Promise<{ segs: SegmentInternal[]; detectedLang: string }> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await runWhisperCliOnce(wavPath, jsonPath, prompt)
    if (r.ok) return { segs: r.segs, detectedLang: r.detectedLang }
    const tag = attempt < 2 ? 'retrying' : 'gave up'
    log.warn('audio', `whisper-cli ${tag} (${attempt}/2): ${r.reason}`)
  }
  return { segs: [], detectedLang: '' }
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
  // Per-source language continuity. People rarely flip languages chunk-by-
  // chunk — when whisper auto-detects a one-off outlier (Portuguese inside
  // a Chinese stream, English hallucinated on top of Mandarin music), it's
  // almost always wrong. Hysteresis: lock onto the first detected language;
  // accept a switch only after seeing the new language twice in a row.
  // Established stream + single outlier → drop the chunk silently.
  interface LangState {
    current: string | null
    pendingLang: string | null
    pendingCount: number
  }
  const langState: Record<WhisperSource, LangState> = {
    mic: { current: null, pendingLang: null, pendingCount: 0 },
    system: { current: null, pendingLang: null, pendingCount: 0 }
  }
  function checkContinuity(source: WhisperSource, detected: string): boolean {
    if (!detected) return true
    const s = langState[source]
    if (s.current === null) {
      s.current = detected
      return true
    }
    if (detected === s.current) {
      s.pendingLang = null
      s.pendingCount = 0
      return true
    }
    if (s.pendingLang === detected) {
      s.pendingCount++
    } else {
      s.pendingLang = detected
      s.pendingCount = 1
    }
    if (s.pendingCount >= 2) {
      s.current = detected
      s.pendingLang = null
      s.pendingCount = 0
      return true
    }
    if (debugEnabled()) {
      log.local(
        `whisper(${source}): outlier lang=${detected} (current=${s.current}), drop chunk`
      )
    }
    return false
  }
  let destroyed = false

  // Build a continuity prompt from recent emissions for this source. Joining
  // the most recent texts back-to-front and trimming to PROMPT_CHARS_MAX keeps
  // the freshest context closest to the new chunk. Same source only — mic and
  // system are independent speakers, mixing prompts would confuse whisper.
  function buildPrompt(source: WhisperSource): string {
    const arr = recent[source]
    if (arr.length === 0) return ''
    let acc = ''
    for (let i = arr.length - 1; i >= 0; i--) {
      const next = arr[i].text + (acc ? ' ' + acc : '')
      if (next.length > PROMPT_CHARS_MAX) break
      acc = next
    }
    return acc
  }

  async function transcribeChunk(
    wavPath: string,
    chunkIndex: number,
    source: WhisperSource,
    chunkStartMs: number
  ): Promise<TranscriptEntry[]> {
    if (destroyed) return []
    const speaker = source === 'mic' ? 'You' : 'Other'
    const jsonBase = join(tmpdir(), `meepcall-${recordingId}-${source}-chunk-${chunkIndex}`)
    const prompt = buildPrompt(source)
    const { segs, detectedLang } = await runWhisperCli(wavPath, jsonBase, prompt)

    // Cleanup temp files.
    void fsp.unlink(`${jsonBase}.json`).catch(() => {})
    void fsp.unlink(wavPath).catch(() => {})

    // Continuity filter — only when in auto mode and we got actual segments.
    // Empty chunks tell us nothing about the stream's language so we don't
    // let them advance/disturb the lang state.
    if (LANGUAGE === 'auto' && segs.length > 0 && !checkContinuity(source, detectedLang)) {
      return []
    }

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
