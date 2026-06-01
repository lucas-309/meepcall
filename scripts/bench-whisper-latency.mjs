#!/usr/bin/env node
// Latency benchmark for the whisper-server pipeline. Spawns whisper-server
// with the same args the app uses, sends N inferences against a test WAV,
// and reports per-request wall-clock latency stats. Tests both cold and
// warm paths, with and without `--prompt`, so we can see the cost of the
// continuity prompt restored in src/main/whisper.ts.
//
// Run: node scripts/bench-whisper-latency.mjs [wavPath] [iterations]
// Defaults: /tmp/bench-en-2s.wav, 10 iterations.

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..')
const BIN = path.join(ROOT, 'build', 'bin', 'whisper-server')
const MODEL_NAME = process.env.WHISPER_MODEL || 'ggml-large-v3-turbo.bin'
const MODEL = path.join(ROOT, 'build', 'models', MODEL_NAME)
const HOST = '127.0.0.1'
const PORT = 13390
const ITERATIONS = Number(process.argv[3]) || 10
const WAV_PATH = process.argv[2] || '/tmp/bench-en-2s.wav'
const SAMPLE_PROMPT = '一条大河波浪宽 风吹稻花香两岸' // 30 chars Chinese, mimics realistic continuity prompt

function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.once('listening', () => s.close(() => resolve(true)))
    s.listen(port, HOST)
  })
}

async function findFreePort(start) {
  for (let p = start; p < start + 50; p++) {
    if (await isPortFree(p)) return p
  }
  throw new Error('no free port')
}

function waitForReady(port, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const poll = () => {
      const sock = net.connect(port, HOST)
      sock.once('connect', () => {
        sock.destroy()
        resolve(Date.now() - t0)
      })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() - t0 > timeoutMs) {
          reject(new Error('startup timeout'))
        } else setTimeout(poll, 100)
      })
    }
    setTimeout(poll, 100)
  })
}

function pct(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b)
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[i]
}

function summarize(label, samples) {
  const sum = samples.reduce((a, b) => a + b, 0)
  const mean = sum / samples.length
  console.log(
    `${label.padEnd(28)} n=${samples.length} mean=${mean.toFixed(0)}ms ` +
      `p50=${pct(samples, 50).toFixed(0)}ms p90=${pct(samples, 90).toFixed(0)}ms ` +
      `p99=${pct(samples, 99).toFixed(0)}ms min=${Math.min(...samples).toFixed(0)}ms ` +
      `max=${Math.max(...samples).toFixed(0)}ms`
  )
}

async function inferOnce(port, wav, opts = {}) {
  const fd = new FormData()
  fd.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'chunk.wav')
  fd.append('response_format', 'verbose_json')
  fd.append('temperature', '0')
  fd.append('language', opts.language || 'auto')
  fd.append('no_speech_thold', '0.6')
  fd.append('threads', '6')
  if (opts.prompt) fd.append('prompt', opts.prompt)

  const t0 = Date.now()
  const resp = await fetch(`http://${HOST}:${port}/inference`, {
    method: 'POST',
    body: fd
  })
  if (!resp.ok) {
    throw new Error(`http ${resp.status}: ${await resp.text()}`)
  }
  const json = await resp.json()
  const dt = Date.now() - t0
  return { dt, lang: json.language, segments: json.segments?.length ?? 0 }
}

async function main() {
  console.log(`bench: model=${MODEL_NAME} wav=${WAV_PATH} iterations=${ITERATIONS}`)

  const wav = await readFile(WAV_PATH)
  console.log(`bench: loaded wav (${wav.length} bytes)`)

  const port = await findFreePort(PORT)
  console.log(`bench: spawning whisper-server on :${port}`)

  // Mirror the flags whisper-server.ts spawns with so the bench reflects
  // production behavior — most importantly --audio-ctx 512 which roughly
  // 3× speeds up short-chunk inference by capping the encoder window.
  const child = spawn(
    BIN,
    [
      '-m',
      MODEL,
      '--host',
      HOST,
      '--port',
      String(port),
      '--threads',
      '7',
      '--processors',
      '1',
      '--audio-ctx',
      '512',
      '--no-fallback',
      '--suppress-nst',
      '--best-of',
      '1',
      '--inference-path',
      '/inference'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  child.stderr.on('data', () => {})
  child.stdout.on('data', () => {})

  try {
    const bootMs = await waitForReady(port)
    console.log(`bench: server ready in ${bootMs}ms\n`)

    // Warmup — first request pays model first-decode tax (kernel warmup,
    // metal shader compile). Discard.
    console.log('bench: warmup (1 request, discarded)…')
    const warm = await inferOnce(port, wav)
    console.log(`bench: warmup ${warm.dt}ms (lang=${warm.lang} segs=${warm.segments})\n`)

    // Run A: no prompt, language=auto (matches first-chunk behavior in app)
    const noPrompt = []
    for (let i = 0; i < ITERATIONS; i++) {
      const r = await inferOnce(port, wav, { language: 'auto' })
      noPrompt.push(r.dt)
    }
    summarize('no-prompt auto', noPrompt)

    // Run B: with prompt, language=auto (matches steady-state app behavior)
    const withPrompt = []
    for (let i = 0; i < ITERATIONS; i++) {
      const r = await inferOnce(port, wav, { language: 'auto', prompt: SAMPLE_PROMPT })
      withPrompt.push(r.dt)
    }
    summarize('with-prompt auto', withPrompt)

    // Run C: no prompt, language=en (faster — skips lang detection)
    const noPromptEn = []
    for (let i = 0; i < ITERATIONS; i++) {
      const r = await inferOnce(port, wav, { language: 'en' })
      noPromptEn.push(r.dt)
    }
    summarize('no-prompt en', noPromptEn)

    // Run D: with prompt, language=en
    const withPromptEn = []
    for (let i = 0; i < ITERATIONS; i++) {
      const r = await inferOnce(port, wav, { language: 'en', prompt: SAMPLE_PROMPT })
      withPromptEn.push(r.dt)
    }
    summarize('with-prompt en', withPromptEn)

    const meanNoPrompt = noPrompt.reduce((a, b) => a + b, 0) / noPrompt.length
    const meanWithPrompt = withPrompt.reduce((a, b) => a + b, 0) / withPrompt.length
    const overhead = ((meanWithPrompt - meanNoPrompt) / meanNoPrompt) * 100
    console.log(
      `\nprompt overhead (auto): ${(meanWithPrompt - meanNoPrompt).toFixed(0)}ms (${overhead >= 0 ? '+' : ''}${overhead.toFixed(1)}%)`
    )

    // Run E: TWO concurrent clients (mic + system), simulating the real
    // app where both sources hit the single server in parallel.
    console.log('\nbench: 2 concurrent clients on ONE server (old behavior)…')
    const concurrentMic = []
    const concurrentSys = []
    for (let i = 0; i < ITERATIONS; i++) {
      const [a, b] = await Promise.all([
        inferOnce(port, wav, { language: 'auto', prompt: SAMPLE_PROMPT }),
        inferOnce(port, wav, { language: 'auto', prompt: SAMPLE_PROMPT })
      ])
      concurrentMic.push(a.dt)
      concurrentSys.push(b.dt)
    }
    summarize('1-server client A', concurrentMic)
    summarize('1-server client B', concurrentSys)

    // Run F: TWO servers, one client each, in parallel. Mirrors the new
    // per-source server architecture.
    console.log('\nbench: spawning second server for parallel test…')
    const port2 = await findFreePort(port + 1)
    const child2 = spawn(
      BIN,
      [
        '-m',
        MODEL,
        '--host',
        HOST,
        '--port',
        String(port2),
        '--threads',
        '7',
        '--processors',
        '1',
        '--audio-ctx',
        '512',
        '--no-fallback',
        '--suppress-nst',
        '--best-of',
        '1',
        '--inference-path',
        '/inference'
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    child2.stderr.on('data', () => {})
    child2.stdout.on('data', () => {})
    try {
      const boot2 = await waitForReady(port2)
      console.log(`bench: server #2 ready in ${boot2}ms`)
      // Warmup #2
      await inferOnce(port2, wav, { language: 'auto' })

      const parA = []
      const parB = []
      for (let i = 0; i < ITERATIONS; i++) {
        const [a, b] = await Promise.all([
          inferOnce(port, wav, { language: 'auto', prompt: SAMPLE_PROMPT }),
          inferOnce(port2, wav, { language: 'auto', prompt: SAMPLE_PROMPT })
        ])
        parA.push(a.dt)
        parB.push(b.dt)
      }
      summarize('2-server client A', parA)
      summarize('2-server client B', parB)
    } finally {
      child2.kill('SIGTERM')
    }
  } finally {
    child.kill('SIGTERM')
  }
}

main().catch((err) => {
  console.error('bench failed:', err)
  process.exit(1)
})
