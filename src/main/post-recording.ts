import { generateMeetingSummary } from './ai-summary'
import { log } from './log'
import { readMeetingsData, writeMeetingsData } from './storage'
import { sendToRenderer } from './window'

// Shared "after recording stops" pipeline used by both the Recall meeting flow
// and the local ScreenCaptureKit + whisper flow. Reads meeting from disk,
// finalizes recording metadata, optionally streams an AI summary, fires
// `recording-completed` so the renderer can re-render.
export async function runPostRecording(noteId: string): Promise<void> {
  const data = await readMeetingsData()
  const meeting = data.pastMeetings.find((m) => m.id === noteId)
  if (!meeting) {
    log.warn('audio', `runPostRecording: meeting not found for noteId=${noteId}`)
    return
  }

  const now = new Date()
  meeting.content = (meeting.content ?? '').replace(
    'Recording: In Progress...',
    `Recording: Completed at ${now.toLocaleString()}\n`
  )
  meeting.recordingComplete = true
  meeting.recordingEndTime = now.toISOString()
  await writeMeetingsData(data)

  if (meeting.transcript && meeting.transcript.length > 0) {
    const meetingTitle = meeting.title || 'Meeting Notes'
    meeting.content = `# ${meetingTitle}\nGenerating summary...`
    sendToRenderer('summary-update', { meetingId: meeting.id, content: meeting.content })

    const summary = await generateMeetingSummary(meeting, (currentText) => {
      meeting.content = `# ${meetingTitle}\n\n${currentText}`
      sendToRenderer('summary-update', {
        meetingId: meeting.id,
        content: meeting.content,
        timestamp: Date.now()
      })
    })

    meeting.content = summary
    meeting.hasSummary = true
    await writeMeetingsData(data)
  }

  sendToRenderer('recording-completed', meeting.id)
}
