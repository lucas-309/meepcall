import { fork, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { app } from 'electron'
import { log } from './log'

// NLLB-200-distilled-600M via Transformers.js — runs entirely on-device,
// sub-200ms per short line on M-series, no API key, no network after the
// initial model download. Tradeoff vs Haiku: NLLB translates literal text
// without ASR-error correction or context-aware homophone recovery, so for
// noisy whisper output (Mandarin homophone soup, music) the Haiku path
// produces better results. NLLB excels at speed and offline use.
//
// Inference is hosted in a forked child process (scripts/nllb-worker.mjs),
// NOT in the Electron main process. onnxruntime can hit BFCArena allocation
// failures or internal aborts that propagate as uncaught C++ exceptions and
// crash the host — running in-process means the entire app dies mid-recording
// when this happens. The child takes the crash; main logs and respawns.
//
// q8 (int8) quantization is the right deploy target: ~840 MB on disk vs
// ~3.4 GB for fp32, and 2-3x faster on CPU. Pre-cache with `pnpm fetch:nllb-model`
// when switching to the local engine — it's NOT part of `pnpm prebuild:assets`
// because the local engine is opt-in via MEEPCALL_TRANSLATE_ENGINE=local
// and the 700 MB download shouldn't happen on every dev-env bootstrap.
// Cache lives at MEEPCALL_NLLB_CACHE_DIR (defaults to ~/.cache/meepcall/nllb);
// see scripts/nllb-worker.mjs for the env.cacheDir pin that prevents the
// runtime from writing into node_modules/.../.cache.

// whisper auto-detect outputs ISO 639-1 (en, zh, ja, ...). NLLB needs
// FLORES-200 codes (eng_Latn, zho_Hans, jpn_Jpan, ...). Map the most
// common ones whisper produces.
const WHISPER_TO_NLLB: Record<string, string> = {
  en: 'eng_Latn',
  zh: 'zho_Hans',
  ja: 'jpn_Jpan',
  ko: 'kor_Hang',
  es: 'spa_Latn',
  fr: 'fra_Latn',
  de: 'deu_Latn',
  ru: 'rus_Cyrl',
  ar: 'arb_Arab',
  hi: 'hin_Deva',
  pt: 'por_Latn',
  it: 'ita_Latn',
  vi: 'vie_Latn',
  th: 'tha_Thai',
  tr: 'tur_Latn',
  pl: 'pol_Latn',
  nl: 'nld_Latn',
  uk: 'ukr_Cyrl',
  he: 'heb_Hebr',
  el: 'ell_Grek',
  cs: 'ces_Latn',
  sv: 'swe_Latn',
  fi: 'fin_Latn',
  da: 'dan_Latn',
  no: 'nob_Latn',
  id: 'ind_Latn',
  ms: 'zsm_Latn',
  fa: 'pes_Arab',
  bn: 'ben_Beng',
  ta: 'tam_Taml',
  ur: 'urd_Arab'
}

// Fallback when whisper didn't tell us: cheap Unicode-block detection. Less
// granular than whisper but good enough for the languages people actually
// hit. Returns NLLB code or null.
function detectByScript(text: string): string | null {
  if (/[一-鿿㐀-䶿]/.test(text)) return 'zho_Hans'
  if (/[぀-ヿ]/.test(text)) return 'jpn_Jpan'
  if (/[가-힯]/.test(text)) return 'kor_Hang'
  if (/[Ѐ-ӿ]/.test(text)) return 'rus_Cyrl'
  if (/[؀-ۿݐ-ݿ]/.test(text)) return 'arb_Arab'
  if (/[֐-׿]/.test(text)) return 'heb_Hebr'
  if (/[ऀ-ॿ]/.test(text)) return 'hin_Deva'
  if (/[ঀ-৿]/.test(text)) return 'ben_Beng'
  if (/[஀-௿]/.test(text)) return 'tam_Taml'
  if (/[฀-๿]/.test(text)) return 'tha_Thai'
  if (/[Ͱ-Ͽ]/.test(text)) return 'ell_Grek'
  // Latin-with-diacritics: ambiguous (could be Spanish, French, German,
  // Portuguese, Italian, Polish...). Default to Spanish since it's the
  // most common in real-world ASR. NLLB tolerates source-language errors
  // reasonably well for closely-related Romance/Germanic languages.
  if (/[À-ÿĀ-ſ]/.test(text)) return 'spa_Latn'
  return null
}

// Worker lifecycle. Lazy-spawn on first translation, reuse for the lifetime
// of the app, restart up to MAX_RESTARTS times on crash. After the budget
// is exhausted we mark the engine permanently unavailable for this session
// rather than infinitely respawning a crashing worker.
const MAX_RESTARTS = 3
let worker: ChildProcess | null = null
let restartCount = 0
let permanentFailure = false

// Active dtype for the worker. Starts from the user's MEEPCALL_NLLB_DTYPE
// (default q8); on a q8 crash we promote it to fp32 once and keep that for
// the rest of the session. Passed explicitly into the fork's env so the
// child doesn't read a stale value from the parent's process.env.
let currentDtype = (process.env.MEEPCALL_NLLB_DTYPE?.trim() || 'q8').toLowerCase()
let fp32FallbackTriggered = false

// Crash signals that historically come from onnxruntime's BFCArena +
// quantized graph interactions (BFCArena::Extend abort path lands as one
// of these). Anything outside this set we treat as a generic crash and
// keep the existing dtype.
const Q8_CRASH_SIGNALS = new Set(['SIGTRAP', 'SIGABRT', 'SIGBUS', 'SIGSEGV'])

interface PendingRequest {
  resolve: (value: string | null) => void
  timer: NodeJS.Timeout
}
const pending = new Map<number, PendingRequest>()
let nextRequestId = 1

const REQUEST_TIMEOUT_MS = 15000

function workerScriptPath(): string {
  // In dev, scripts/ lives at the project root (cwd). In a packaged app,
  // electron-builder copies extraResources to <app>/Contents/Resources/.
  const isDev = !app.isPackaged
  const root = isDev ? process.cwd() : process.resourcesPath
  return join(root, 'scripts', 'nllb-worker.mjs')
}

function spawnWorker(): ChildProcess | null {
  if (permanentFailure) return null
  if (worker) return worker

  const scriptPath = workerScriptPath()
  let child: ChildProcess
  try {
    child = fork(scriptPath, [], {
      // ELECTRON_RUN_AS_NODE makes the Electron binary behave as a plain
      // Node process — required because process.execPath in main IS the
      // Electron binary and we need it to run our .mjs without GUI bits.
      // MEEPCALL_NLLB_DTYPE is set explicitly from `currentDtype` so the
      // auto-fallback path can promote q8 → fp32 between respawns.
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        MEEPCALL_NLLB_DTYPE: currentDtype
      },
      // Pipe stderr so module load errors surface in our logs.
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
  } catch (err) {
    log.err('ai', `NLLB worker spawn failed: ${(err as Error).message}`)
    permanentFailure = true
    return null
  }

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    if (text) log.warn('ai', `nllb-worker stderr: ${text.slice(0, 400)}`)
  })

  child.on('message', (msg: unknown) => {
    if (!msg || typeof msg !== 'object') return
    const m = msg as Record<string, unknown>
    if (m.type === 'ready') {
      log.ai('NLLB worker spawned')
    } else if (m.type === 'log' && typeof m.msg === 'string') {
      log.ai(m.msg)
    } else if (m.type === 'translation' && typeof m.id === 'number') {
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      clearTimeout(p.timer)
      if (typeof m.error === 'string') {
        log.warn('ai', `NLLB translation failed: ${m.error}`)
        p.resolve(null)
      } else if (typeof m.translation === 'string') {
        p.resolve(m.translation || null)
      } else {
        p.resolve(null)
      }
    } else if (m.type === 'fatal' && typeof m.error === 'string') {
      log.err('ai', `NLLB worker fatal: ${m.error}`)
    }
  })

  child.on('exit', (code, signal) => {
    worker = null
    // Reject all in-flight requests — the worker is gone and we can't
    // recover their state.
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.resolve(null)
    }
    pending.clear()

    const wasCrash = code !== 0 || signal !== null
    if (!wasCrash) {
      // Clean shutdown (e.g. app quit) — don't respawn.
      return
    }

    // Auto-fallback: q8 + a known onnxruntime-quantized-graph crash signal
    // is the BFCArena pattern. Promoting to fp32 once per session avoids
    // burning the restart budget on a configuration we already know to be
    // unstable — fp32 is bigger and slower but doesn't have the bug.
    // Restart count is intentionally NOT incremented for this transition;
    // if fp32 still crashes, the regular budget kicks in below.
    if (
      currentDtype === 'q8' &&
      !fp32FallbackTriggered &&
      typeof signal === 'string' &&
      Q8_CRASH_SIGNALS.has(signal)
    ) {
      fp32FallbackTriggered = true
      currentDtype = 'fp32'
      log.warn(
        'ai',
        `NLLB q8 worker crashed (signal=${signal}); auto-falling back to fp32 for the rest of this session. First request will pay a one-time download/load cost. Set MEEPCALL_NLLB_DTYPE=fp32 to skip the q8 attempt entirely on next launch.`
      )
      return
    }

    if (restartCount >= MAX_RESTARTS) {
      log.err(
        'ai',
        `NLLB worker crashed ${restartCount} times (code=${code} signal=${signal}); giving up. Translations from MEEPCALL_TRANSLATE_ENGINE=local will return null for the rest of this session.`
      )
      permanentFailure = true
      return
    }
    restartCount++
    log.warn(
      'ai',
      `NLLB worker exited (code=${code} signal=${signal}); restart ${restartCount}/${MAX_RESTARTS}. Next translation request will respawn it.`
    )
  })

  child.on('error', (err) => {
    log.err('ai', `NLLB worker error: ${err.message}`)
  })

  worker = child
  return child
}

function sendTranslateRequest(
  text: string,
  src_lang: string,
  tgt_lang: string
): Promise<string | null> {
  const child = spawnWorker()
  if (!child) return Promise.resolve(null)

  return new Promise<string | null>((resolve) => {
    const id = nextRequestId++
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        log.warn('ai', `NLLB translation timed out after ${REQUEST_TIMEOUT_MS}ms`)
        resolve(null)
      }
    }, REQUEST_TIMEOUT_MS)
    pending.set(id, { resolve, timer })
    try {
      child.send({ type: 'translate', id, text, src_lang, tgt_lang }, (err) => {
        if (err) {
          if (pending.delete(id)) {
            clearTimeout(timer)
            log.warn('ai', `NLLB worker.send failed: ${err.message}`)
            resolve(null)
          }
        }
      })
    } catch (err) {
      if (pending.delete(id)) {
        clearTimeout(timer)
        log.warn('ai', `NLLB worker.send threw: ${(err as Error).message}`)
        resolve(null)
      }
    }
  })
}

export async function translateLocal(
  text: string,
  whisperLang?: string
): Promise<string | null> {
  const fromWhisper = whisperLang ? WHISPER_TO_NLLB[whisperLang.toLowerCase()] : undefined
  const srcLang = fromWhisper ?? detectByScript(text)
  if (!srcLang) return null
  if (srcLang === 'eng_Latn') return text

  return sendTranslateRequest(text, srcLang, 'eng_Latn')
}

export function isLocalEngineAvailable(): boolean {
  return !permanentFailure
}

// Clean shutdown hook so the worker exits with the app instead of being
// orphaned (electron normally handles this, but explicit is better).
app.on('before-quit', () => {
  if (worker) {
    try {
      worker.kill('SIGTERM')
    } catch {
      // best-effort
    }
    worker = null
  }
})
