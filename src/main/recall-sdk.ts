import { Notification } from 'electron'
import RecallAiSdk, {
  type ErrorEvent as SdkErrorEvent,
  type MeetingClosedEvent,
  type MeetingDetectedEvent,
  type MeetingUpdatedEvent,
  type RealtimeEvent,
  type RecordingStartEvent,
  type RecordingStopEvent
} from '@recallai/desktop-sdk'
import type { Meeting, VideoFrameMessage } from '@shared/types'
import { sdkLogger } from './sdk-logger'
import { log } from './log'
import { state } from './state'
import {
  readMeetingsData,
  scheduleOperation,
  writeMeetingsData
} from './storage'
import { generateMeetingSummary } from './ai-summary'
import { mintUploadToken } from './server'
import { createWindow, focusMainWindow, getMainWindow, sendToRenderer } from './window'

const PLATFORM_NAMES: Record<string, string> = {
  zoom: 'Zoom',
  'google-meet': 'Google Meet',
  slack: 'Slack',
  teams: 'Microsoft Teams'
}

let currentUnknownSpeaker = -1

export async function initSDK(): Promise<void> {
  log.recall('Initializing Recall.ai SDK', { api_url: process.env.RECALLAI_API_URL })
  sdkLogger.logApiCall('init', { api_url: process.env.RECALLAI_API_URL })

  await RecallAiSdk.init({
    api_url: process.env.RECALLAI_API_URL,
    acquirePermissionsOnStartup: ['accessibility', 'screen-capture', 'microphone']
  })

  RecallAiSdk.addEventListener('meeting-detected', (evt: MeetingDetectedEvent) => {
    log.recall(
      `Meeting DETECTED: platform=${evt.window.platform} window=${evt.window.id.slice(0, 8)}…`
    )
    sdkLogger.logEvent('meeting-detected', {
      platform: evt.window.platform,
      windowId: evt.window.id
    })

    state.detectedMeeting = evt
    const platformName =
      PLATFORM_NAMES[evt.window.platform ?? ''] ?? evt.window.platform ?? 'Unknown'

    const notification = new Notification({
      title: `${platformName} Meeting Detected`,
      body: platformName
    })
    notification.on('click', () => {
      void joinDetectedMeeting()
    })
    notification.show()

    sendToRenderer('meeting-detection-status', { detected: true })
  })

  RecallAiSdk.addEventListener('meeting-updated', async (evt: MeetingUpdatedEvent) => {
    const { window } = evt
    log.recall(`Meeting UPDATED: title="${window.title ?? '(none)'}" url=${window.url ?? '(none)'}`)
    sdkLogger.logEvent('meeting-updated', {
      platform: window.platform,
      windowId: window.id,
      title: window.title,
      url: window.url
    })

    if (state.detectedMeeting && state.detectedMeeting.window.id === window.id) {
      state.detectedMeeting = {
        ...state.detectedMeeting,
        window: { ...state.detectedMeeting.window, title: window.title, url: window.url }
      }

      const tracking = state.activeMeetingIds[window.id]
      if (window.title && tracking?.noteId) {
        const noteId = tracking.noteId
        try {
          const data = await readMeetingsData()
          const meeting = data.pastMeetings.find((m) => m.id === noteId)
          if (meeting) {
            const oldTitle = meeting.title
            meeting.title = window.title
            await writeMeetingsData(data)
            log.recall(`Title rename: "${oldTitle}" → "${window.title}"`)
            sendToRenderer('meeting-title-updated', {
              meetingId: noteId,
              newTitle: window.title
            })
          }
        } catch (err) {
          log.err('recall', 'Error updating meeting title:', err)
        }
      }
    }
  })

  RecallAiSdk.addEventListener('meeting-closed', (evt: MeetingClosedEvent) => {
    log.recall(`Meeting CLOSED: window=${evt.window.id.slice(0, 8)}…`)
    sdkLogger.logEvent('meeting-closed', { windowId: evt.window.id })
    if (evt.window.id && state.activeMeetingIds[evt.window.id]) {
      delete state.activeMeetingIds[evt.window.id]
    }
    state.detectedMeeting = null
    sendToRenderer('meeting-detection-status', { detected: false })
  })

  RecallAiSdk.addEventListener('recording-started', (evt: RecordingStartEvent) => {
    const { window } = evt
    if (!window?.id) return
    const tracking = state.activeMeetingIds[window.id]
    log.ok(
      'recall',
      `Recording STARTED: window=${window.id.slice(0, 8)}… note=${tracking?.noteId ?? '(none)'}`
    )
    if (tracking?.noteId) {
      state.addRecording(window.id, tracking.noteId, window.platform ?? 'unknown')
    }
  })

  RecallAiSdk.addEventListener('recording-ended', async (evt: RecordingStopEvent) => {
    log.recall(`Recording ENDED: window=${evt.window.id.slice(0, 8)}…`)
    sdkLogger.logEvent('recording-ended', { windowId: evt.window.id })
    try {
      await updateNoteWithRecordingInfo(evt.window.id)
    } catch (err) {
      log.err('recall', 'Error handling recording-ended:', err)
    }
    if (evt.window.id) state.removeRecording(evt.window.id)
  })

  RecallAiSdk.addEventListener('permissions-granted', () => {
    log.ok('recall', 'Permissions granted (accessibility + screen-capture + microphone)')
  })

  RecallAiSdk.addEventListener('realtime-event', (evt: RealtimeEvent) => {
    if (evt.event !== 'video_separate_png.data') {
      log.recall(`Realtime event: ${evt.event}`)
      sdkLogger.logEvent('realtime-event', {
        eventType: evt.event,
        windowId: evt.window?.id
      })
    }

    if (evt.event === 'transcript.data') {
      void processTranscriptData(evt)
    } else if (evt.event === 'transcript.provider_data') {
      processTranscriptProviderData(evt)
    } else if (evt.event === 'participant_events.join') {
      void processParticipantJoin(evt)
    } else if (evt.event === 'video_separate_png.data') {
      processVideoFrame(evt)
    }
  })

  RecallAiSdk.addEventListener('error', (evt: SdkErrorEvent) => {
    log.err('recall', `SDK error: type=${evt.type} message=${evt.message}`)
    sdkLogger.logEvent('error', { errorType: evt.type, errorMessage: evt.message })
    new Notification({
      title: 'Recording Error',
      body: `Error: ${evt.type} - ${evt.message}`
    }).show()
  })
}

function processTranscriptProviderData(evt: RealtimeEvent): void {
  try {
    const speaker = evt.data?.data?.data?.payload?.channel?.alternatives?.[0]?.words?.[0]?.speaker
    if (speaker !== undefined) currentUnknownSpeaker = speaker
  } catch {
    /* ignore */
  }
}

async function processTranscriptData(evt: RealtimeEvent): Promise<void> {
  const windowId = evt.window?.id
  const evtData = evt.data?.data
  const words: { text: string }[] = evtData?.words ?? []

  // Always echo any transcript-data event to the terminal, even when the
  // event is malformed or there is no note tracking — this is the best
  // signal that the SDK + provider are alive end-to-end.
  if (words.length === 0) {
    log.recall(
      `Transcript event received but no words. Raw: ${JSON.stringify(evt.data).slice(0, 300)}`
    )
    return
  }

  const participantName: string | undefined = evtData?.participant?.name
  let speaker: string
  if (participantName && participantName !== 'Host' && participantName !== 'Guest') {
    speaker = participantName
  } else if (currentUnknownSpeaker !== -1) {
    speaker = `Speaker ${currentUnknownSpeaker}`
  } else {
    speaker = 'Unknown Speaker'
  }

  const text = words.map((w) => w.text).join(' ')

  // Print every transcript line to terminal unconditionally — the request
  // was: "just output all the transcription, even if it's not in the UI".
  log.recall(`Transcript [${speaker}]: ${text}`)

  if (!windowId) return
  const tracking = state.activeMeetingIds[windowId]
  if (!tracking?.noteId) {
    log.warn(
      'recall',
      `Transcript has no linked note (window=${windowId.slice(0, 8)}…) — terminal-only`
    )
    return
  }
  const noteId = tracking.noteId

  await scheduleOperation((data) => {
    const meeting = data.pastMeetings.find((m) => m.id === noteId)
    if (!meeting) return null
    if (!meeting.transcript) meeting.transcript = []
    meeting.transcript.push({ text, speaker, timestamp: new Date().toISOString() })
    sendToRenderer('transcript-updated', noteId)
    return data
  })
}

async function processParticipantJoin(evt: RealtimeEvent): Promise<void> {
  const windowId = evt.window?.id
  if (!windowId) return
  const tracking = state.activeMeetingIds[windowId]
  if (!tracking?.noteId) return
  const noteId = tracking.noteId

  const participant = evt.data?.data?.participant
  if (!participant) return

  const name: string = participant.name ?? 'Unknown Participant'
  const id: string = participant.id
  const isHost: boolean = participant.is_host ?? false
  const platform: string | undefined = participant.platform

  if (
    name === 'Host' ||
    name === 'Guest' ||
    name.includes('others') ||
    name.split(' ').length > 3
  ) {
    return
  }

  log.recall(`Participant joined: ${name}${isHost ? ' (host)' : ''}`)
  await scheduleOperation((data) => {
    const meeting = data.pastMeetings.find((m) => m.id === noteId)
    if (!meeting) return null
    if (!meeting.participants) meeting.participants = []
    const existing = meeting.participants.findIndex((p) => p.id === id)
    const entry = {
      id,
      name,
      isHost,
      platform,
      joinTime: new Date().toISOString(),
      status: 'active' as const
    }
    if (existing !== -1) meeting.participants[existing] = entry
    else meeting.participants.push(entry)
    sendToRenderer('participants-updated', noteId)
    return data
  })
}

function processVideoFrame(evt: RealtimeEvent): void {
  const windowId = evt.window?.id
  if (!windowId) return
  const tracking = state.activeMeetingIds[windowId]
  if (!tracking?.noteId) return
  const noteId = tracking.noteId

  const frameData = evt.data?.data
  if (!frameData?.buffer) return

  const message: VideoFrameMessage = {
    noteId,
    participantId: frameData.participant?.id,
    participantName: frameData.participant?.name ?? 'Unknown',
    frameType: frameData.type,
    buffer: frameData.buffer,
    timestamp: frameData.timestamp ?? {}
  }
  sendToRenderer('video-frame', message)
}

async function updateNoteWithRecordingInfo(recordingId: string): Promise<void> {
  const data = await readMeetingsData()
  const meeting = data.pastMeetings.find((m) => m.recordingId === recordingId)
  if (!meeting) {
    console.log('No meeting note found for recording ID:', recordingId)
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

export async function createMeetingNoteAndRecord(platformName: string): Promise<string | null> {
  if (!state.detectedMeeting) {
    console.error('No active meeting detected')
    return null
  }
  const detected = state.detectedMeeting
  const windowId = detected.window.id

  const existing = state.activeMeetingIds[windowId]
  if (existing?.noteId) {
    log.warn('recall', `Duplicate join — returning existing note ${existing.noteId}`)
    return existing.noteId
  }

  state.activeMeetingIds[windowId] = { platformName }

  const data = await readMeetingsData()

  const id = `meeting-${Date.now()}`
  const now = new Date()
  const meetingTitle =
    detected.window.title ||
    `${platformName} Meeting - ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`

  const newMeeting: Meeting = {
    id,
    type: 'document',
    title: meetingTitle,
    subtitle: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    hasDemo: false,
    date: now.toISOString(),
    participants: [],
    content: `# ${meetingTitle}\nRecording: In Progress...`,
    recordingId: windowId,
    platform: platformName,
    transcript: []
  }

  state.activeMeetingIds[windowId].noteId = id
  state.addRecording(windowId, id, platformName)
  data.pastMeetings.unshift(newMeeting)
  await writeMeetingsData(data)

  log.recall(`Created note ${id} for ${platformName} (window=${windowId.slice(0, 8)}…)`)
  setTimeout(() => sendToRenderer('open-meeting-note', id), 1500)

  try {
    const uploadData = await mintUploadToken()
    if (uploadData.status === 'success' && uploadData.upload_token) {
      sdkLogger.logApiCall('startRecording', {
        windowId,
        uploadToken: `${uploadData.upload_token.slice(0, 8)}...`
      })
      log.recall(`Calling startRecording (token=${uploadData.upload_token.slice(0, 8)}…)`)
      await RecallAiSdk.startRecording({ windowId, uploadToken: uploadData.upload_token })
    } else {
      log.err('recall', 'No upload token; cannot start recording')
    }
  } catch (err) {
    log.err('recall', 'Error starting recording:', err)
  }

  return id
}

export async function joinDetectedMeeting(): Promise<{
  success: boolean
  meetingId?: string
  error?: string
}> {
  if (!state.detectedMeeting) {
    return { success: false, error: 'No active meeting detected' }
  }
  const platform = state.detectedMeeting.window.platform ?? 'Unknown'
  const platformName = PLATFORM_NAMES[platform] ?? platform

  if (!getMainWindow()) {
    createWindow()
  } else {
    focusMainWindow()
  }

  return await new Promise((resolve) => {
    setTimeout(async () => {
      try {
        const id = await createMeetingNoteAndRecord(platformName)
        if (id) resolve({ success: true, meetingId: id })
        else resolve({ success: false, error: 'Failed to create meeting note' })
      } catch (err) {
        const e = err as Error
        resolve({ success: false, error: e.message })
      }
    }, 800)
  })
}

export async function startManualRecording(meetingId: string): Promise<{
  success: boolean
  recordingId?: string
  error?: string
}> {
  const data = await readMeetingsData()
  const meeting = data.pastMeetings.find((m) => m.id === meetingId)
  if (!meeting) return { success: false, error: 'Meeting not found' }

  try {
    sdkLogger.logApiCall('prepareDesktopAudioRecording')
    const key = await RecallAiSdk.prepareDesktopAudioRecording()
    const uploadData = await mintUploadToken()
    if (uploadData.status !== 'success' || !uploadData.upload_token) {
      return { success: false, error: 'Failed to create recording token' }
    }

    meeting.recordingId = key
    if (!meeting.transcript) meeting.transcript = []

    state.activeMeetingIds[key] = { platformName: 'Desktop Recording', noteId: meetingId }
    state.addRecording(key, meetingId, 'Desktop Recording')
    await writeMeetingsData(data)

    sdkLogger.logApiCall('startRecording', {
      windowId: key,
      uploadToken: `${uploadData.upload_token.slice(0, 8)}...`
    })
    await RecallAiSdk.startRecording({ windowId: key, uploadToken: uploadData.upload_token })

    return { success: true, recordingId: key }
  } catch (err) {
    const e = err as Error
    return { success: false, error: e.message }
  }
}

export async function startAdHocRecording(
  label?: string
): Promise<{ success: true; meetingId: string; recordingId: string } | { success: false; error: string }> {
  const now = new Date()
  const id = `meeting-${Date.now()}`
  const title =
    label?.trim() ||
    `Audio Recording — ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`

  log.recall(`Ad-hoc recording: creating note ${id} ("${title}")`)

  // Mint upload token + prepareDesktopAudioRecording first so we don't end up
  // with an orphaned meeting if either fails.
  let key: string
  try {
    sdkLogger.logApiCall('prepareDesktopAudioRecording')
    key = await RecallAiSdk.prepareDesktopAudioRecording()
  } catch (err) {
    const e = err as Error
    log.err('recall', 'prepareDesktopAudioRecording failed:', e.message)
    return { success: false, error: e.message }
  }

  const uploadData = await mintUploadToken()
  if (uploadData.status !== 'success' || !uploadData.upload_token) {
    return { success: false, error: uploadData.message ?? 'Failed to mint upload token' }
  }

  const data = await readMeetingsData()
  const newMeeting: Meeting = {
    id,
    type: 'document',
    title,
    subtitle: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    hasDemo: false,
    date: now.toISOString(),
    participants: [],
    content: `# ${title}\nRecording: In Progress...`,
    recordingId: key,
    platform: 'Desktop Audio',
    transcript: []
  }
  data.pastMeetings.unshift(newMeeting)

  state.activeMeetingIds[key] = { platformName: 'Desktop Audio', noteId: id }
  state.addRecording(key, id, 'Desktop Audio')
  await writeMeetingsData(data)

  try {
    sdkLogger.logApiCall('startRecording', {
      windowId: key,
      uploadToken: `${uploadData.upload_token.slice(0, 8)}...`
    })
    log.recall(`Calling startRecording for ad-hoc audio (key=${key.slice(0, 8)}…)`)
    await RecallAiSdk.startRecording({ windowId: key, uploadToken: uploadData.upload_token })
  } catch (err) {
    const e = err as Error
    log.err('recall', 'startRecording (ad-hoc) failed:', e.message)
    state.removeRecording(key)
    delete state.activeMeetingIds[key]
    return { success: false, error: e.message }
  }

  setTimeout(() => sendToRenderer('open-meeting-note', id), 300)
  return { success: true, meetingId: id, recordingId: key }
}

export async function stopManualRecording(recordingId: string): Promise<{
  success: boolean
  error?: string
}> {
  try {
    sdkLogger.logApiCall('stopRecording', { windowId: recordingId })
    state.updateRecordingState(recordingId, 'stopping')
    await RecallAiSdk.stopRecording({ windowId: recordingId })
    return { success: true }
  } catch (err) {
    const e = err as Error
    return { success: false, error: e.message }
  }
}
