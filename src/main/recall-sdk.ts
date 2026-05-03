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
import { readMeetingsData, scheduleOperation, writeMeetingsData } from './storage'
import { mintUploadToken } from './server'
import { createWindow, focusMainWindow, getMainWindow, sendToRenderer } from './window'
import { runPostRecording } from './post-recording'
import { queueTranslation } from './translator'

const PLATFORM_NAMES: Record<string, string> = {
  zoom: 'Zoom',
  'google-meet': 'Google Meet',
  slack: 'Slack',
  teams: 'Microsoft Teams'
}

let currentUnknownSpeaker = -1

// Skip Recall init when the user hasn't configured a Recall account. The
// local engine (audio-helper + whisper) is fully usable without Recall —
// the only thing missing is the Zoom/Meet/Teams auto-detect banner.
export function isRecallConfigured(): boolean {
  return !!(process.env.RECALLAI_API_URL && process.env.RECALLAI_API_KEY)
}

export async function initSDK(): Promise<void> {
  if (!isRecallConfigured()) {
    log.recall(
      'Recall not configured (RECALLAI_API_URL / RECALLAI_API_KEY unset) — running local-only. ⌘⇧R + Record Audio still work; Zoom/Meet/Teams auto-detect is disabled.'
    )
    return
  }

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
    // Suppress noisy event-type-only logs: transcript events get their own
    // content-bearing log line in processTranscriptData below; video frames
    // are useless to log at all. Other events (participant joins, etc.) are
    // useful and stay.
    const skipLog =
      evt.event === 'video_separate_png.data' ||
      evt.event === 'transcript.data' ||
      evt.event === 'transcript.provider_data'
    if (!skipLog) {
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
  if (isCompareModeWindow(windowId)) {
    // Compare mode: terminal-only on purpose, no warn (the [recall] Transcript
    // line above already printed it; we just don't write to any note).
    return
  }
  const tracking = state.activeMeetingIds[windowId]
  if (!tracking?.noteId) {
    log.warn(
      'recall',
      `Transcript has no linked note (window=${windowId.slice(0, 8)}…) — terminal-only`
    )
    return
  }
  const noteId = tracking.noteId

  const entry = { text, speaker, timestamp: new Date().toISOString() }
  await scheduleOperation((data) => {
    const meeting = data.pastMeetings.find((m) => m.id === noteId)
    if (!meeting) return null
    if (!meeting.transcript) meeting.transcript = []
    meeting.transcript.push(entry)
    sendToRenderer('transcript-updated', noteId)
    return data
  })
  queueTranslation(noteId, entry)
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
    log.warn('recall', `No meeting note found for recording ID: ${recordingId}`)
    return
  }
  await runPostRecording(meeting.id)
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

// Ad-hoc / manual / stop are handled by the local ScreenCaptureKit + whisper
// pipeline in `audio-capture.ts`. The Recall SDK is now used only for
// Zoom / Meet / Teams / Slack auto-detected meetings via `joinDetectedMeeting`
// → `createMeetingNoteAndRecord` above.
//
// EXCEPT when MEEPCALL_USE_RECALL_FOR_ADHOC=1 is set — then ad-hoc recordings
// (⌘⇧R, Record Audio, comm-app banner) ALSO route through Recall via the
// `prepareDesktopAudioRecording` flow below. Reversible per run; flip the env
// var off to return to local-whisper pipeline.

export async function startRecallAdHocRecording(label?: string): Promise<
  { success: true; meetingId: string; recordingId: string } | { success: false; error: string }
> {
  if (!isRecallConfigured()) {
    return {
      success: false,
      error: 'Recall not configured — set RECALLAI_API_URL and RECALLAI_API_KEY in .env to use the Recall ad-hoc path'
    }
  }

  const now = new Date()
  const id = `meeting-${Date.now()}`
  const title =
    label?.trim() ||
    `Audio Recording — ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`

  log.recall(`Recall ad-hoc recording: creating note ${id} ("${title}")`)

  let windowId: string
  try {
    sdkLogger.logApiCall('prepareDesktopAudioRecording', {})
    windowId = await RecallAiSdk.prepareDesktopAudioRecording()
  } catch (err) {
    const msg = (err as Error).message
    log.err('recall', `prepareDesktopAudioRecording failed: ${msg}`)
    return { success: false, error: `prepareDesktopAudioRecording failed: ${msg}` }
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
    recordingId: windowId,
    platform: 'Recall (ad-hoc)',
    transcript: []
  }
  data.pastMeetings.unshift(newMeeting)
  await writeMeetingsData(data)

  state.activeMeetingIds[windowId] = { platformName: 'Recall (ad-hoc)', noteId: id }
  state.addRecording(windowId, id, 'Recall (ad-hoc)')

  try {
    const uploadData = await mintUploadToken()
    if (uploadData.status !== 'success' || !uploadData.upload_token) {
      state.removeRecording(windowId)
      delete state.activeMeetingIds[windowId]
      return { success: false, error: 'No upload token returned' }
    }
    sdkLogger.logApiCall('startRecording', {
      windowId,
      uploadToken: `${uploadData.upload_token.slice(0, 8)}...`
    })
    log.recall(`Calling startRecording for ad-hoc (token=${uploadData.upload_token.slice(0, 8)}…)`)
    await RecallAiSdk.startRecording({ windowId, uploadToken: uploadData.upload_token })
  } catch (err) {
    state.removeRecording(windowId)
    delete state.activeMeetingIds[windowId]
    return { success: false, error: (err as Error).message }
  }

  setTimeout(() => sendToRenderer('open-meeting-note', id), 300)
  return { success: true, meetingId: id, recordingId: windowId }
}

export async function stopRecallRecording(
  windowId: string
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    state.updateRecordingState(windowId, 'stopping')
    sdkLogger.logApiCall('stopRecording', { windowId })
    log.recall(`Calling stopRecording (window=${windowId.slice(0, 8)}…)`)
    await RecallAiSdk.stopRecording({ windowId })
    // recording-ended event handler will call runPostRecording.
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

export function isRecallAdHocActive(windowId: string): boolean {
  const tracking = state.activeMeetingIds[windowId]
  return tracking?.platformName === 'Recall (ad-hoc)'
}

// ─── Compare mode (MEEPCALL_COMPARE_MODE=1) ────────────────────────────────
// Shadow Recall recording that runs in parallel with the local pipeline so
// you can A/B transcript quality on the same audio. Transcripts print to
// terminal only — no note, no summary, no meetings.json bookkeeping.

let compareModeWindowId: string | null = null

export function isCompareModeWindow(windowId: string): boolean {
  return compareModeWindowId !== null && compareModeWindowId === windowId
}

export async function startCompareModeRecallRecording(): Promise<void> {
  if (!isRecallConfigured()) {
    log.warn(
      'recall',
      'MEEPCALL_COMPARE_MODE=1 but Recall not configured — skipping shadow Recall recording'
    )
    return
  }
  if (compareModeWindowId) {
    log.warn('recall', 'Compare mode: shadow Recall already active, skipping start')
    return
  }
  let windowId: string
  try {
    windowId = await RecallAiSdk.prepareDesktopAudioRecording()
  } catch (err) {
    log.err('recall', `Compare mode prepareDesktopAudioRecording failed: ${(err as Error).message}`)
    return
  }
  try {
    const uploadData = await mintUploadToken()
    if (uploadData.status !== 'success' || !uploadData.upload_token) {
      log.warn('recall', 'Compare mode: no upload token, Recall side skipped')
      return
    }
    compareModeWindowId = windowId
    log.recall(`Compare mode: shadow Recall starting (window=${windowId.slice(0, 8)}…)`)
    await RecallAiSdk.startRecording({ windowId, uploadToken: uploadData.upload_token })
  } catch (err) {
    log.err('recall', `Compare mode startRecording failed: ${(err as Error).message}`)
    compareModeWindowId = null
  }
}

export async function stopCompareModeRecallRecording(): Promise<void> {
  if (!compareModeWindowId) return
  const windowId = compareModeWindowId
  compareModeWindowId = null
  try {
    log.recall(`Compare mode: shadow Recall stopping (window=${windowId.slice(0, 8)}…)`)
    await RecallAiSdk.stopRecording({ windowId })
  } catch (err) {
    log.err('recall', `Compare mode stopRecording failed: ${(err as Error).message}`)
  }
}
