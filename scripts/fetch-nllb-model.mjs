// Pre-download Xenova/nllb-200-distilled-600M (q8 quantized) into a stable,
// controlled cache directory so the runtime doesn't pay the first-call
// download tax. q8 weights are ~700 MB total vs ~3.4 GB for fp32 and run
// 2-3x faster on CPU — strictly the right deploy target for onnxruntime-node
// on macOS. Idempotent: Transformers.js sees cached files and skips
// re-downloading.
//
// Opt-in: this script is NOT in `prebuild:assets` because the local engine
// is opt-in via MEEPCALL_TRANSLATE_ENGINE=local. Run it explicitly with
// `pnpm fetch:nllb-model` when you want to switch to the local engine.
// If the download fails (offline, HF down, etc.) we don't fail the build —
// the user can still use the Haiku engine, and the runtime will retry on
// first use. Exits 0 on both success and graceful failure.
//
// Cache location: by default, `~/.cache/meepcall/nllb`. Override with
// MEEPCALL_NLLB_CACHE_DIR. Critically NOT package-local: Transformers.js'
// default `env.cacheDir` resolves to a `.cache/` folder INSIDE the
// transformers package in node_modules, which gets vacuumed by every
// `pnpm install` and never makes it into a packaged app bundle.

import os from 'node:os'
import path from 'node:path'
import { mkdirSync } from 'node:fs'

const MODEL_ID = 'Xenova/nllb-200-distilled-600M'
// Mirrors scripts/nllb-worker.mjs — same env knob picks the dtype here so
// the prefetched files match what the runtime will actually load.
const DTYPE = process.env.MEEPCALL_NLLB_DTYPE?.trim() || 'q8'
const CACHE_DIR =
  process.env.MEEPCALL_NLLB_CACHE_DIR ||
  path.join(os.homedir(), '.cache', 'meepcall', 'nllb')

let lastPct = -10
function onProgress(p) {
  if (p.status === 'progress' && typeof p.progress === 'number') {
    const pct = Math.floor(p.progress)
    if (pct >= lastPct + 5) {
      lastPct = pct
      const file = p.file ?? 'model'
      const mb = p.loaded ? `${(p.loaded / 1024 / 1024).toFixed(1)} MB` : ''
      process.stdout.write(`  ${file}: ${pct}% ${mb}\n`)
    }
  } else if (p.status === 'done') {
    lastPct = -10
    process.stdout.write(`  ${p.file ?? 'shard'}: done\n`)
  } else if (p.status === 'ready') {
    process.stdout.write(`  pipeline ready\n`)
  }
}

async function main() {
  const t0 = Date.now()
  mkdirSync(CACHE_DIR, { recursive: true })
  console.log(`Priming Transformers.js cache for ${MODEL_ID} (${DTYPE})...`)
  console.log(`(first run downloads ~700 MB to ${CACHE_DIR}, then idempotent)`)
  try {
    const { pipeline, env } = await import('@huggingface/transformers')
    // Pin cacheDir BEFORE any pipeline/model call so Transformers.js writes
    // into our controlled location instead of node_modules/.../.cache.
    env.cacheDir = CACHE_DIR
    env.allowLocalModels = true
    const p = await pipeline('translation', MODEL_ID, {
      dtype: DTYPE,
      progress_callback: onProgress
    })
    // Run a tiny throwaway translation so the tokenizer + decoder also warm up
    // and any lazy artifacts (special tokens, vocab) get pulled to disk.
    await p('hello', { src_lang: 'eng_Latn', tgt_lang: 'spa_Latn', max_new_tokens: 8 })
    console.log(`✓ NLLB-200 ready (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
    process.exit(0)
  } catch (err) {
    console.warn(`⚠ NLLB-200 prefetch failed: ${err?.message ?? err}`)
    console.warn('  Continuing — local translation will retry on first use.')
    process.exit(0)
  }
}

void main()
