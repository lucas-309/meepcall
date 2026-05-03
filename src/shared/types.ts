export type MeetingPlatform = 'zoom' | 'google-meet' | 'teams' | 'slack' | (string & {})

export interface Participant {
  id: string
  name: string
  isHost?: boolean
  platform?: string
  joinTime: string
  status: 'active'
}

export interface TranscriptEntry {
  text: string
  speaker: string
  timestamp: string
  // English translation, populated asynchronously by the translator when the
  // source text is detected as non-English (CJK chars). Absent until the
  // Haiku call returns; absent forever if ANTHROPIC_API_KEY is unset or the
  // text is already English.
  translation?: string
}

export interface Meeting {
  id: string
  type: 'document'
  title: string
  subtitle?: string
  hasDemo?: boolean
  date: string
  participants?: Participant[]
  content: string
  recordingId?: string
  platform?: string
  transcript?: TranscriptEntry[]
  notes?: string
  hasSummary?: boolean
  recordingComplete?: boolean
  recordingEndTime?: string
}

export interface MeetingsData {
  upcomingMeetings: Meeting[]
  pastMeetings: Meeting[]
}

export interface ActiveRecording {
  noteId: string
  platform: string
  state: 'recording' | 'stopping'
  startTime: string
}

export type SdkLogEntry =
  | {
      type: 'api-call'
      method: string
      params: Record<string, unknown>
      timestamp: string
    }
  | {
      type: 'event'
      eventType: string
      data: Record<string, unknown>
      timestamp: string
    }
  | {
      type: 'error'
      errorType: string
      message: string
      timestamp: string
    }
  | {
      type: 'info' | 'warn'
      message: string
      timestamp: string
    }

export interface VideoFrameMessage {
  noteId: string
  participantId?: string
  participantName: string
  frameType: 'webcam' | 'screenshare'
  buffer: string
  timestamp: { absolute?: string; relative?: number }
}

export interface MeetingDetectionStatus {
  detected: boolean
}

export interface MeetingTitleUpdate {
  meetingId: string
  newTitle: string
}

export interface SummaryUpdate {
  meetingId: string
  content: string
  timestamp?: number
}

export type IpcResult<T extends Record<string, unknown> = Record<string, never>> =
  | ({ success: true } & T)
  | { success: false; error: string }

export interface RecallApi {
  navigate(page: 'note-editor' | 'home'): void
  saveMeetingsData(data: MeetingsData): Promise<IpcResult>
  loadMeetingsData(): Promise<IpcResult<{ data: MeetingsData }>>
  deleteMeeting(meetingId: string): Promise<IpcResult>
  generateMeetingSummary(meetingId: string): Promise<IpcResult<{ summary: string }>>
  generateMeetingSummaryStreaming(meetingId: string): Promise<IpcResult<{ summary: string }>>
  startManualRecording(meetingId: string): Promise<IpcResult<{ recordingId: string }>>
  startAdHocRecording(
    label?: string
  ): Promise<IpcResult<{ meetingId: string; recordingId: string }>>
  stopManualRecording(recordingId: string): Promise<IpcResult>
  checkForDetectedMeeting(): Promise<boolean>
  joinDetectedMeeting(): Promise<IpcResult<{ meetingId: string }>>
  getActiveRecordingId(
    noteId?: string
  ): Promise<IpcResult<{ data: ActiveRecording | Record<string, ActiveRecording> | null }>>

  onOpenMeetingNote(cb: (id: string) => void): () => void
  onRecordingCompleted(cb: (id: string) => void): () => void
  onTranscriptUpdated(cb: (id: string) => void): () => void
  onSummaryGenerated(cb: (id: string) => void): () => void
  onSummaryUpdate(cb: (data: SummaryUpdate) => void): () => void
  onParticipantsUpdated(cb: (id: string) => void): () => void
  onVideoFrame(cb: (data: VideoFrameMessage) => void): () => void
  onMeetingDetectionStatus(cb: (s: MeetingDetectionStatus) => void): () => void
  onMeetingTitleUpdated(cb: (data: MeetingTitleUpdate) => void): () => void
  onCommAppsRunning(cb: (apps: string[]) => void): () => void
}

export interface SdkLoggerBridge {
  onSdkLog(cb: (entry: SdkLogEntry) => void): () => void
  sendSdkLog(entry: SdkLogEntry): void
}
