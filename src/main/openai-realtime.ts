// OpenAI Realtime API WebSocket client for live transcription + translation.
// Per-source long-lived socket that streams continuous PCM audio in and
// emits transcript / translation deltas back. Selected via
// MEEPCALL_TRANSCRIBE_ENGINE=openai-realtime (or translate engine = same).
// Default stays `local` — meepcall runs free out of the box.
//
// Two modes, picked at construction time:
//
//   transcribe (gpt-realtime-whisper)
//     URL: wss://api.openai.com/v1/realtime?intent=transcription
//     Sends:    input_audio_buffer.append   { audio: <base64 pcm16 24k> }
//     Receives: conversation.item.input_audio_transcription.delta      partial
//               conversation.item.input_audio_transcription.completed  final
//     Emits source-language transcripts only.
//
//   translate (gpt-realtime-translate)
//     URL: wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate
//     Sends:    session.input_audio_buffer.append { audio: <base64 pcm16 24k> }
//     Receives: session.input_transcript.delta         source partial
//               session.input_transcript.completed     source final (synthesized)
//               session.output_transcript.delta        target partial
//               session.output_transcript.completed    target final
//     Emits BOTH source and target text from one socket. Used when both
//     transcribe and translate are openai-realtime so we don't pay for
//     two parallel uploads of the same audio.
//
// Why WebSocket and NOT REST: the user explicitly wanted the new realtime
// streaming models (gpt-realtime-whisper / gpt-realtime-translate). They
// produce phrase-aligned output via server-side VAD with a couple-hundred-
// millisecond latency, vs the fixed-window REST chunkers' ~2 s minimum.
//
// The local pipeline (whisper-server + NLLB) is untouched. When this
// session is active we BYPASS the local chunker entirely for that source
// and feed PCM directly into the socket — server-side VAD picks the
// phrase boundaries, no need for our 2 s fixed window.
//
// Resampling: audio-helper emits 16 kHz Int16 PCM (whisper.cpp's native
// rate). The Realtime API expects 24 kHz PCM16. We linearly upsample
// 16 → 24 inline (cheap; ~1 µs/sample on M-series). For continuous
// streaming we keep the last input sample around so the cross-buffer
// interpolation doesn't drop a fractional sample at every boundary —
// inaudible in practice but trivial to do right.
//
// Reconnect budget: 3 attempts with exponential backoff (250 ms → 1 s →
// 4 s) per session. Past that we mark the session permanently dead and
// the recording loses transcripts/translations from this socket for the
// rest of the run — we DO NOT crash the app. The local pipeline (if
// configured as the transcribe path) keeps running independently; if
// realtime was the only path, the user just sees the gap.

import WebSocket from 'ws'
import { log } from './log'

const TRANSCRIBE_URL = 'wss://api.openai.com/v1/realtime?intent=transcription'
const TRANSLATE_URL =
  'wss://api.openai.com/v1/realtime/translations?model=' +
  encodeURIComponent(
    process.env.MEEPCALL_OPENAI_REALTIME_TRANSLATE_MODEL?.trim() || 'gpt-realtime-translate'
  )

const TRANSCRIBE_MODEL =
  process.env.MEEPCALL_OPENAI_REALTIME_TRANSCRIBE_MODEL?.trim() || 'gpt-realtime-whisper'

// Target language for the translate model. English by default — meepcall
// is built for English live captions on non-English audio. Override with
// MEEPCALL_OPENAI_REALTIME_TARGET_LANG=es / fr / etc. if you actually
// want a different output language.
const TARGET_LANG = process.env.MEEPCALL_OPENAI_REALTIME_TARGET_LANG?.trim() || 'en'

// Source-language hint for the transcribe model. Same shape + default as
// WHISPER_LANGUAGE for symmetry with the local pipeline. `auto` omits the
// hint and lets the model auto-detect.
const SOURCE_LANG_HINT = (process.env.WHISPER_LANGUAGE?.trim() || 'auto').toLowerCase()

// Server-side VAD tuning. Lower threshold = more sensitive (catches
// quieter speech but also more noise); longer silence_duration_ms =
// waits longer before declaring end-of-phrase (so it doesn't cut you
// off mid-sentence on natural pauses). Defaults are tuned for desk-mic
// conversational use; bump silence_duration_ms higher (~700-1000) for
// lyrical / sung audio with held syllables. Threshold below 0.3 will
// likely trip on background hum.
const VAD_THRESHOLD = Number(process.env.MEEPCALL_REALTIME_VAD_THRESHOLD ?? 0.4)
const VAD_PREFIX_PADDING_MS = Number(process.env.MEEPCALL_REALTIME_VAD_PREFIX_PADDING_MS ?? 400)
const VAD_SILENCE_DURATION_MS = Number(process.env.MEEPCALL_REALTIME_VAD_SILENCE_MS ?? 700)

// Hard reconnect budget — only protocol errors and other "this isn't
// going to work" failures count against it. Idle/keepalive closes
// (code 1011) are routine on long recordings and reconnect for free.
const MAX_RECONNECTS = 10
const BACKOFF_MS = [250, 500, 1000, 2000, 4000, 4000, 4000, 4000, 4000, 4000]

export type RealtimeMode = 'transcribe' | 'translate'
export type RealtimeSource = 'mic' | 'system'

export interface RealtimeCallbacks {
  // Final source-language transcript for one phrase. itemId groups
  // related events (delta + completed + a matching translation in
  // translate mode). audioOffsetMs is the audio-time start of the
  // utterance, measured from session start.
  onTranscript: (
    itemId: string,
    text: string,
    sourceLang: string | null,
    audioOffsetMs: number
  ) => void
  // Translate mode only: final translated text for one phrase. Match
  // against onTranscript by itemId. Fires after the corresponding
  // onTranscript in practice (the model finishes the source first),
  // but callers shouldn't depend on order.
  onTranslation?: (itemId: string, text: string, audioOffsetMs: number) => void
}

interface ItemAccumulator {
  source: string
  target: string
  startedAtAudioMs: number
  // The realtime API doesn't tag deltas with a language — we infer it
  // from the finalized text via Unicode-block heuristics inside the
  // translator. Stored only so onTranscript can pass it through.
  sourceLang: string | null
}

function isPcm16Crash(_signal: NodeJS.Signals | null, _code: number | null): boolean {
  // placeholder for future signal classification — currently unused.
  return false
}

// 16 kHz Int16 LE → 24 kHz Int16 LE, linear interpolation. State is
// retained across calls (lastSample) so the boundary sample isn't lost
// on every chunk transition.
class Resampler16to24 {
  private lastSample = 0
  private hasLast = false
  // fractional sample-position carry: at the end of the previous chunk
  // we may have consumed e.g. 1.667 input samples, leaving 0.333 of an
  // input sample worth of output to emit at the start of the next chunk.
  private srcPosFrac = 0

  reset(): void {
    this.lastSample = 0
    this.hasLast = false
    this.srcPosFrac = 0
  }

  process(input: Buffer): Buffer {
    const inSamples = input.length >> 1
    if (inSamples === 0) return Buffer.alloc(0)
    // Output rate / input rate = 24/16 = 3/2. So 2 input samples → 3
    // output samples. We compute output-sample-by-output-sample using
    // the source-position formula srcPos = i * 2/3.
    //
    // With cross-chunk carry: srcPos for output sample i (relative to
    // the start of THIS chunk) = i*2/3 - srcPosFrac.
    //   negative srcPos means we read from the carried lastSample.
    const RATIO = 2 / 3
    // Determine how many output samples this chunk should produce. Base
    // count: floor(inSamples * 3/2 + srcPosFrac * 3/2). Conservative:
    // floor(inSamples * 1.5).
    const outSamples = Math.floor(inSamples * 1.5)
    const out = Buffer.alloc(outSamples * 2)
    let written = 0
    for (let i = 0; i < outSamples; i++) {
      const srcF = i * RATIO - this.srcPosFrac
      const idx = Math.floor(srcF)
      const frac = srcF - idx
      let a: number
      let b: number
      if (idx < 0) {
        // Reading into the carried-over previous-chunk sample.
        a = this.hasLast ? this.lastSample : 0
        b = input.readInt16LE(0)
      } else if (idx + 1 < inSamples) {
        a = input.readInt16LE(idx * 2)
        b = input.readInt16LE((idx + 1) * 2)
      } else if (idx < inSamples) {
        a = input.readInt16LE(idx * 2)
        b = a // last sample, hold
      } else {
        // Out of range — should not happen with correct outSamples math.
        break
      }
      const sample = Math.round(a + (b - a) * frac)
      out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), written * 2)
      written++
    }
    // Update carry for next chunk: how many input samples did we
    // effectively consume, and what's the fractional remainder?
    const consumed = written * RATIO - this.srcPosFrac
    const fullConsumed = Math.floor(consumed)
    this.srcPosFrac = consumed - fullConsumed
    if (inSamples > 0) {
      this.lastSample = input.readInt16LE((inSamples - 1) * 2)
      this.hasLast = true
    }
    return written === outSamples ? out : out.subarray(0, written * 2)
  }
}

let warnedNoKey = false
function getApiKey(): string | null {
  const key = process.env.OPENAI_API_KEY?.trim()
  if (!key) {
    if (!warnedNoKey) {
      warnedNoKey = true
      log.warn(
        'ai',
        'OPENAI_API_KEY is unset — realtime transcribe/translate sessions skipped. Set it in .env or switch the engine back to local.'
      )
    }
    return null
  }
  return key
}

export class RealtimeSession {
  private ws: WebSocket | null = null
  private connecting: Promise<void> | null = null
  private dead = false
  private closed = false
  private reconnectAttempt = 0
  private items = new Map<string, ItemAccumulator>()
  // Errors that have been logged at least once for this session — used
  // to silence the per-message spam when the server keeps rejecting
  // every audio frame for the same reason (e.g. wrong event name).
  private loggedErrors = new Set<string>()
  // Translate-mode phrase accumulator. The translation API emits ONLY
  // append-only `*.delta` events — no `.completed`, no `.done`, no
  // `item_id`. We have to infer phrase boundaries client-side from
  // gaps in delta emission, then emit one TranscriptEntry per phrase
  // with both source and translation populated.
  private translateSourceBuf = ''
  private translateTargetBuf = ''
  private translatePhraseStartMs = 0
  private translatePhraseTimer: NodeJS.Timeout | null = null
  // Counter to synthesize unique itemIds per finalized phrase (the
  // translate API doesn't give us a real one). Used only to link the
  // onTranscript and onTranslation callbacks for the same phrase via
  // RealtimeItemRef in audio-capture.ts.
  private translatePhraseSeq = 0
  // ms of silence-since-last-delta that counts as end-of-phrase. The
  // translate model emits the OUTPUT (translation) lagging the input
  // by a noticeable amount — input deltas can finish well before the
  // matching output deltas do — so the gap needs to be long enough
  // that we don't finalize halfway through, attach the output to the
  // NEXT phrase, and end up with garbled mismatches like
  // "Transcript: 那也曾是我的 / Translation: The". 2500 ms accommodates
  // most realistic spoken lag; sung lyrics with held notes still get
  // chopped here but that's an inherent limitation of doing
  // client-side phrase inference on a delta-only protocol.
  private static readonly TRANSLATE_PHRASE_GAP_MS = 2500
  // Force-finalize after this much accumulated audio time so very
  // long unbroken speech doesn't sit invisible in the buffer.
  private static readonly TRANSLATE_PHRASE_MAX_MS = 12000
  // Audio-time clock (ms since session start). Each appendAudio bumps
  // this by the duration of the appended PCM, so phrase events can be
  // tagged with the audio offset they correspond to without depending
  // on system wall-clock.
  private audioMs = 0
  // Pending PCM accumulated during reconnect; flushed once the new
  // socket is open. Cap at 5 s of audio (240 KB at 24 kHz pcm16) so a
  // long disconnect doesn't balloon memory.
  private pending: Buffer[] = []
  private pendingBytes = 0
  private static readonly MAX_PENDING_BYTES = 5 * 24000 * 2
  private resampler = new Resampler16to24()

  constructor(
    private readonly mode: RealtimeMode,
    private readonly source: RealtimeSource,
    private readonly callbacks: RealtimeCallbacks
  ) {}

  // Returns true when a socket is open or being opened. False means the
  // session is permanently dead for this recording (either no API key
  // or the reconnect budget was exhausted) — caller should stop
  // forwarding audio to it.
  ensureOpen(): boolean {
    if (this.dead || this.closed) return false
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return true
    if (this.connecting) return true
    this.connecting = this.connect().finally(() => {
      this.connecting = null
    })
    return true
  }

  // Append a 16 kHz Int16 LE PCM buffer (the audio-helper's native
  // output format). Resamples to 24 kHz internally and sends as a
  // base64 audio frame. Drops silently if the socket isn't ready and
  // the pending buffer is full.
  appendAudio16k(pcm16: Buffer): void {
    if (this.dead || this.closed) return
    const resampled = this.resampler.process(pcm16)
    if (resampled.length === 0) return
    // Audio-time bookkeeping uses the SOURCE rate (16 kHz) — that's the
    // cadence the audio-helper produces and the cadence everything
    // downstream measures in. Bytes per ms at 16 kHz pcm16 = 32.
    this.audioMs += pcm16.length / 32

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send(this.appendEvent(resampled))
    } else {
      // Buffer until reconnect; cap to prevent unbounded growth on a
      // long disconnect.
      if (this.pendingBytes + resampled.length > RealtimeSession.MAX_PENDING_BYTES) {
        // Drop oldest until we fit.
        while (
          this.pendingBytes + resampled.length > RealtimeSession.MAX_PENDING_BYTES &&
          this.pending.length > 0
        ) {
          const dropped = this.pending.shift()!
          this.pendingBytes -= dropped.length
        }
      }
      this.pending.push(resampled)
      this.pendingBytes += resampled.length
      this.ensureOpen()
    }
  }

  close(): void {
    this.closed = true
    this.pending = []
    this.pendingBytes = 0
    if (this.translatePhraseTimer) {
      clearTimeout(this.translatePhraseTimer)
      this.translatePhraseTimer = null
    }
    // Flush whatever was mid-phrase when stop was hit — for ⌘⇧R the
    // user just stopped recording, but the buffer may hold the
    // trailing few seconds of audio we'd otherwise lose.
    if (this.translateSourceBuf || this.translateTargetBuf) {
      this.finalizeTranslatePhrase(this.audioMs)
    }
    if (this.ws) {
      try {
        this.ws.close(1000, 'session ending')
      } catch {
        /* ignore */
      }
      this.ws = null
    }
  }

  // ───────── private ─────────

  private appendEvent(pcm24: Buffer): object {
    const audio = pcm24.toString('base64')
    // The two endpoints speak DIFFERENT dialects:
    //   transcribe (intent=transcription, beta) — unprefixed events:
    //     input_audio_buffer.append, etc. The server's own error
    //     message lists the supported set explicitly.
    //   translate (/v1/realtime/translations, GA) — `session.`-prefixed
    //     events: session.input_audio_buffer.append. Confirmed by the
    //     official openai-cookbook realtime_translation_guide.mdx.
    // The cross-dialect rejection looks like "Unknown parameter:
    // 'session.audio'" — that's the BETA endpoint refusing the
    // GA-shaped session.update. We avoid it by only sending the
    // OpenAI-Beta header for the transcribe socket; see connect().
    if (this.mode === 'transcribe') {
      return { type: 'input_audio_buffer.append', audio }
    }
    return { type: 'session.input_audio_buffer.append', audio }
  }

  private send(event: object): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(JSON.stringify(event))
    } catch (err) {
      log.warn('ai', `realtime[${this.source}/${this.mode}] send failed: ${(err as Error).message}`)
    }
  }

  private async connect(): Promise<void> {
    const apiKey = getApiKey()
    if (!apiKey) {
      this.dead = true
      return
    }
    if (this.reconnectAttempt >= MAX_RECONNECTS) {
      this.dead = true
      log.warn(
        'ai',
        `realtime[${this.source}/${this.mode}] reconnect budget exhausted (${MAX_RECONNECTS}); permanently dead for this recording.`
      )
      return
    }
    if (this.reconnectAttempt > 0) {
      const wait = BACKOFF_MS[this.reconnectAttempt - 1] ?? 4000
      await new Promise((r) => setTimeout(r, wait))
      if (this.closed) return
    }

    const url = this.mode === 'transcribe' ? TRANSCRIBE_URL : TRANSLATE_URL
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`
    }
    // Transcription sessions still live on the BETA realtime API and
    // require the `OpenAI-Beta: realtime=v1` opt-in header. Translation
    // sessions are GA and reject that header (the server replies
    // "Translation sessions are only available on the GA API.")
    if (this.mode === 'transcribe') {
      headers['OpenAI-Beta'] = 'realtime=v1'
    }
    const ws = new WebSocket(url, { headers })
    this.ws = ws

    await new Promise<void>((resolve) => {
      ws.once('open', () => {
        log.local(`realtime[${this.source}/${this.mode}] connected`)
        this.sendSessionUpdate()
        // Drain any audio that arrived before the socket opened.
        for (const buf of this.pending) {
          this.send(this.appendEvent(buf))
        }
        this.pending = []
        this.pendingBytes = 0
        // Reset the reconnect counter on a successful open. Subsequent
        // failures get a full 3-attempt budget rather than starting
        // from wherever the last storm left off.
        this.reconnectAttempt = 0
        resolve()
      })
      ws.once('error', (err) => {
        log.warn('ai', `realtime[${this.source}/${this.mode}] error: ${err.message}`)
      })
      ws.once('close', (code, reason) => {
        const reasonStr = reason?.toString() ?? ''
        if (this.closed) return
        // Server-side idle / keepalive closes are routine on long
        // recordings — the model gives up if there hasn't been
        // speech for a while. We reopen cleanly for free, without
        // burning the reconnect budget that's reserved for genuine
        // problems (bad protocol, auth, etc).
        const isKeepalive = code === 1011 || /keepalive|idle|timeout/i.test(reasonStr)
        if (!isKeepalive) {
          this.reconnectAttempt++
        }
        log.warn(
          'ai',
          `realtime[${this.source}/${this.mode}] closed code=${code} reason="${reasonStr.slice(0, 100)}"${isKeepalive ? ' (idle, free reopen)' : `, reconnecting (attempt ${this.reconnectAttempt}/${MAX_RECONNECTS})`}`
        )
        // Reset resampler state — the next connection starts a fresh
        // audio session from OpenAI's perspective; carrying interp
        // state across the gap would mean a tiny pop at the boundary
        // anyway.
        this.resampler.reset()
        // Kick off reconnect; we don't wait here — connect() will
        // resolve immediately and reconnect runs in the background.
        this.ensureOpen()
        resolve()
      })
      ws.on('message', (data) => this.handleMessage(data))
    })
  }

  private sendSessionUpdate(): void {
    if (this.mode === 'transcribe') {
      const transcription: Record<string, unknown> = { model: TRANSCRIBE_MODEL }
      if (SOURCE_LANG_HINT && SOURCE_LANG_HINT !== 'auto') {
        transcription.language = SOURCE_LANG_HINT
      }
      this.send({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              transcription,
              noise_reduction: { type: 'near_field' },
              turn_detection: {
                type: 'server_vad',
                threshold: VAD_THRESHOLD,
                prefix_padding_ms: VAD_PREFIX_PADDING_MS,
                silence_duration_ms: VAD_SILENCE_DURATION_MS
              }
            }
          }
        }
      })
    } else {
      // GA translation session.update — shape lifted verbatim from the
      // openai-cookbook realtime_translation_guide. The translate model
      // does its own input transcription; we tell it which whisper
      // variant to use for source-language captions, and turn on
      // near-field noise reduction (the call/desktop-mic profile).
      this.send({
        type: 'session.update',
        session: {
          audio: {
            input: {
              transcription: { model: TRANSCRIBE_MODEL },
              noise_reduction: { type: 'near_field' }
            },
            output: { language: TARGET_LANG }
          }
        }
      })
    }
  }

  // Track which event types we've seen on this session — log each one
  // exactly once so a quick first run reveals the actual event names
  // the server emits (the docs were wrong about the send side; assume
  // they're wrong about the receive side until proven otherwise).
  private seenEventTypes = new Set<string>()

  private handleMessage(data: WebSocket.RawData): void {
    let evt: Record<string, unknown>
    try {
      evt = JSON.parse(data.toString()) as Record<string, unknown>
    } catch {
      return
    }
    const type = evt.type as string | undefined
    if (!type) return
    if (!this.seenEventTypes.has(type)) {
      this.seenEventTypes.add(type)
      log.local(`realtime[${this.source}/${this.mode}] event type seen: ${type}`)
    }

    // Surface API-side errors loudly, but de-duplicate identical
    // messages — when the server rejects every audio frame for a
    // protocol mistake we'd otherwise flood the log with hundreds of
    // copies. On any error we ALSO mark the session dead so we stop
    // sending audio that just triggers more errors. Reconnecting
    // wouldn't help — the same client code would make the same wrong
    // request again — so dying loudly is the correct response.
    if (type === 'error') {
      const e = (evt.error as { message?: string; code?: string }) ?? {}
      const key = `${e.code ?? '?'}|${e.message ?? ''}`
      if (!this.loggedErrors.has(key)) {
        this.loggedErrors.add(key)
        log.warn(
          'ai',
          `realtime[${this.source}/${this.mode}] api error: ${e.code ?? '?'} ${e.message ?? ''}`
        )
        log.warn(
          'ai',
          `realtime[${this.source}/${this.mode}] session marked dead after protocol error; further audio will be dropped this run.`
        )
      }
      this.dead = true
      this.close()
      return
    }

    if (this.mode === 'transcribe') {
      this.handleTranscribeEvent(type, evt)
    } else {
      this.handleTranslateEvent(type, evt)
    }
  }

  private getOrCreateItem(itemId: string): ItemAccumulator {
    let item = this.items.get(itemId)
    if (!item) {
      item = {
        source: '',
        target: '',
        startedAtAudioMs: this.audioMs,
        sourceLang: null
      }
      this.items.set(itemId, item)
    }
    return item
  }

  private handleTranscribeEvent(type: string, evt: Record<string, unknown>): void {
    if (type === 'conversation.item.input_audio_transcription.delta') {
      const itemId = evt.item_id as string | undefined
      const delta = (evt.delta as string | undefined) ?? ''
      if (!itemId) return
      const item = this.getOrCreateItem(itemId)
      item.source += delta
      // Stream the delta to terminal so the user can watch the model
      // type out the transcript live, matching what they'd see in a
      // GUI. The finalized line still emits below on .completed.
      log.local(`realtime[${this.source}] src+= ${JSON.stringify(delta)}  ↳  ${item.source}`)
    } else if (type === 'conversation.item.input_audio_transcription.completed') {
      const itemId = evt.item_id as string | undefined
      const finalText = ((evt.transcript as string | undefined) ?? '').trim()
      if (!itemId) return
      const item = this.getOrCreateItem(itemId)
      const text = finalText || item.source.trim()
      this.items.delete(itemId)
      if (text) {
        this.callbacks.onTranscript(itemId, text, null, item.startedAtAudioMs)
      }
    }
  }

  private handleTranslateEvent(type: string, evt: Record<string, unknown>): void {
    // The GA translation API emits ONLY delta events — no completion
    // event, no item_id. Each delta carries:
    //   - delta:      append-only text fragment
    //   - elapsed_ms: audio-time marker (multiple deltas may share
    //                 the same elapsed_ms; advances in ~200 ms steps)
    //   - event_id:   per-event unique id, NOT a phrase identifier
    // Phrase boundaries must be inferred client-side. We accumulate
    // source + target text into per-session buffers and finalize on
    // either (a) TRANSLATE_PHRASE_GAP_MS of silence since the last
    // delta from EITHER side, or (b) TRANSLATE_PHRASE_MAX_MS of
    // accumulated audio time, whichever comes first.
    const delta = (evt.delta as string | undefined) ?? ''
    const elapsedMs = (evt.elapsed_ms as number | undefined) ?? this.audioMs

    if (type === 'session.input_transcript.delta') {
      if (this.translateSourceBuf === '' && this.translateTargetBuf === '') {
        this.translatePhraseStartMs = elapsedMs
      }
      this.translateSourceBuf += delta
      log.local(
        `realtime[${this.source}] src+= ${JSON.stringify(delta)}  ↳  ${this.translateSourceBuf}`
      )
      this.scheduleTranslatePhraseFinalization(elapsedMs)
      return
    }
    if (type === 'session.output_transcript.delta') {
      if (this.translateSourceBuf === '' && this.translateTargetBuf === '') {
        this.translatePhraseStartMs = elapsedMs
      }
      this.translateTargetBuf += delta
      log.ai(
        `realtime[${this.source}] tgt+= ${JSON.stringify(delta)}  ↳  ${this.translateTargetBuf}`
      )
      this.scheduleTranslatePhraseFinalization(elapsedMs)
      return
    }
    if (type === 'session.closed') {
      // Flush whatever's still buffered before the connection goes
      // away — server-side close on long silence is normal.
      this.finalizeTranslatePhrase(elapsedMs)
      return
    }
    // session.output_audio.delta and other audio frames intentionally
    // ignored — we don't play back translated speech.
    void isPcm16Crash // keep helper imported even when unused
  }

  private scheduleTranslatePhraseFinalization(currentElapsedMs: number): void {
    if (this.translatePhraseTimer) clearTimeout(this.translatePhraseTimer)
    // Force-finalize if the phrase has run long. Server VAD chunks
    // are typically a few seconds; anything past 12 s is the model
    // mid-monologue and should be flushed for the live caption.
    if (currentElapsedMs - this.translatePhraseStartMs >= RealtimeSession.TRANSLATE_PHRASE_MAX_MS) {
      this.finalizeTranslatePhrase(currentElapsedMs)
      return
    }
    this.translatePhraseTimer = setTimeout(() => {
      this.translatePhraseTimer = null
      this.finalizeTranslatePhrase(currentElapsedMs)
    }, RealtimeSession.TRANSLATE_PHRASE_GAP_MS)
  }

  private finalizeTranslatePhrase(currentElapsedMs: number): void {
    const source = this.translateSourceBuf.trim()
    const target = this.translateTargetBuf.trim()
    const startMs = this.translatePhraseStartMs
    this.translateSourceBuf = ''
    this.translateTargetBuf = ''
    this.translatePhraseStartMs = currentElapsedMs
    if (!source && !target) return
    // Synthesize an itemId so onTranscript and onTranslation link to
    // the same persisted TranscriptEntry via audio-capture.ts's
    // RealtimeItemRef map.
    this.translatePhraseSeq++
    const itemId = `${this.source}-${this.translatePhraseSeq}-${startMs}`
    if (source) {
      this.callbacks.onTranscript(itemId, source, null, startMs)
    }
    if (target && this.callbacks.onTranslation && isUsefulTranslation(target)) {
      this.callbacks.onTranslation(itemId, target, startMs)
    }
  }
}

// A translation that's nothing but punctuation/whitespace or a single
// letter (".", ",", "a", "I") is almost always a stray model fragment
// from a previous phrase whose timing slipped into this bucket — not a
// real translation. Drop those; the source transcript still emits.
const TRANSLATION_MIN_USEFUL_CHARS = 2
const LETTER_OR_DIGIT_RE = /\p{L}|\p{N}/u
function isUsefulTranslation(text: string): boolean {
  let count = 0
  for (const ch of text) {
    if (LETTER_OR_DIGIT_RE.test(ch)) count++
    if (count >= TRANSLATION_MIN_USEFUL_CHARS) return true
  }
  return false
}
