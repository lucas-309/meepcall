// whisper.cpp HTTP server lifecycle. One server PER SOURCE (mic, system) —
// each holds its own resident model context (1.6 GB each for turbo) so the
// two sources can run inference in parallel processes instead of
// serializing through one mutex-guarded context. The single-server design
// queued every system chunk behind the mic chunk and vice-versa, which
// pushed steady-state wall time per chunk above the 2 s arrival cadence
// and triggered backpressure drops on real-world (not benchmark) audio.
//
// Two processes contend on Metal, but the GPU dispatch overlap is much
// smaller than the per-request mutex, so end-to-end is closer to the
// per-chunk inference time (~1.2 s) than to 2× it.
//
// Lifecycle (per-key):
//   - startWhisperServer(modelName, key) is idempotent per key. First call
//     spawns + waits for the TCP port to accept; subsequent calls return
//     the same Promise.
//   - The promise resolves with the chosen port. Each instance picks the
//     next free port near DEFAULT_PORT independently so they don't collide.
//   - On crash/exit the per-key cached Promise is cleared so the next
//     caller respawns. Three crashes in a row for any single key marks
//     that server permanently dead for this session.
//   - stopWhisperServer() SIGTERMs every spawned child. Called from the
//     app's `will-quit` hook.

import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { resolveBinPath, resolveModelPath } from './assets'
import { log } from './log'

const HOST = '127.0.0.1'
const DEFAULT_PORT = 13379
// Cold model load can take ~3-5 s on first read (1.6 GB from disk), faster
// on subsequent runs from the OS page cache. 60 s is generous for any
// machine + cold-cache combination without hanging dev forever if the
// binary itself is broken.
const STARTUP_TIMEOUT_MS = 60000
const MAX_CRASH_RESTARTS = 3

interface ServerState {
  proc: ChildProcess
  port: number
}

const ready = new Map<string, Promise<ServerState>>()
const crashCount = new Map<string, number>()
const permanentlyDead = new Set<string>()

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.once('listening', () => s.close(() => resolve(true)))
    s.listen(port, HOST)
  })
}

async function findFreePort(start: number): Promise<number> {
  for (let p = start; p < start + 50; p++) {
    if (await isPortFree(p)) return p
  }
  throw new Error(`no free port in range ${start}..${start + 50}`)
}

export function isWhisperServerDead(key = 'shared'): boolean {
  return permanentlyDead.has(key)
}

export function startWhisperServer(
  modelName: string,
  key = 'shared'
): Promise<ServerState> {
  if (permanentlyDead.has(key)) {
    return Promise.reject(
      new Error(
        `whisper-server[${key}] crashed ${MAX_CRASH_RESTARTS} times this session; not respawning`
      )
    )
  }
  const cached = ready.get(key)
  if (cached) return cached

  const promise = (async () => {
    const port = await findFreePort(DEFAULT_PORT)
    const bin = resolveBinPath('whisper-server')
    const model = resolveModelPath(modelName)
    log.local(`whisper-server[${key}]: spawning on :${port} (model=${modelName})`)
    const child = spawn(
      bin,
      [
        '-m',
        model,
        '--host',
        HOST,
        '--port',
        String(port),
        // Two servers (mic + system) run in parallel; on a 12–15 core
        // M-series, 7 threads per server = 14 total leaves one core for
        // OS / Electron. Apple cores have no SMT so 1 thread per core is
        // optimal — pushing higher trades parallelism for context-switch
        // cost. Lower (6) was the previous default and bottlenecked at
        // ~5 s per chunk on M5 Pro because the encoder didn't get the
        // parallelism it needed; combined with audio-ctx below this drops
        // wall time to ~1 s.
        '--threads',
        '7',
        '--processors',
        '1',
        // audio-ctx 512 ≈ 10 s of mel-spec context. Whisper's encoder
        // otherwise pads to its full 30 s window even for 2 s chunks,
        // doing ~3× the encoder work it actually needs. THE single
        // biggest speedup for short-chunk live use; cuts inference to
        // roughly a third of the unflag'd default with no quality drop
        // for chunks < 5 s.
        '--audio-ctx',
        '512',
        // Disable temperature-fallback retry. On hard chunks (music, low
        // SNR) whisper otherwise re-decodes up to ~5× at increasing
        // temperatures, multiplying inference cost on exactly the chunks
        // most likely to hallucinate. Worse: those hot-sample retries
        // are where the worst nonsense (`*music*`, `Zither Harp`,
        // confident made-up sentences) comes from. Disabling makes the
        // decoder give up cleanly on those chunks instead.
        '--no-fallback',
        // Suppress non-speech tokens ([Music], [Applause], etc.) at the
        // decoder rather than emitting then filtering downstream.
        '--suppress-nst',
        // Greedy decode: best-of 1 = no candidate-ranking. Server's
        // default is 2; bumping down ~halves decoder work for an
        // imperceptible quality drop on real speech.
        '--best-of',
        '1',
        // Auto-detect language at startup. whisper-server's built-in
        // default is `en`, which model-initializes with English bias —
        // even though we pass `language=auto` per request, that startup
        // anchor visibly hurts Chinese / bilingual recognition. Setting
        // auto here ensures no language is privileged at the model level.
        '--language',
        'auto',
        '--inference-path',
        '/inference'
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )

    // Drain stderr so the pipe doesn't fill up; whisper-server prints
    // dozens of metal/init lines per startup. Surface only the unusual
    // ones (errors) so the dev terminal isn't spammed.
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      if (/error|fail|abort/i.test(text)) {
        log.warn('local', `whisper-server stderr: ${text.trim().slice(0, 400)}`)
      }
    })
    child.stdout.on('data', () => {
      /* drain — most stdout is model-load chatter */
    })

    return await new Promise<ServerState>((resolve, reject) => {
      let resolved = false
      let exited = false
      const timer = setTimeout(() => {
        if (resolved) return
        resolved = true
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        reject(new Error(`whisper-server startup timed out after ${STARTUP_TIMEOUT_MS}ms`))
      }, STARTUP_TIMEOUT_MS)

      child.on('exit', (code, signal) => {
        exited = true
        const wasReady = resolved
        if (!resolved) {
          resolved = true
          clearTimeout(timer)
          reject(
            new Error(
              `whisper-server[${key}] exited before ready (code=${code} signal=${signal})`
            )
          )
        }
        // Clear per-key cached promise so the next caller can respawn
        // (unless the per-key crash budget is exhausted).
        ready.delete(key)
        if (wasReady) {
          const next = (crashCount.get(key) ?? 0) + 1
          crashCount.set(key, next)
          log.warn(
            'local',
            `whisper-server[${key}] died (code=${code} signal=${signal}); crash ${next}/${MAX_CRASH_RESTARTS}`
          )
          if (next >= MAX_CRASH_RESTARTS) {
            permanentlyDead.add(key)
            log.err(
              'local',
              `whisper-server[${key}] crashed ${MAX_CRASH_RESTARTS} times; giving up for this source.`
            )
          }
        }
      })

      child.on('error', (err) => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        reject(new Error(`whisper-server[${key}] spawn error: ${err.message}`))
      })

      // Poll the TCP port. whisper-server doesn't emit a stable readiness
      // banner across versions, but the moment its http listener is up
      // we can connect to the port. ~250 ms poll interval keeps cold-load
      // wakeup tight without spamming the kernel.
      const POLL_INTERVAL_MS = 250
      const t0 = Date.now()
      const pollHandle: { ref: NodeJS.Timeout | null } = { ref: null }
      const poll = (): void => {
        if (resolved || exited) return
        const sock = net.connect(port, HOST)
        sock.once('connect', () => {
          sock.destroy()
          if (resolved) return
          resolved = true
          clearTimeout(timer)
          log.ok(
            'local',
            `whisper-server[${key}]: ready on http://${HOST}:${port} (${Date.now() - t0}ms boot)`
          )
          resolve({ proc: child, port })
        })
        sock.once('error', () => {
          sock.destroy()
          pollHandle.ref = setTimeout(poll, POLL_INTERVAL_MS)
        })
      }
      pollHandle.ref = setTimeout(poll, POLL_INTERVAL_MS)
    })
  })().catch((err) => {
    ready.delete(key)
    throw err
  })

  ready.set(key, promise)
  return promise
}

export function stopWhisperServer(): void {
  for (const promise of ready.values()) {
    void promise
      .then(({ proc }) => {
        try {
          proc.kill('SIGTERM')
        } catch {
          /* ignore */
        }
      })
      .catch(() => {
        /* server never came up — nothing to kill */
      })
  }
  ready.clear()
}

export function whisperServerUrl(port: number): string {
  return `http://${HOST}:${port}`
}
