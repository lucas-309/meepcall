import { ipcMain } from 'electron'
import { joinDetectedMeeting } from './recall-sdk'
import { startAdHocRecording, startManualRecording, stopManualRecording } from './audio-capture'
import { generateMeetingSummary } from './ai-summary'
import { readMeetingsData, scheduleOperation, writeMeetingsData } from './storage'
import { state } from './state'
import { sendToRenderer } from './window'
import type { MeetingsData } from '@shared/types'

export function registerIpcHandlers(): void {
  ipcMain.on('navigate', (_event, _page: string) => {
    // Single-window React app — navigation is in-renderer; this is a no-op stub
    // for parity with Muesli's IPC channel.
  })

  ipcMain.on('sdk-log', (_event, _logEntry) => {
    sendToRenderer('sdk-log', _logEntry)
  })

  ipcMain.handle('saveMeetingsData', async (_event, data: MeetingsData) => {
    try {
      await writeMeetingsData(data)
      return { success: true as const }
    } catch (err) {
      const e = err as Error
      return { success: false as const, error: e.message }
    }
  })

  ipcMain.handle('loadMeetingsData', async () => {
    try {
      const data = await readMeetingsData()
      return { success: true as const, data }
    } catch (err) {
      const e = err as Error
      return { success: false as const, error: e.message }
    }
  })

  ipcMain.handle('deleteMeeting', async (_event, meetingId: string) => {
    try {
      let deleted = false
      let recordingId: string | undefined
      await scheduleOperation((data) => {
        const past = data.pastMeetings.findIndex((m) => m.id === meetingId)
        const upcoming = data.upcomingMeetings.findIndex((m) => m.id === meetingId)
        if (past !== -1) {
          recordingId = data.pastMeetings[past].recordingId
          data.pastMeetings.splice(past, 1)
          deleted = true
        }
        if (upcoming !== -1) {
          recordingId = recordingId ?? data.upcomingMeetings[upcoming].recordingId
          data.upcomingMeetings.splice(upcoming, 1)
          deleted = true
        }
        return deleted ? data : null
      })

      if (!deleted) return { success: false as const, error: 'Meeting not found' }

      if (recordingId && state.activeMeetingIds[recordingId]) {
        delete state.activeMeetingIds[recordingId]
      }
      return { success: true as const }
    } catch (err) {
      const e = err as Error
      return { success: false as const, error: e.message }
    }
  })

  ipcMain.handle('generateMeetingSummary', async (_event, meetingId: string) => {
    try {
      const data = await readMeetingsData()
      const meeting = data.pastMeetings.find((m) => m.id === meetingId)
      if (!meeting) return { success: false as const, error: 'Meeting not found' }
      if (!meeting.transcript || meeting.transcript.length === 0) {
        return { success: false as const, error: 'No transcript available' }
      }

      const summary = await generateMeetingSummary(meeting)
      const meetingTitle = meeting.title || 'Meeting Notes'
      meeting.content = `# ${meetingTitle}\n\n${summary}`
      meeting.hasSummary = true
      await writeMeetingsData(data)
      sendToRenderer('summary-generated', meetingId)
      return { success: true as const, summary }
    } catch (err) {
      const e = err as Error
      return { success: false as const, error: e.message }
    }
  })

  ipcMain.handle('generateMeetingSummaryStreaming', async (_event, meetingId: string) => {
    try {
      const data = await readMeetingsData()
      const meeting = data.pastMeetings.find((m) => m.id === meetingId)
      if (!meeting) return { success: false as const, error: 'Meeting not found' }
      if (!meeting.transcript || meeting.transcript.length === 0) {
        return { success: false as const, error: 'No transcript available' }
      }

      const meetingTitle = meeting.title || 'Meeting Notes'
      meeting.content = `# ${meetingTitle}\n\nGenerating summary...`
      sendToRenderer('summary-update', { meetingId, content: meeting.content })

      const summary = await generateMeetingSummary(meeting, (currentText) => {
        meeting.content = `# ${meetingTitle}\n\n## AI-Generated Meeting Summary\n${currentText}`
        sendToRenderer('summary-update', {
          meetingId,
          content: meeting.content,
          timestamp: Date.now()
        })
      })

      meeting.content = `# ${meetingTitle}\n\n${summary}`
      meeting.hasSummary = true
      await writeMeetingsData(data)
      sendToRenderer('summary-generated', meetingId)
      return { success: true as const, summary }
    } catch (err) {
      const e = err as Error
      return { success: false as const, error: e.message }
    }
  })

  ipcMain.handle('startManualRecording', async (_event, meetingId: string) =>
    startManualRecording(meetingId)
  )

  ipcMain.handle('startAdHocRecording', async (_event, label?: string) =>
    startAdHocRecording(label)
  )

  ipcMain.handle('stopManualRecording', async (_event, recordingId: string) =>
    stopManualRecording(recordingId)
  )

  ipcMain.handle('checkForDetectedMeeting', () => state.detectedMeeting !== null)

  ipcMain.handle('joinDetectedMeeting', () => joinDetectedMeeting())

  ipcMain.handle('getActiveRecordingId', (_event, noteId?: string) => {
    try {
      if (noteId) {
        return { success: true as const, data: state.getRecordingForNote(noteId) }
      }
      return { success: true as const, data: state.getAllRecordings() }
    } catch (err) {
      const e = err as Error
      return { success: false as const, error: e.message }
    }
  })

  ipcMain.handle('debugGetHandlers', () => {
    // Best-effort; ipcMain has no public API to enumerate handlers
    return Object.keys(
      (ipcMain as unknown as { _invokeHandlers?: Record<string, unknown> })._invokeHandlers ?? {}
    )
  })
}
