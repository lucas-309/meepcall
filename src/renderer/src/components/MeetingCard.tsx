import type { JSX } from 'react'
import type { Meeting } from '@shared/types'

interface Props {
  meeting: Meeting
  onClick: () => void
  onDelete: () => void
}

function formatTime(dateString: string): string {
  const d = new Date(dateString)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function MeetingCard({ meeting, onClick, onDelete }: Props): JSX.Element {
  const subtitle = meeting.recordingComplete
    ? `${meeting.platform ?? 'Recording'} · ${formatTime(meeting.date)}`
    : meeting.recordingId
      ? '● Recording in progress…'
      : meeting.subtitle || formatTime(meeting.date)

  return (
    <div className="meeting-card" onClick={onClick} data-id={meeting.id}>
      <div className="meeting-icon document">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path
            d="M14 2H6C4.9 2 4.01 2.9 4.01 4L4 20C4 21.1 4.89 22 5.99 22H18C19.1 22 20 21.1 20 20V8L14 2ZM16 18H8V16H16V18ZM16 14H8V12H16V14ZM13 9V3.5L18.5 9H13Z"
            fill="#4CAF50"
          />
        </svg>
      </div>
      <div className="meeting-content">
        <div className="meeting-title">{meeting.title}</div>
        <div className="meeting-time">{subtitle}</div>
      </div>
      <div className="meeting-actions">
        <button
          className="delete-meeting-btn"
          onClick={(e) => {
            e.stopPropagation()
            if (confirm(`Delete "${meeting.title}"?`)) onDelete()
          }}
          title="Delete note"
          aria-label="Delete note"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"
              fill="currentColor"
            />
          </svg>
        </button>
      </div>
    </div>
  )
}
