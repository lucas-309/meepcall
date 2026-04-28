import express from 'express'
import { log } from './log'

const RECALLAI_API_URL = process.env.RECALLAI_API_URL ?? 'https://api.recall.ai'

interface UploadTokenResponse {
  status: 'success' | 'error'
  upload_token?: string
  message?: string
}

export async function mintUploadToken(): Promise<UploadTokenResponse> {
  const apiKey = process.env.RECALLAI_API_KEY
  if (!apiKey) {
    log.err('server', 'RECALLAI_API_KEY is missing')
    return { status: 'error', message: 'RECALLAI_API_KEY is missing' }
  }
  log.server(`Minting upload token via ${RECALLAI_API_URL}…`)

  const url = `${RECALLAI_API_URL}/api/v1/sdk_upload/`
  const body = {
    recording_config: {
      transcript: {
        provider: {
          recallai_streaming: {
            language_code: 'en',
            mode: 'prioritize_low_latency'
          }
        }
      },
      realtime_endpoints: [
        {
          type: 'desktop_sdk_callback',
          events: [
            'participant_events.join',
            'video_separate_png.data',
            'transcript.data',
            'transcript.provider_data'
          ]
        }
      ]
    }
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(9000)
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      log.err('server', `Upload token request failed: ${res.status}`, errText)
      return { status: 'error', message: `HTTP ${res.status}: ${errText}` }
    }
    const data = (await res.json()) as { upload_token: string }
    log.ok('server', `Upload token minted (${data.upload_token.slice(0, 8)}…)`)
    return { status: 'success', upload_token: data.upload_token }
  } catch (err) {
    const e = err as Error
    log.err('server', 'Error minting upload token:', e.message)
    return { status: 'error', message: e.message }
  }
}

export function createServer(): express.Express {
  const app = express()
  app.get('/start-recording', async (_req, res) => {
    const result = await mintUploadToken()
    res.json(result)
  })
  return app
}

export function startServer(port = 13373): void {
  const app = createServer()
  app.listen(port, () => {
    log.server(`Upload-token server listening on http://localhost:${port}`)
  })
}
