import { contextBridge, ipcRenderer } from 'electron'
import type {
  MeetingDetectionStatus,
  MeetingTitleUpdate,
  MeetingsData,
  RecallApi,
  SdkLogEntry,
  SdkLoggerBridge,
  SummaryUpdate,
  VideoFrameMessage
} from '../shared/types'

const subscribe =
  <T>(channel: string) =>
  (cb: (payload: T) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.off(channel, listener)
  }

const api: RecallApi = {
  navigate: (page) => ipcRenderer.send('navigate', page),
  saveMeetingsData: (data: MeetingsData) => ipcRenderer.invoke('saveMeetingsData', data),
  loadMeetingsData: () => ipcRenderer.invoke('loadMeetingsData'),
  deleteMeeting: (id) => ipcRenderer.invoke('deleteMeeting', id),
  generateMeetingSummary: (id) => ipcRenderer.invoke('generateMeetingSummary', id),
  generateMeetingSummaryStreaming: (id) =>
    ipcRenderer.invoke('generateMeetingSummaryStreaming', id),
  startManualRecording: (id) => ipcRenderer.invoke('startManualRecording', id),
  startAdHocRecording: (label) => ipcRenderer.invoke('startAdHocRecording', label),
  stopManualRecording: (id) => ipcRenderer.invoke('stopManualRecording', id),
  checkForDetectedMeeting: () => ipcRenderer.invoke('checkForDetectedMeeting'),
  joinDetectedMeeting: () => ipcRenderer.invoke('joinDetectedMeeting'),
  getActiveRecordingId: (noteId) => ipcRenderer.invoke('getActiveRecordingId', noteId),

  onOpenMeetingNote: subscribe<string>('open-meeting-note'),
  onRecordingCompleted: subscribe<string>('recording-completed'),
  onTranscriptUpdated: subscribe<string>('transcript-updated'),
  onSummaryGenerated: subscribe<string>('summary-generated'),
  onSummaryUpdate: subscribe<SummaryUpdate>('summary-update'),
  onParticipantsUpdated: subscribe<string>('participants-updated'),
  onVideoFrame: subscribe<VideoFrameMessage>('video-frame'),
  onMeetingDetectionStatus: subscribe<MeetingDetectionStatus>('meeting-detection-status'),
  onMeetingTitleUpdated: subscribe<MeetingTitleUpdate>('meeting-title-updated'),
  onCommAppsRunning: subscribe<string[]>('comm-apps-running')
}

const sdkLoggerBridge: SdkLoggerBridge = {
  onSdkLog: subscribe<SdkLogEntry>('sdk-log'),
  sendSdkLog: (entry) => ipcRenderer.send('sdk-log', entry)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('sdkLoggerBridge', sdkLoggerBridge)
  } catch (err) {
    console.error('Preload contextBridge error:', err)
  }
} else {
  // @ts-ignore — fallback when contextIsolation is disabled
  window.api = api
  // @ts-ignore
  window.sdkLoggerBridge = sdkLoggerBridge
}
