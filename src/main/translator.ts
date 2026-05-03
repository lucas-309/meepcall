import Anthropic from '@anthropic-ai/sdk'
import type { TranscriptEntry } from '@shared/types'
import { log } from './log'
import { scheduleOperation } from './storage'
import { sendToRenderer } from './window'

// Haiku 4.5 — fast + cheap, plenty for line-by-line translation. Override via
// MEEPCALL_TRANSLATE_MODEL if you want to A/B against Sonnet/Opus.
const MODEL = process.env.MEEPCALL_TRANSLATE_MODEL?.trim() || 'claude-haiku-4-5-20251001'

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

const SYSTEM_PROMPT =
  'You translate short live-captioning lines from ANY non-English language ' +
  'into natural, fluent English. The source language varies (Mandarin, ' +
  'Cantonese, Japanese, Korean, Spanish, French, German, Russian, Arabic, ' +
  'Hindi, Portuguese, Italian, Vietnamese, Thai — anything). Detect the ' +
  'language from the text itself; do not ask.\n\n' +
  'CRITICAL: the source text comes from automatic speech recognition ' +
  '(whisper) and may contain SOUND-ALIKE errors. Whisper often substitutes ' +
  'characters or words that share pronunciation with the intended word — ' +
  'Mandarin homophones with the same pinyin, Cantonese near-homophones, ' +
  'Korean hangul with the same syllable sound, Japanese kana mishearings, ' +
  'Spanish/French wrong-accent or wrong-conjugation forms, Russian wrong-case ' +
  'endings, etc. When a phrase looks ungrammatical, nonsensical, or out of ' +
  'place:\n' +
  '  1. Read the input PHONETICALLY (pinyin / hangul / kana / IPA-like ' +
  'sounds for whatever script), not by literal character/word meaning.\n' +
  '  2. Use the surrounding CONTEXT (and common phrases / song lyrics / ' +
  'idioms) to infer the most plausible INTENDED phrase that sounds the same ' +
  'or nearly the same.\n' +
  '  3. Translate the INFERRED meaning, not the literal text.\n' +
  'Examples of what to fix silently:\n' +
  '  • Mandarin "不要把河河" (don\'t put the river river — nonsense) → likely ' +
  'a homophone of 河 like 喝/合; infer from context.\n' +
  '  • Mandarin "伴侯的五美书香" (literal: "companion-marquis\'s five-beauty ' +
  'book-fragrance" — nonsense) → likely a stock phrase the speaker actually ' +
  'said; infer phonetically.\n' +
  '  • Spanish "esta" vs "está" — whisper drops accent marks; infer the ' +
  'correct form from context.\n' +
  '  • duplicated characters/words ("河河", "the the") often = transcription ' +
  'stutter, collapse to one.\n\n' +
  'Output ONLY the English translation of the line marked "TRANSLATE:" — no ' +
  'quotes, no romanization, no commentary, no language label, no speaker ' +
  'prefix, no "[corrected]" notes. Earlier lines may appear above as ' +
  'CONTEXT — use them only to resolve pronouns, idioms, topic continuity, ' +
  'and sound-alike errors; do NOT translate or repeat them. Preserve speaker ' +
  'tone (casual, formal, lyrical). Never output gibberish or transliteration ' +
  '— always output a fluent English sentence. If the input is already in ' +
  'English, repeat it verbatim.'

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

// In-flight + completed dedup. Keyed by `${noteId}|${timestamp}|${text}`. The
// recall-sdk path can call us with the same entry shape multiple times per
// realtime-event burst; this guard keeps us at one API call per entry.
const seen = new Set<string>()

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

// Translations fire in parallel — every line gets its own API call the moment
// it arrives. A serial queue used to live here for log readability, but it
// turned dense bursts (a song, a fast speaker) into 12–16s tails: 8 queued
// lines × ~1.5s/Haiku call = the live caption falls way behind the
// transcript. Order doesn't matter for correctness because the persist
// layer matches by timestamp+text+speaker, not by arrival order.
export function queueTranslation(noteId: string, entry: TranscriptEntry): void {
  if (entry.translation) return
  if (!needsTranslation(entry.text)) return
  const client = getClient()
  if (!client) return

  const key = `${noteId}|${entry.timestamp}|${entry.text}`
  if (seen.has(key)) return
  seen.add(key)

  const context = snapshotAndPushContext(noteId, entry)
  void translateAndPersist(client, noteId, entry, context).catch(() => undefined)
}

function buildUserContent(entry: TranscriptEntry, context: ContextEntry[]): string {
  if (context.length === 0) return `TRANSLATE:\n${entry.text}`
  const ctx = context.map((c) => `${c.speaker}: ${c.text}`).join('\n')
  return `CONTEXT (do not translate):\n${ctx}\n\nTRANSLATE:\n${entry.text}`
}

async function translateAndPersist(
  client: Anthropic,
  noteId: string,
  entry: TranscriptEntry,
  context: ContextEntry[]
): Promise<void> {
  let translation = ''
  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserContent(entry, context) }]
    })
    for (const block of resp.content) {
      if (block.type === 'text') translation += block.text
    }
    translation = translation.trim()
  } catch (err) {
    log.warn('ai', `translation failed: ${(err as Error).message}`)
    return
  }
  if (!translation || translation === entry.text) return

  log.ai(`Translation [${entry.speaker}]: ${translation}`)

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
