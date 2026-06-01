import Anthropic from '@anthropic-ai/sdk'
import type { TranscriptEntry } from '@shared/types'
import { log } from './log'
import { translateLocal } from './nllb-translate'
import { scheduleOperation } from './storage'
import { sendToRenderer } from './window'

// Haiku 4.5 — fast + cheap, plenty for line-by-line translation. Override via
// MEEPCALL_TRANSLATE_MODEL if you want to A/B against Sonnet/Opus.
const MODEL = process.env.MEEPCALL_TRANSLATE_MODEL?.trim() || 'claude-haiku-4-5-20251001'

// Translation engine selector. Default `haiku` keeps the ASR-error-correction
// + context-aware homophone-recovery logic that's been tuned in this file.
// Set MEEPCALL_TRANSLATE_ENGINE=local to use NLLB-200-distilled-600M
// on-device — sub-200ms per line, no API key, but no ASR correction.
type TranslateEngine = 'haiku' | 'local'
function getEngine(): TranslateEngine {
  const raw = (process.env.MEEPCALL_TRANSLATE_ENGINE ?? 'haiku').trim().toLowerCase()
  return raw === 'local' ? 'local' : 'haiku'
}

// Trigger translation when the line contains any character from a
// non-English script. Built via new RegExp so the source file stays ASCII.
// Coverage:
//   - CJK Unified + extension A, hiragana, katakana, hangul
//     → Mandarin / Cantonese / Japanese / Korean
//   - Cyrillic → Russian, Ukrainian, Bulgarian, Serbian, etc.
//   - Greek
//   - Arabic + supplement
//   - Hebrew
//   - Devanagari, Bengali, Tamil, Thai → Hindi, Bengali, Tamil, Thai
//   - Latin-with-diacritics (À-ÿ, Latin Extended-A) → Spanish, French,
//     German, Portuguese, Italian, Polish, Czech, Vietnamese, Turkish, etc.
//     The diacritic is the strong "this is not plain English" signal.
//     Misses: short accent-free non-English lines like "Hola amigo" or
//     "bonjour". Rare in conversational ASR where accents tend to appear
//     within most utterances.
// English loanwords that happen to carry diacritics ("café", "naïve") still
// trigger a Haiku call, but the system prompt says "if already English,
// repeat verbatim" and translateAndPersist drops translations that match
// the input — so the no-op is invisible in the UI, only an API cost.
const NON_ENGLISH_RE = new RegExp(
  '[\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af]' + // CJK + kana + hangul
    '|[\\u0400-\\u04ff\\u0500-\\u052f]' + // Cyrillic + supplement
    '|[\\u0370-\\u03ff]' + // Greek
    '|[\\u0600-\\u06ff\\u0750-\\u077f]' + // Arabic + supplement
    '|[\\u0590-\\u05ff]' + // Hebrew
    '|[\\u0900-\\u097f\\u0980-\\u09ff\\u0b80-\\u0bff\\u0e00-\\u0e7f]' + // Devanagari, Bengali, Tamil, Thai
    '|[\\u00c0-\\u00ff\\u0100-\\u017f]' // Latin-1 Supplement + Latin Extended-A (diacritics)
)

// Output is forced via assistant prefill `<en>` + stop_sequences `</en>` in
// translateAndPersist. The system prompt only needs to describe the task and
// the silent ASR-correction capability — every "output ONLY" instruction
// from the previous version was bypassed by the model dumping its analysis
// before the translation. The prefill leaves no room for preamble.
const SYSTEM_PROMPT =
  'Real-time English translator for live captions. The user message contains ' +
  'a single short line in some non-English language (Mandarin, Cantonese, ' +
  'Japanese, Korean, Spanish, French, German, Russian, Arabic, Hindi, ' +
  'Portuguese, Italian, Vietnamese, Thai, etc., or any other). Translate ' +
  'into natural, fluent English.\n\n' +
  'The text comes from automatic speech recognition (whisper) and often ' +
  'contains sound-alike errors: Mandarin/Cantonese homophones, dropped ' +
  'accent marks, wrong case or conjugation, duplicated stutter words. When ' +
  'the literal reading is ungrammatical or nonsensical, silently re-read it ' +
  'phonetically and use the surrounding context to recover the intended ' +
  'phrase. Do all reasoning internally — never write it down, never explain.\n\n' +
  'CONTEXT lines, when present, are prior captions for disambiguation only. ' +
  'Never translate or repeat them.\n\n' +
  'If the input is already English, output it verbatim. Always output a ' +
  'fluent English sentence — never gibberish, transliteration, or pinyin.'

let _client: Anthropic | null | undefined
function getClient(): Anthropic | null {
  if (_client !== undefined) return _client
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    _client = null
    return null
  }
  _client = new Anthropic({ apiKey })
  return _client
}

export function needsTranslation(text: string): boolean {
  return NON_ENGLISH_RE.test(text)
}

// Two-tier dedup keyed by `${noteId}|${timestamp}|${text}`:
//   - `inflight`: a translation is currently being attempted. Prevents a
//     duplicate concurrent call (e.g., Recall fires the same entry twice
//     in one burst). Cleared when the attempt resolves.
//   - `succeeded`: a translation was successfully persisted. Final dedup
//     so we don't re-translate the same line. Never cleared.
// Splitting the two means a TRANSIENT failure (NLLB worker crash, Haiku
// rate limit, network blip) doesn't permanently mark the entry as done —
// the next emission of the same entry will retry. Adversarial review
// flagged the prior single-set design as silently swallowing failures.
const inflight = new Set<string>()
const succeeded = new Set<string>()

// Per-note rolling context window. Each translation call gets a snapshot of
// the prior CONTEXT_LINES source-language lines so Haiku can resolve
// pronouns ("我" vs "我们"), idioms, and topic continuity (a song's
// imagery, a dialogue's referent). Bounded by both line count AND total
// chars so a single long line doesn't blow up the prompt.
const CONTEXT_LINES = 10
const CONTEXT_CHARS_MAX = 600
interface ContextEntry {
  speaker: string
  text: string
}
const contexts = new Map<string, ContextEntry[]>()

function snapshotAndPushContext(noteId: string, entry: TranscriptEntry): ContextEntry[] {
  const ring = contexts.get(noteId) ?? []
  // Snapshot BEFORE pushing — the new line's context is the lines before it.
  const snapshot = ring.slice()
  ring.push({ speaker: entry.speaker, text: entry.text })
  while (ring.length > CONTEXT_LINES) ring.shift()
  let total = 0
  for (const e of ring) total += e.text.length
  while (total > CONTEXT_CHARS_MAX && ring.length > 1) {
    total -= (ring.shift() as ContextEntry).text.length
  }
  contexts.set(noteId, ring)
  return snapshot
}

// Translations fire in parallel — every line gets its own engine call the
// moment it arrives. A serial queue used to live here for log readability,
// but it turned dense bursts (a song, a fast speaker) into 12–16s tails on
// the Haiku path: 8 queued lines × ~1.5s/call = the live caption falls way
// behind the transcript. Order doesn't matter for correctness because the
// persist layer matches by timestamp+text+speaker, not by arrival order.
export function queueTranslation(noteId: string, entry: TranscriptEntry): void {
  if (entry.translation) return
  if (!needsTranslation(entry.text)) return

  const key = `${noteId}|${entry.timestamp}|${entry.text}`
  if (succeeded.has(key) || inflight.has(key)) return

  const engine = getEngine()
  let attempt: Promise<boolean>
  if (engine === 'local') {
    // NLLB doesn't benefit from chat-style context; skip the ring-buffer
    // snapshot. Faster end-to-end and avoids confusing the seq2seq model
    // with multi-line input it'd want to translate as one block.
    inflight.add(key)
    attempt = translateLocalAndPersist(noteId, entry)
  } else {
    const client = getClient()
    if (!client) return
    inflight.add(key)
    const context = snapshotAndPushContext(noteId, entry)
    attempt = translateAndPersist(client, noteId, entry, context)
  }

  void attempt
    .then((ok) => {
      if (ok) succeeded.add(key)
    })
    .catch(() => undefined)
    .finally(() => {
      inflight.delete(key)
    })
}

// Returns true on a real persisted translation, false on engine failure
// or no-op (translation matched input, init failed, etc.). Only `true`
// marks the entry as `succeeded`; `false` leaves it eligible for retry on
// the next emission of the same line.
async function translateLocalAndPersist(
  noteId: string,
  entry: TranscriptEntry
): Promise<boolean> {
  const t0 = Date.now()
  const translation = await translateLocal(entry.text, entry.sourceLanguage)
  if (!translation || translation === entry.text) return false
  log.ai(`Translation [${entry.speaker}] (local ${Date.now() - t0}ms): ${translation}`)
  await persistTranslation(noteId, entry, translation)
  return true
}

async function persistTranslation(
  noteId: string,
  entry: TranscriptEntry,
  translation: string
): Promise<void> {
  await scheduleOperation((data) => {
    const meeting = data.pastMeetings.find((m) => m.id === noteId)
    if (!meeting?.transcript) return null
    const target = meeting.transcript.find(
      (e) =>
        e.timestamp === entry.timestamp &&
        e.text === entry.text &&
        e.speaker === entry.speaker
    )
    if (!target) return null
    if (target.translation === translation) return null
    target.translation = translation
    sendToRenderer('transcript-updated', noteId)
    return data
  })
}

function buildUserContent(entry: TranscriptEntry, context: ContextEntry[]): string {
  if (context.length === 0) return `<input>${entry.text}</input>`
  const ctx = context.map((c) => `${c.speaker}: ${c.text}`).join('\n')
  return `<context>\n${ctx}\n</context>\n\n<input>${entry.text}</input>`
}

async function translateAndPersist(
  client: Anthropic,
  noteId: string,
  entry: TranscriptEntry,
  context: ContextEntry[]
): Promise<boolean> {
  let translation = ''
  try {
    // Assistant prefill `<en>` anchors the response to start at the
    // translation. stop_sequences `</en>` halts the model the instant it
    // closes the tag — no trailing analysis can leak through. Together they
    // make every byte of resp.content the translation itself.
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      stop_sequences: ['</en>'],
      messages: [
        { role: 'user', content: buildUserContent(entry, context) },
        { role: 'assistant', content: '<en>' }
      ]
    })
    for (const block of resp.content) {
      if (block.type === 'text') translation += block.text
    }
    // Defensive: if the model leaked a literal </en> anyway, cut at it.
    const closeIdx = translation.indexOf('</en>')
    if (closeIdx >= 0) translation = translation.slice(0, closeIdx)
    translation = translation.trim()
  } catch (err) {
    log.warn('ai', `translation failed: ${(err as Error).message}`)
    return false
  }
  if (!translation || translation === entry.text) return false

  log.ai(`Translation [${entry.speaker}]: ${translation}`)
  await persistTranslation(noteId, entry, translation)
  return true
}
