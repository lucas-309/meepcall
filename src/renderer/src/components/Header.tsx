import type { JSX } from 'react'
import { useRecording } from '../state/RecordingContext'
import { useMeetings } from '../state/MeetingsContext'

interface Props {
  view: 'home' | 'editor'
  onBack: () => void
  onOpenMeeting: (id: string) => void
}

export function Header({ view, onBack, onOpenMeeting }: Props): JSX.Element {
  const { meetingDetected, commAppsRunning } = useRecording()
  const { reload } = useMeetings()
  const primaryCommApp = commAppsRunning[0]

  const handleJoinMeeting = async (): Promise<void> => {
    if (!meetingDetected) return
    const result = await window.api.joinDetectedMeeting()
    if (result.success && result.meetingId) {
      await reload()
      onOpenMeeting(result.meetingId)
    }
  }

  const handleAdHocRecording = async (): Promise<void> => {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const defaultTitle = primaryCommApp
      ? `${primaryCommApp} call — ${time}`
      : `Audio recording — ${time}`
    const label = window.prompt('Title for this audio recording:', defaultTitle)
    if (label === null) return
    const result = await window.api.startAdHocRecording(label || undefined)
    if (result.success) {
      await reload()
      onOpenMeeting(result.meetingId)
    } else {
      window.alert(`Couldn't start recording: ${result.error}`)
    }
  }

  return (
    <header className="header" id="drag-region">
      <div className="header-left">
        {view === 'editor' && (
          <button className="btn back-btn" onClick={onBack} aria-label="Back">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M20 11H7.83L13.42 5.41L12 4L4 12L12 20L13.41 18.59L7.83 13H20V11Z"
                fill="currentColor"
              />
            </svg>
          </button>
        )}
      </div>
      <div className="header-center">
        <div className="search-container">
          <span className="search-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M15.5 14H14.71L14.43 13.73C15.41 12.59 16 11.11 16 9.5C16 5.91 13.09 3 9.5 3C5.91 3 3 5.91 3 9.5C3 13.09 5.91 16 9.5 16C11.11 16 12.59 15.41 13.73 14.43L14 14.71V15.5L19 20.49L20.49 19L15.5 14ZM9.5 14C7.01 14 5 11.99 5 9.5C5 7.01 7.01 5 9.5 5C11.99 5 14 7.01 14 9.5C14 11.99 11.99 14 9.5 14Z"
                fill="#666666"
              />
            </svg>
          </span>
          <input type="text" className="search-input" placeholder="Search notes" />
        </div>
      </div>
      <div className="header-right">
        {view === 'home' && (
          <>
            <button
              className={`btn new-note-btn${primaryCommApp ? ' highlighted' : ''}`}
              onClick={handleAdHocRecording}
              title={
                primaryCommApp
                  ? `${primaryCommApp} is running — capture desktop audio`
                  : 'Record desktop audio (phone calls, FaceTime, in-person — captures all system audio)'
              }
            >
              {primaryCommApp ? `Record ${primaryCommApp}` : 'Record Audio'}
            </button>
            <button
              className="btn join-meeting-btn"
              onClick={handleJoinMeeting}
              disabled={!meetingDetected}
              title={meetingDetected ? 'Record detected meeting' : 'No meeting detected'}
            >
              Record Meeting
            </button>
          </>
        )}
        <div className="user-avatar">
          <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
            <rect width="40" height="40" rx="20" fill="#f0f0f0" />
            <path
              d="M20 20C22.7614 20 25 17.7614 25 15C25 12.2386 22.7614 10 20 10C17.2386 10 15 12.2386 15 15C15 17.7614 17.2386 20 20 20Z"
              fill="#a0a0a0"
            />
            <path
              d="M12 31C12 26.0294 15.5817 22 20 22C24.4183 22 28 26.0294 28 31"
              stroke="#a0a0a0"
              strokeWidth="4"
            />
          </svg>
        </div>
      </div>
    </header>
  )
}
