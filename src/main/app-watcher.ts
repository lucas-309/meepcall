import { exec } from 'node:child_process'
import { log } from './log'
import { sendToRenderer } from './window'

// macOS app names (as shown in `name of process`) we treat as audio sources
// the Recall SDK doesn't natively detect. The keys are the canonical app names;
// the values are the human-friendly platform labels we surface to the user.
const COMM_APPS: Record<string, string> = {
  Discord: 'Discord',
  FaceTime: 'FaceTime',
  WhatsApp: 'WhatsApp',
  Telegram: 'Telegram',
  Signal: 'Signal',
  Skype: 'Skype',
  'Cisco Webex Meetings': 'Webex',
  Webex: 'Webex',
  'Microsoft Teams': 'Teams',
  Linphone: 'Linphone'
}

const POLL_INTERVAL_MS = 5_000

let timer: NodeJS.Timeout | null = null
let last: string[] = []

function listRunningApps(): Promise<string[]> {
  if (process.platform !== 'darwin') return Promise.resolve([])
  return new Promise((resolve) => {
    exec(
      'osascript -e \'tell application "System Events" to get name of (processes where background only is false)\'',
      { timeout: 2000 },
      (err, stdout) => {
        if (err) {
          resolve([])
          return
        }
        const names = stdout
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        resolve(names)
      }
    )
  })
}

async function poll(): Promise<void> {
  const running = await listRunningApps()
  const detected = running
    .filter((name) => name in COMM_APPS)
    .map((name) => COMM_APPS[name])

  // Stable comparison — avoid spamming the renderer on every poll
  const next = [...new Set(detected)].sort()
  const same = next.length === last.length && next.every((v, i) => v === last[i])
  if (!same) {
    log.recall(`Comm apps running: ${next.length === 0 ? '(none)' : next.join(', ')}`)
    sendToRenderer('comm-apps-running', next)
    last = next
  }
}

export function startAppWatcher(): void {
  if (timer) return
  if (process.platform !== 'darwin') {
    log.warn('watcher', 'App watcher only supported on macOS — skipping')
    return
  }
  log.ok('watcher', `Watching for comm apps every ${POLL_INTERVAL_MS / 1000}s`)
  void poll()
  timer = setInterval(() => void poll(), POLL_INTERVAL_MS)
}

export function stopAppWatcher(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
