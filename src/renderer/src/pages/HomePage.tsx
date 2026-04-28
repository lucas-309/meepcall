import type { JSX } from 'react'
import { useMeetings } from '../state/MeetingsContext'
import { useRecording } from '../state/RecordingContext'
import { MeetingCard } from '../components/MeetingCard'

interface Props {
  onOpenMeeting: (id: string) => void
}

function groupByDate(meetings: { id: string; date: string }[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {}
  const today = new Date().toDateString()
  const yesterday = new Date(Date.now() - 86400000).toDateString()
  for (const m of meetings) {
    const d = new Date(m.date).toDateString()
    let key: string
    if (d === today) key = 'Today'
    else if (d === yesterday) key = 'Yesterday'
    else
      key = new Date(m.date).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric'
      })
    if (!groups[key]) groups[key] = []
    groups[key].push(m.id)
  }
  return groups
}

export function HomePage({ onOpenMeeting }: Props): JSX.Element {
  const { data, loading, deleteMeeting } = useMeetings()
  const { meetingDetected, commAppsRunning } = useRecording()

  const groups = groupByDate(data.pastMeetings)
  const groupOrder = Object.keys(groups)

  return (
    <main className="main-content">
      <div className="content-container">
        {meetingDetected && (
          <div className="detected-banner">
            <span className="detected-dot" />
            Meeting detected — click <strong>Record Meeting</strong> to start.
          </div>
        )}
        {!meetingDetected && commAppsRunning.length > 0 && (
          <div className="detected-banner comm">
            <span className="detected-dot blue" />
            <strong>{commAppsRunning.join(', ')}</strong> running — click{' '}
            <strong>Record {commAppsRunning[0]}</strong> to capture audio.
          </div>
        )}

        {loading ? (
          <p className="empty-state">Loading…</p>
        ) : data.pastMeetings.length === 0 ? (
          <div className="empty-state">
            <h2 className="empty-title">No notes yet</h2>
            <p>
              Start a Zoom, Google Meet, or Microsoft Teams call and Recall will detect it
              automatically.
            </p>
          </div>
        ) : (
          groupOrder.map((label) => (
            <section className="meetings-section" key={label}>
              <h2 className="section-title">{label}</h2>
              <div className="meetings-list">
                {groups[label].map((id) => {
                  const m = data.pastMeetings.find((x) => x.id === id)
                  if (!m) return null
                  return (
                    <MeetingCard
                      key={m.id}
                      meeting={m}
                      onClick={() => onOpenMeeting(m.id)}
                      onDelete={() => void deleteMeeting(m.id)}
                    />
                  )
                })}
              </div>
            </section>
          ))
        )}
      </div>
    </main>
  )
}
