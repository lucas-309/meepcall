import { app, BrowserWindow, globalShortcut, Notification } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import 'dotenv/config'

import { createWindow, getMainWindow, sendToRenderer } from './window'
import { initSDK } from './recall-sdk'
import { killAllHelpers, startAdHocRecording, stopManualRecording } from './audio-capture'
import { registerIpcHandlers } from './ipc'
import { ensureMeetingsFile } from './storage'
import { sdkLogger } from './sdk-logger'
import { log } from './log'
import { startServer } from './server'
import { state } from './state'
import { startAppWatcher } from './app-watcher'

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
  registerIpcHandlers()

  sdkLogger.onLog((entry) => {
    sendToRenderer('sdk-log', entry)
  })

  startServer()
  await initSDK()
  createWindow()
  startAppWatcher()

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
})
