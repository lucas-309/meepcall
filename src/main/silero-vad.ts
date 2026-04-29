import * as ort from 'onnxruntime-node'
import { resolveModelPath } from './assets'
import { log } from './log'

// Silero VAD v5 expects:
//   input  : float32 [1, FRAME_SAMPLES]   exactly 512 samples at 16 kHz (32 ms)
//   state  : float32 [2, 1, 128]          LSTM state, fed back across calls
//   sr     : int64   16000
// Outputs:
//   output : float32 [1, 1]               speech probability 0..1
//   stateN : float32 [2, 1, 128]          updated state
//
// We hold the session per source (mic / system) so each gets its own LSTM
// state. The session is shared across calls; only the state tensor cycles.

const SAMPLE_RATE = 16000
const FRAME_SAMPLES = 512
const FRAME_BYTES = FRAME_SAMPLES * 2 // Int16
export const FRAME_DURATION_MS = (FRAME_SAMPLES * 1000) / SAMPLE_RATE // 32 ms

let sharedSession: ort.InferenceSession | null = null
let loadingPromise: Promise<ort.InferenceSession> | null = null

async function getSession(): Promise<ort.InferenceSession> {
  if (sharedSession) return sharedSession
  if (loadingPromise) return loadingPromise
  const modelPath = resolveModelPath('silero-vad.onnx')
  log.local(`silero-vad: loading ${modelPath}`)
  loadingPromise = ort.InferenceSession.create(modelPath, {
    // CPU is plenty fast for 32 ms frames; avoids any GPU plumbing in
    // Electron's main process.
    executionProviders: ['cpu']
  })
  sharedSession = await loadingPromise
  log.local('silero-vad: ready')
  return sharedSession
}

export interface SileroVad {
  /**
   * Feed an Int16LE PCM buffer (any length). Returns one speech probability
   * per 32 ms frame. Leftover samples that didn't fill a full frame are
   * carried into the next call.
   */
  process(pcmInt16: Buffer): Promise<number[]>
  reset(): void
}

export async function createSileroVad(): Promise<SileroVad> {
  const session = await getSession()
  // LSTM state is [2, 1, 128] float32, init zero. Carried across calls.
  let state = new Float32Array(2 * 1 * 128)
  // Frame-builder buffer: leftover samples from previous call.
  let leftover = Buffer.alloc(0)

  const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), [])

  async function processFrame(frame: Float32Array): Promise<number> {
    const feeds: Record<string, ort.Tensor> = {
      input: new ort.Tensor('float32', frame, [1, FRAME_SAMPLES]),
      state: new ort.Tensor('float32', state, [2, 1, 128]),
      sr
    }
    const out = await session.run(feeds)
    // Copy ORT's returned data into our own owned buffer — the underlying
    // ArrayBufferLike type from the ORT API doesn't satisfy the strict
    // ArrayBuffer constraint we hold in `state`, and copying also avoids
    // sharing the buffer with the next inference call.
    state = new Float32Array(out.stateN.data as Float32Array)
    return (out.output.data as Float32Array)[0]
  }

  function int16ToFloat32(buf: Buffer, sampleCount: number): Float32Array {
    const out = new Float32Array(sampleCount)
    for (let i = 0; i < sampleCount; i++) {
      out[i] = buf.readInt16LE(i * 2) / 32768
    }
    return out
  }

  return {
    async process(pcmInt16: Buffer): Promise<number[]> {
      const merged = leftover.length > 0 ? Buffer.concat([leftover, pcmInt16]) : pcmInt16
      const totalSamples = Math.floor(merged.length / 2)
      const frameCount = Math.floor(totalSamples / FRAME_SAMPLES)
      const probs: number[] = []
      for (let i = 0; i < frameCount; i++) {
        const offset = i * FRAME_BYTES
        const frame = int16ToFloat32(merged.subarray(offset, offset + FRAME_BYTES), FRAME_SAMPLES)
        probs.push(await processFrame(frame))
      }
      // Carry remainder.
      const consumedBytes = frameCount * FRAME_BYTES
      leftover = consumedBytes < merged.length ? Buffer.from(merged.subarray(consumedBytes)) : Buffer.alloc(0)
      return probs
    },
    reset(): void {
      state = new Float32Array(2 * 1 * 128)
      leftover = Buffer.alloc(0)
    }
  }
}
