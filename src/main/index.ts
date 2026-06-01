import { app, BrowserWindow, globalShortcut, Notification } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import 'dotenv/config'
import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici'

// Route Node's global fetch through an HTTP(S) proxy when one is configured.
// The Anthropic SDK (translation + AI summary) runs on Node's native fetch =
// undici, which — unlike curl — ignores the http_proxy/https_proxy env vars.
// On networks where api.anthropic.com is reachable only via a local proxy,
// that means every SDK call connects directly and gets a region 403
// (`{"error":{"type":"forbidden","message":"Request not allowed"}}`).
// EnvHttpProxyAgent reads http_proxy/https_proxy/no_proxy (case-insensitive)
// and dispatches accordingly; no_proxy keeps the localhost whisper-server
// calls direct. When no proxy var is set the agent is a passthrough — no-op.
setGlobalDispatcher(new EnvHttpProxyAgent({ noProxy: 'localhost,127.0.0.1,::1' }))

import { createWindow, getMainWindow, sendToRenderer } from './window'
import { initSDK } from './recall-sdk'
import { killAllHelpers, startAdHocRecording, stopManualRecording } from './audio-capture'
import { registerIpcHandlers } from './ipc'
import { cleanOrphanedRecordings, ensureMeetingsFile } from './storage'
import { sdkLogger } from './sdk-logger'
import { log } from './log'
import { startServer } from './server'
import { state } from './state'
import { startAppWatcher } from './app-watcher'
import { startWhisperServer, stopWhisperServer } from './whisper-server'

const WHISPER_MODEL = process.env.WHISPER_MODEL?.trim() || 'ggml-large-v3-turbo.bin'

const RECORD_HOTKEY = 'CommandOrControl+Shift+R'

async function toggleRecordingFromHotkey(): Promise<void> {
  const active = Object.entries(state.getAllRecordings())
  if (active.length > 0) {
    // Stop the most recently started recording
    const [recordingId] = active.sort(
      (a, b) => new Date(b[1].startTime).getTime() - new Date(a[1].startTime).getTime()
    )[0]
    log.local(`Hotkey: stopping recording ${recordingId.slice(0, 8)}…`)
    new Notification({
      title: 'Recall',
      body: 'Stopping recording…'
    }).show()
    await stopManualRecording(recordingId)
    return
  }

  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const label = `Quick recording — ${time}`
  log.local(`Hotkey: starting ad-hoc recording "${label}"`)
  new Notification({
    title: 'Recall',
    body: 'Recording started · Press ⌘⇧R again to stop'
  }).show()
  const result = await startAdHocRecording(label)
  if (!result.success) {
    new Notification({
      title: 'Recall — recording failed',
      body: result.error
    }).show()
    log.err('recall', 'Hotkey recording failed:', result.error)
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('ai.recall.recall')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  log.ok(
    'boot',
    `Recall starting · region=${process.env.RECALLAI_API_URL ?? '(unset)'} · key=${process.env.RECALLAI_API_KEY ? '✓' : '✗'} · anthropic=${process.env.ANTHROPIC_API_KEY ? '✓' : '✗'}`
  )

  ensureMeetingsFile()
  // Sweep out recordings that never got `recordingComplete: true` written —
  // Ctrl-C in dev, force-quit, crashes, anything that bypassed the normal
  // stop path. Must run BEFORE the renderer asks for meetings data so it
  // doesn't render a phantom row.
  cleanOrphanedRecordings()
  registerIpcHandlers()

  sdkLogger.onLog((entry) => {
    sendToRenderer('sdk-log', entry)
  })

  startServer()
  await initSDK()
  createWindow()
  startAppWatcher()

  // Warm-start the whisper.cpp HTTP server so the model is resident in
  // memory by the time the user hits ⌘⇧R. Without this, the first chunk
  // of every recording would pay the ~3-5 s cold model-load tax. We don't
  // await it — boot finishes immediately, the server keeps loading in the
  // background, and the first transcribeChunk() call awaits the same
  // promise. Set MEEPCALL_WHISPER_LAZY=1 to defer until first recording.
  if (process.env.MEEPCALL_WHISPER_LAZY !== '1') {
    void startWhisperServer(WHISPER_MODEL).catch((err) => {
      log.warn(
        'local',
        `whisper-server eager start failed: ${err.message}. Will retry on first recording.`
      )
    })
  }

  if (globalShortcut.register(RECORD_HOTKEY, () => void toggleRecordingFromHotkey())) {
    log.ok('hotkey', `Registered ${RECORD_HOTKEY} — toggles recording from anywhere`)
  } else {
    log.warn('hotkey', `Failed to register ${RECORD_HOTKEY} — another app may be holding it`)
  }

  const mainWindow = getMainWindow()
  mainWindow?.webContents.on('did-finish-load', () => {
    sendToRenderer('meeting-detection-status', {
      detected: state.detectedMeeting !== null
    })
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  killAllHelpers()
  stopWhisperServer()
})
