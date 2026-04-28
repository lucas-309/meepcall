import { app } from 'electron'
import { promises as fsp, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MeetingsData } from '@shared/types'

const EMPTY_DATA: MeetingsData = { upcomingMeetings: [], pastMeetings: [] }

let cached: MeetingsData | null = null
let lastReadTime = 0
let isProcessing = false

interface PendingOp {
  fn: (data: MeetingsData) => Promise<MeetingsData | null> | MeetingsData | null
  resolve: () => void
  reject: (err: unknown) => void
}

const pending: PendingOp[] = []

let _meetingsFilePath: string | null = null
function meetingsFilePath(): string {
  if (!_meetingsFilePath) _meetingsFilePath = join(app.getPath('userData'), 'meetings.json')
  return _meetingsFilePath
}

export function ensureMeetingsFile(): void {
  const p = meetingsFilePath()
  if (!existsSync(p)) {
    writeFileSync(p, JSON.stringify(EMPTY_DATA, null, 2))
  }
}

export async function readMeetingsData(): Promise<MeetingsData> {
  const now = Date.now()
  if (cached && now - lastReadTime < 500) {
    return JSON.parse(JSON.stringify(cached)) as MeetingsData
  }
  try {
    const raw = await fsp.readFile(meetingsFilePath(), 'utf8')
    const data = JSON.parse(raw) as MeetingsData
    cached = data
    lastReadTime = now
    return data
  } catch (err) {
    console.error('Error reading meetings data:', err)
    return { ...EMPTY_DATA }
  }
}

async function processQueue(): Promise<void> {
  if (pending.length === 0 || isProcessing) return
  isProcessing = true
  try {
    const next = pending.shift()!
    const current = await readMeetingsData()
    try {
      const updated = await next.fn(current)
      if (updated) {
        cached = updated
        lastReadTime = Date.now()
        await fsp.writeFile(meetingsFilePath(), JSON.stringify(updated, null, 2))
      }
      next.resolve()
    } catch (opErr) {
      next.reject(opErr)
    }
  } finally {
    isProcessing = false
    if (pending.length > 0) setImmediate(processQueue)
  }
}

export function scheduleOperation(
  fn: (data: MeetingsData) => Promise<MeetingsData | null> | MeetingsData | null
): Promise<void> {
  return new Promise((resolve, reject) => {
    pending.push({ fn, resolve, reject })
    if (!isProcessing) processQueue()
  })
}

export function writeMeetingsData(data: MeetingsData): Promise<void> {
  return scheduleOperation(() => data)
}
