// NLLB-200 inference host. Runs in a forked child process so an
// onnxruntime crash (BFCArena allocation failure, decoder abort, etc.)
// kills only this worker — not the Electron main process and the active
// recording with it. Parent talks to us over the built-in IPC channel
// that child_process.fork() sets up: process.send() / 'message' events.
//
// Invoked from nllb-translate.ts via fork(scriptPath, { env: { ...,
// ELECTRON_RUN_AS_NODE: '1' } }) so Electron's Node binary can run this.
//
// Threading is constrained to keep memory pressure low — onnxruntime
// scales scratch buffers with intra_op_num_threads. Defaults can hit 8+
// threads per session × 2 sessions (encoder + decoder) on M-series.
// We pin to 1 thread because q8 quantized graphs trip BFCArena::Extend
// SIGTRAPs in onnxruntime-node 1.24.3 under any non-trivial threading;
// 1 thread eliminates the cross-thread arena fragmentation that triggers
// it. ~2-3x slower per line vs 2 threads but it doesn't crash.
//
// If 1 thread still crashes (specific input or accumulated state), flip
// MEEPCALL_NLLB_DTYPE=fp32 — proven stable, 3-5x slower, ~3.4 GB on disk
// vs ~700 MB for q8. Trade-off the user knows to make.

import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline, env } from '@huggingface/transformers'

const MODEL_ID = 'Xenova/nllb-200-distilled-600M'
const DTYPE = process.env.MEEPCALL_NLLB_DTYPE?.trim() || 'q8'

// Pin Transformers.js cache to a stable user-level path. Default cacheDir
// resolves INSIDE the transformers package in node_modules — that gets
// vacuumed by every `pnpm install` and never makes it into a packaged
// .app bundle, so a 700 MB download silently happens every fresh install
// (sometimes into 4+ GB worth of stale bytes). Keeping it in the user's
// home cache means it survives reinstalls and is shared across dev/prod.
// Path matches scripts/fetch-nllb-model.mjs so prefetched files are found.
const CACHE_DIR =
  process.env.MEEPCALL_NLLB_CACHE_DIR ||
  path.join(os.homedir(), '.cache', 'meepcall', 'nllb')
mkdirSync(CACHE_DIR, { recursive: true })
env.cacheDir = CACHE_DIR
env.allowLocalModels = true

let pipe = null
let pipeInit = null

async function getPipe() {
  if (pipe) return pipe
  if (pipeInit) return pipeInit
  pipeInit = (async () => {
    const t0 = Date.now()
    process.send?.({ type: 'log', level: 'info', msg: `Loading ${MODEL_ID} (${DTYPE}) in worker...` })
    const p = await pipeline('translation', MODEL_ID, {
      dtype: DTYPE,
      session_options: {
        intra_op_num_threads: 1,
        inter_op_num_threads: 1
      }
    })
    // Tiny warmup translation so the first real request isn't paying for
    // graph compilation latency.
    try {
      await p('hello', { src_lang: 'eng_Latn', tgt_lang: 'spa_Latn', max_new_tokens: 8 })
    } catch {
      // warmup failure is non-fatal
    }
    process.send?.({ type: 'log', level: 'info', msg: `NLLB-200 worker ready in ${Date.now() - t0}ms` })
    pipe = p
    return p
  })()
  return pipeInit
}

process.on('message', async (msg) => {
  if (!msg || msg.type !== 'translate') return
  const { id, text, src_lang, tgt_lang } = msg
  try {
    const p = await getPipe()
    const result = await p(text, {
      src_lang,
      tgt_lang,
      max_new_tokens: 256
    })
    const first = Array.isArray(result) ? result[0] : result
    const translation = (first?.translation_text ?? '').trim()
    process.send?.({ type: 'translation', id, translation })
  } catch (err) {
    process.send?.({
      type: 'translation',
      id,
      error: err?.message ?? String(err)
    })
  }
})

// Don't take down the worker on a single bad request — log, exit cleanly,
// the parent will restart. Exit code 1 distinguishes worker-fatal from
// graceful shutdown (code 0).
process.on('uncaughtException', (err) => {
  try {
    process.send?.({ type: 'fatal', error: err?.message ?? String(err) })
  } catch {
    // parent may already be gone
  }
  process.exit(1)
})

// Tell parent we're alive and ready to accept translation requests. Init
// happens lazily on first request so cold-start cost is paid by the line
// that needs it, not at startup.
process.send?.({ type: 'ready' })
