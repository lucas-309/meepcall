import type { ActiveRecording } from '@shared/types'

export interface DetectedMeeting {
  window: {
    id: string
    platform?: string
    title?: string
    url?: string
  }
}

export interface ActiveMeetingTracking {
  platformName: string
  noteId?: string
}

class State {
  detectedMeeting: DetectedMeeting | null = null
  activeMeetingIds: Record<string, ActiveMeetingTracking> = {}
  recordings: Record<string, ActiveRecording> = {}

  addRecording(recordingId: string, noteId: string, platform = 'unknown'): void {
    this.recordings[recordingId] = {
      noteId,
      platform,
      state: 'recording',
      startTime: new Date().toISOString()
    }
    console.log(`Recording registered: ${recordingId} for note ${noteId}`)
  }

  updateRecordingState(recordingId: string, state: ActiveRecording['state']): boolean {
    const r = this.recordings[recordingId]
    if (!r) return false
    r.state = state
    console.log(`Recording ${recordingId} state -> ${state}`)
    return true
  }

  removeRecording(recordingId: string): boolean {
    if (!this.recordings[recordingId]) return false
    delete this.recordings[recordingId]
    console.log(`Recording ${recordingId} removed`)
    return true
  }

  getRecordingForNote(noteId: string): (ActiveRecording & { recordingId: string }) | null {
    for (const [recordingId, info] of Object.entries(this.recordings)) {
      if (info.noteId === noteId) return { recordingId, ...info }
    }
    return null
  }

  getAllRecordings(): Record<string, ActiveRecording> {
    return { ...this.recordings }
  }
}

export const state = new State()
