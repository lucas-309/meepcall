import { promises as fsp } from 'node:fs'
import type { TranscriptEntry } from '@shared/types'
import { log } from './log'
import { startWhisperServer, whisperServerUrl } from './whisper-server'

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

// How long an emitted segment stays in the prompt-context ring buffer
// (audio-time ms). Long enough that a song with multi-second instrumental
// gaps still has prior Chinese vocals to bias the next decode; short
// enough that the buffer doesn't grow unbounded across a long recording.
const PROMPT_RETENTION_MS = 30000

// Whisper-cli thread count. M-series perf cores are abundant; 6 keeps
// per-chunk inference comfortably under the 2 s chunk step on M3 Pro+
// even with two parallel sources (mic + system) competing for cores.
// Bump higher only if you're on an M3 Max / M4 Max with a lot of perf
// cores idle.
const WHISPER_THREADS = process.env.MEEPCALL_WHISPER_THREADS?.trim() || '6'

// Decoder confidence thresholds — whisper-cli's own per-segment quality
// gates. Higher (less negative) `--logprob-thold` requires more confident
// tokens; higher `--entropy-thold` is more permissive on uncertain
// distributions. Defaults below match whisper.cpp's built-in defaults so
// behavior is unchanged unless the user opts in. For instrumental-music
// or noisy-environment recordings, raising no-speech-thold (e.g. 0.85)
// and tightening logprob-thold (e.g. -0.5) makes whisper itself drop more
// "this might not be speech" segments BEFORE we ever see them — which
// avoids the per-segment regex / streak filter having to chase varied
// ghost text.
const LOGPROB_THOLD = process.env.MEEPCALL_LOGPROB_THOLD?.trim()
const ENTROPY_THOLD = process.env.MEEPCALL_ENTROPY_THOLD?.trim()
// `--no-fallback` disables whisper.cpp's temperature-fallback retry. By
// default, whisper retries failed decodes with increasing temperature,
// which on hard chunks (music, low SNR) often produces the worst
// hallucinations — random samples from a hot distribution. Disabling
// makes whisper give up cleanly on those chunks rather than emit garbage.
const NO_FALLBACK = process.env.MEEPCALL_NO_FALLBACK === '1'
// Whisper hallucinations on silence / noise: bracketed annotations
// ([BLANK_AUDIO], [Music]), parenthesized stage directions ((music),
// (speaking in foreign language)), asterisk-bracketed markdown-style
// annotations (*music*, *applause*), and a few classic ghost lines.
const HALLUCINATION_RE =
  /^\s*(thank you[.!]?|thanks for watching[.!]?|you|\[.*\]|\(.*\)|\*[^*]*\*)\s*$/i

// Pure-symbol emissions: trimmed text with no letter/digit content. Whisper
// produces these on noise / music / silence — `¶¶`, `.`, `....`, `***`,
// `--`, etc. Real transcripts always contain at least one alphanumeric
// character (even single-letter words like "I" or "a" pass). Cheap to
// check, no false positives in practice.
const HAS_ALNUM_RE = /[\p{L}\p{N}]/u

// Known whisper.cpp training-data leaks. The OpenAI-released weights were
// trained on a large YouTube + closed-captions corpus, and certain
// recurring strings (channel IDs, subscribe-callouts, subtitle credits,
// streaming-platform intros) leaked into the model's prior. Whisper emits
// them deterministically on silence, music, or non-speech audio — they
// pass every structural filter because they're real grammatical phrases.
// Containment check (not whole-string match) because whisper sometimes
// concatenates them with real adjacent fragments. All comparisons are
// case-insensitive against a lowercased copy of the segment text.
const KNOWN_HALLUCINATION_PHRASES = [
  // Chinese streaming/TV show intros — common in zh auto-detect
  '优优独播剧场',
  'yoyo television series',
  '优酷视频',
  '腾讯视频',
  '爱奇艺',
  // Subtitle credits in CJK + English
  '字幕由',
  '字幕志愿者',
  '字幕组',
  '中文字幕',
  '字幕提供',
  'amara.org',
  'subtitled by',
  'subtitles by',
  'captions by',
  // YouTube CTAs that leaked from auto-captioned videos
  "don't forget to subscribe",
  'do not forget to subscribe',
  'subscribe to my channel',
  'subscribe to our channel',
  'subscribe to the channel',
  'subscribe for more',
  'please subscribe',
  'like and subscribe',
  'hit the bell',
  'ring the bell',
  'click the bell',
  'see you in the next video',
  'see you next time',
  'see you next video',
  'see you in my next video',
  // Music / instrumental hallucinations the model invents
  'zither harp',
  // Generic outros
  'thanks for watching',
  'thank you for watching'
] as const

function containsKnownHallucination(text: string): boolean {
  const lower = text.toLowerCase()
  for (const phrase of KNOWN_HALLUCINATION_PHRASES) {
    if (lower.includes(phrase)) return true
  }
  return false
}

// Decoder repetition loop: one character repeated 10+ times in a row.
// Catches වවවවවවවවවව (and the much longer real loops we saw in the wild),
// "eeeeeeeeeeeee", "..............". Songs use sustained vowels like
// "yeahhhhhhh" (~7 chars) — keep the threshold above that.
const CHAR_LOOP_RE = /(.)\1{9,}/

// Symbol-only repetition: a non-letter/non-digit/non-whitespace character
// repeated 5+ times. Real language never does this (the longest natural
// run is "...." for emphatic ellipsis at 4). Whisper hallucinates symbol
// soup on noise: ¶¶¶¶¶, •••••, █████, ▮▮▮▮▮. Threshold tighter than
// CHAR_LOOP_RE because there's no song-lyric carve-out to worry about.
const SYMBOL_LOOP_RE = /([^\p{L}\p{N}\s])\1{4,}/u

// Decoder token-loop: a short token (1–4 chars) repeated 6+ times separated
// by whitespace. Catches "ʔ ʔ ʔ ʔ ʔ ʔ", "the the the the the the". Songs
// commonly do "no no no no" (4×) and "yeah yeah yeah yeah" (4×) — keep the
// threshold above those legitimate chorus patterns.
const TOKEN_LOOP_RE = /(\S{1,4})(\s+\1){5,}/

// Repeated phrase + terminal punctuation: same word(s) followed by
// `.`/`!`/`?`, repeated 3+ times in a single segment. Whisper does this
// on instrumental music, sustained noise, and ambient audio — "Music.
// Music. Music.", "Thank you. Thank you. Thank you.", "Hello. Hello.
// Hello.". Distinct from TOKEN_LOOP_RE (caps token at 4 chars, needs 6+
// reps) — words like "Music" are 5 chars and these loops fire at 3 reps.
// Phrase capture allows multi-word units like "Thank you" to repeat.
// Threshold of 3 keeps 2-rep emphasis ("Yes. Yes.") emitting; the cross-
// chunk streak filter handles those if they keep recurring.
const WORD_REPEAT_RE = /\b(\p{L}+(?:\s+\p{L}+){0,4})([.!?]+)\s+\1\2(?:\s+\1\2)+/u

// Cross-chunk streak filter for short ghost utterances. When a chunk is
// nearly silent, has background noise, or has music underneath, whisper
// often emits the same short conversational filler over and over —
// "Okay.", "Yeah.", "Hmm.", "Mm-hmm.", "Right." — once per chunk for
// many seconds. Per-chunk hallucination regex can't catch these because
// in isolation they're real words a person might say. Cross-chunk we
// can: if the same short utterance fires N consecutive times for a
// source, the rest are almost certainly noise. Allow STREAK_LIMIT
// emissions through (so the user sees the pattern), then suppress until
// a different utterance breaks the streak.
//
// Length cap: only short *normalized keys* are filtered. The streakKey
// collapses repeated prefixes ("Music. Music. Music." → "music"), so a
// long hallucination loop with one short word is still eligible while a
// long unique sentence (key length matches text length) isn't.
// Any non-letter/non-digit char is ignored when comparing, so "Okay."
// and "Okay" and " okay! " all match.
const STREAK_MAX_LEN = 30
// How many consecutive identical short emissions to allow before
// suppressing. Default 2 ("show twice, then drop") keeps the spam
// pattern visible while stopping the runaway. Set
// MEEPCALL_STREAK_LIMIT=1 for noisy environments (drop on first
// repeat) or 0 to disable the streak filter entirely.
const STREAK_LIMIT = (() => {
  const raw = process.env.MEEPCALL_STREAK_LIMIT
  if (raw === undefined || raw === '') return 2
  const v = Number(raw)
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 2
})()

function streakKey(text: string): string {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  // Collapse internal repetition so cross-chunk variants of the same
  // hallucination loop ("Music.", "Music. Music.", "Music. Music. Music.")
  // share one streak counter. Find the smallest prefix that, repeated,
  // equals the whole normalized string. No collapse if the text isn't a
  // pure repetition of one prefix.
  for (let len = 1; len * 2 <= normalized.length; len++) {
    if (normalized.length % len !== 0) continue
    const prefix = normalized.slice(0, len)
    if (prefix.repeat(normalized.length / len) === normalized) {
      return prefix
    }
  }
  return normalized
}

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
  if (!HAS_ALNUM_RE.test(text)) return true
  if (HALLUCINATION_RE.test(text)) return true
  if (CHAR_LOOP_RE.test(text)) return true
  if (SYMBOL_LOOP_RE.test(text)) return true
  if (TOKEN_LOOP_RE.test(text)) return true
  if (WORD_REPEAT_RE.test(text)) return true
  if (containsKnownHallucination(text)) return true
  return false
}

// Shape of whisper-server's verbose_json response.
//   { task, language, duration, text, segments: [{ id, start, end, text, ... }] }
// `start` and `end` are floats in SECONDS (vs whisper-cli which used ms in
// `offsets.from`). We convert to ms when populating SegmentInternal.
interface WhisperServerJSON {
  language?: string
  segments?: Array<{
    start?: number
    end?: number
    text?: string
  }>
}

interface SegmentInternal {
  text: string
  offsetMs: number
}

type WhisperRunResult =
  | { ok: true; segs: SegmentInternal[]; detectedLang: string }
  | { ok: false; reason: string }

// Map whisper-server's English-name language strings ("english", "chinese",
// "japanese") to the ISO 639-1 codes ("en", "zh", "ja") that the rest of
// the app expects (the allow-list, NLLB src_lang map, etc).
const LANG_NAME_TO_ISO: Record<string, string> = {
  english: 'en',
  chinese: 'zh',
  japanese: 'ja',
  korean: 'ko',
  spanish: 'es',
  french: 'fr',
  german: 'de',
  russian: 'ru',
  arabic: 'ar',
  hindi: 'hi',
  portuguese: 'pt',
  italian: 'it',
  vietnamese: 'vi',
  thai: 'th',
  turkish: 'tr',
  polish: 'pl',
  dutch: 'nl',
  ukrainian: 'uk',
  hebrew: 'he',
  greek: 'el',
  czech: 'cs',
  swedish: 'sv',
  finnish: 'fi',
  danish: 'da',
  norwegian: 'no',
  indonesian: 'id',
  malay: 'ms',
  persian: 'fa',
  bengali: 'bn',
  tamil: 'ta',
  urdu: 'ur'
}

function normalizeDetectedLanguage(raw: string): string {
  const lower = raw.toLowerCase().trim()
  if (lower.length === 0) return ''
  // Already ISO 2-letter? Pass through.
  if (lower.length <= 3) return lower
  return LANG_NAME_TO_ISO[lower] ?? lower
}

async function runWhisperServerOnce(
  wavPath: string,
  prompt: string,
  source: WhisperSource
): Promise<WhisperRunResult> {
  let server: { port: number }
  try {
    server = await startWhisperServer(MODEL_NAME, source)
  } catch (err) {
    return { ok: false, reason: `server start: ${(err as Error).message}` }
  }

  let wav: Buffer
  try {
    wav = await fsp.readFile(wavPath)
  } catch (err) {
    return { ok: false, reason: `read wav: ${(err as Error).message}` }
  }

  // Build the multipart body. fetch + FormData + Blob are all globals in
  // modern Electron (Node 18+ runtime). The wav blob is a single in-memory
  // copy of the chunk PCM — for our 64 KB chunks that's negligible.
  const fd = new FormData()
  fd.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'chunk.wav')
  fd.append('response_format', 'verbose_json')
  fd.append('temperature', '0')
  fd.append('language', LANGUAGE)
  fd.append('no_speech_thold', NO_SPEECH_THOLD)
  fd.append('threads', WHISPER_THREADS)
  if (LOGPROB_THOLD) fd.append('logprob_thold', LOGPROB_THOLD)
  if (ENTROPY_THOLD) fd.append('entropy_thold', ENTROPY_THOLD)
  if (NO_FALLBACK) fd.append('no_fallback', 'true')
  // `prompt` biases the decoder toward content + language similar to the
  // last few seconds of recognized text. Empty = no bias (first chunk).
  // Two effects: (a) decode is more likely to STAY in the established
  // language across noisy / instrumental chunks, and (b) named entities,
  // jargon, or recurring lyrics are more likely to be transcribed
  // consistently across chunks.
  if (prompt) fd.append('prompt', prompt)

  let json: WhisperServerJSON
  try {
    const resp = await fetch(`${whisperServerUrl(server.port)}/inference`, {
      method: 'POST',
      body: fd
    })
    if (!resp.ok) {
      const body = await resp.text()
      return { ok: false, reason: `http ${resp.status}: ${body.slice(0, 400)}` }
    }
    json = (await resp.json()) as WhisperServerJSON
  } catch (err) {
    return { ok: false, reason: `fetch: ${(err as Error).message}` }
  }

  const detected = normalizeDetectedLanguage(json.language ?? '')
  if (
    ALLOWED_LANGS &&
    LANGUAGE === 'auto' &&
    detected &&
    !ALLOWED_LANGS.has(detected)
  ) {
    if (debugEnabled()) {
      log.local(`whisper: dropping chunk, detected lang=${detected} not in allow list`)
    }
    return { ok: true, segs: [], detectedLang: detected }
  }

  const out: SegmentInternal[] = []
  for (const seg of json.segments ?? []) {
    const text = (seg.text ?? '').trim()
    if (!text) continue
    const offsetMs = Math.round((seg.start ?? 0) * 1000)
    out.push({ text, offsetMs })
  }
  return { ok: true, segs: out, detectedLang: detected }
}

// One retry budget. Server-path failures (transient HTTP errors, server
// momentarily restarting after a crash) are usually recoverable — a
// second attempt on the same WAV is cheap and salvages the chunk. After
// 2 attempts, give up and return [] so the pipeline keeps moving.
async function runWhisper(
  wavPath: string,
  prompt: string,
  source: WhisperSource
): Promise<{ segs: SegmentInternal[]; detectedLang: string }> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await runWhisperServerOnce(wavPath, prompt, source)
    if (r.ok) return { segs: r.segs, detectedLang: r.detectedLang }
    const tag = attempt < 2 ? 'retrying' : 'gave up'
    log.warn('audio', `whisper-server[${source}] ${tag} (${attempt}/2): ${r.reason}`)
  }
  return { segs: [], detectedLang: '' }
}

export function createWhisperSession(_recordingId: string, startedAt: number): WhisperSession {
  // _recordingId is kept in the public signature for callers but no longer
  // used internally — it used to namespace per-chunk JSON sidecar paths
  // for whisper-cli. whisper-server returns results over HTTP, no files.
  //
  // Per-source serial queue: chunk N for a source awaits chunk N-1 for that
  // source. Without this, two whisper-cli processes for the same source can
  // run in parallel on a CPU spike and emit out-of-order entries.
  const queues: Record<WhisperSource, Promise<unknown>> = {
    mic: Promise.resolve(),
    system: Promise.resolve()
  }
  // Streak tracking: per-source last-seen normalized text + consecutive
  // count. Reset whenever a different utterance arrives.
  const streaks: Record<WhisperSource, { key: string; count: number }> = {
    mic: { key: '', count: 0 },
    system: { key: '', count: 0 }
  }
  // Note: language continuity hysteresis was removed. It was designed to
  // suppress single-chunk outlier detections (English hallucinated on top
  // of Mandarin music, etc.) by requiring two consecutive detections of a
  // new language before switching. In practice it silently dropped the
  // FIRST Chinese chunk for code-switching bilingual users — and since
  // recent[] never gained a Chinese entry, the prompt stayed
  // English-biased and the second Chinese chunk was likely also misread
  // as English. The end result was Chinese audio reliably transcribed
  // as English. The MEEPCALL_WHISPER_LANGS allow-list (default `en,zh`)
  // is the intended gate: out-of-list detections are dropped at the
  // server-response layer; within-list switches are accepted instantly.
  // Per-source ring buffer of recently-emitted text used to build the next
  // chunk's `--prompt`. Same source only — mic and system are independent
  // speakers, mixing prompts would confuse whisper's decoder. Each entry
  // records the detected language at emit time so buildPrompt can avoid
  // mixing languages: a code-switching bilingual user (en → zh) should
  // see a same-language-only prompt for the next chunk, otherwise the
  // English text in the prompt biases the decoder against detecting the
  // new Chinese chunk as Chinese.
  const recent: Record<WhisperSource, { text: string; absMs: number; lang: string }[]> = {
    mic: [],
    system: []
  }
  function buildPrompt(source: WhisperSource): string {
    const arr = recent[source]
    if (arr.length === 0) return ''
    // Anchor on the most recent entry's language. Walk back only while
    // the previous entry shares the same language — as soon as we hit a
    // different language, stop. Result: a same-language tail that biases
    // the next decode toward the language the user is currently in.
    const anchorLang = arr[arr.length - 1].lang
    let acc = ''
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].lang !== anchorLang) break
      const next = arr[i].text + (acc ? ' ' + acc : '')
      if (next.length > PROMPT_CHARS_MAX) break
      acc = next
    }
    return acc
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
    const prompt = buildPrompt(source)
    const t0 = Date.now()
    const { segs, detectedLang } = await runWhisper(wavPath, prompt, source)

    // Cleanup temp wav. No JSON sidecar to clean up — whisper-server
    // returns its result inline over HTTP.
    void fsp.unlink(wavPath).catch(() => {})

    const verbose = debugEnabled()
    const noFilters = filtersDisabled()
    const inferMs = Date.now() - t0
    if (verbose) {
      log.local(
        `whisper(${source} #${chunkIndex}): ${segs.length} raw segments in ${inferMs}ms, noFilters=${noFilters}`
      )
    }

    // Pre-filter hallucinations BEFORE the continuity check. A chunk that's
    // pure noise (¶¶¶¶¶, [Music], char loops, "Zither Harp") shouldn't
    // update the language state machine — whisper's detected language on
    // garbage is meaningless, and feeding it into continuity can lock the
    // stream onto the wrong language for the real audio that follows.
    const realSegs = noFilters
      ? segs
      : segs.filter((s) => {
          if (isHallucination(s.text)) {
            if (verbose) log.local(`  drop[hallucination]: ${s.text}`)
            return false
          }
          return true
        })

    // Cross-chunk streak filter — drops "Okay." / "Yeah." / "Hmm." spam
    // after STREAK_LIMIT consecutive identical short emissions. Streak
    // state is per-source and only updated when we actually emit (or when
    // a different utterance arrives), so dropped chunks don't accidentally
    // extend the streak counter past where they should.
    const entries: TranscriptEntry[] = []
    const streak = streaks[source]
    for (const seg of realSegs) {
      if (!noFilters) {
        const key = streakKey(seg.text)
        if (key.length === 0) {
          // Text is all punctuation/whitespace — leave streak state alone.
        } else if (key.length <= STREAK_MAX_LEN && key === streak.key) {
          streak.count++
          if (streak.count > STREAK_LIMIT) {
            if (verbose) log.local(`  drop[streak ${streak.count}× "${seg.text}"]`)
            continue
          }
        } else {
          // Different utterance (any length) breaks the current streak.
          streak.key = key
          streak.count = 1
        }
      }

      const segAbsMs = chunkStartMs + seg.offsetMs
      recent[source].push({ text: seg.text, absMs: segAbsMs, lang: detectedLang || '' })
      entries.push({
        text: seg.text,
        speaker,
        timestamp: new Date(startedAt + segAbsMs).toISOString(),
        sourceLanguage: detectedLang || undefined
      })
    }

    // GC the prompt-context buffer so it doesn't grow unbounded across a
    // long recording. Keep the last PROMPT_RETENTION_MS of audio-time
    // emissions — buildPrompt only reads the tail, so this just bounds
    // memory.
    const cutoff = chunkStartMs + (segs.length > 0 ? segs[segs.length - 1].offsetMs : 0) - PROMPT_RETENTION_MS
    if (recent[source].length > 0 && recent[source][0].absMs < cutoff) {
      recent[source] = recent[source].filter((e) => e.absMs >= cutoff)
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
