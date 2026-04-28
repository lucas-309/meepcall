import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Meeting } from '@shared/types'
import { useMeetings } from '../state/MeetingsContext'

interface Props {
  meetingId: string
}

function formatDateLabel(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function NoteEditor({ meetingId }: Props): JSX.Element {
  const { data, updateMeeting } = useMeetings()
  const meeting = useMemo(
    () => data.pastMeetings.find((m) => m.id === meetingId) ?? null,
    [data, meetingId]
  )

  const [streamingSummary, setStreamingSummary] = useState<string | null>(null)
  const [recordingState, setRecordingState] = useState<'idle' | 'recording' | 'stopping'>('idle')
  const titleRef = useRef<HTMLHeadingElement | null>(null)

  useEffect(() => {
    void window.api.getActiveRecordingId(meetingId).then((r) => {
      if (r.success && r.data && typeof r.data === 'object' && 'state' in r.data) {
        setRecordingState((r.data as { state: 'recording' | 'stopping' }).state)
      } else {
        setRecordingState('idle')
      }
    })
  }, [meetingId])

  useEffect(() => {
    return window.api.onSummaryUpdate((p) => {
      if (p.meetingId === meetingId) setStreamingSummary(p.content)
    })
  }, [meetingId])

  useEffect(() => {
    return window.api.onSummaryGenerated((id) => {
      if (id === meetingId) setStreamingSummary(null)
    })
  }, [meetingId])

  useEffect(() => {
    return window.api.onRecordingCompleted((id) => {
      if (id === meetingId) setRecordingState('idle')
    })
  }, [meetingId])

  useEffect(() => {
    if (titleRef.current && meeting) {
      titleRef.current.textContent = meeting.title
    }
  }, [meeting?.id])

  if (!meeting) {
    return (
      <main className="editor-content full-width">
        <div className="empty-state">Meeting not found.</div>
      </main>
    )
  }

  const date = new Date(meeting.date)
  const isRecording = recordingState === 'recording'

  const handleTitleBlur = (): void => {
    const next = titleRef.current?.textContent?.trim() ?? ''
    if (!next || next === meeting.title) {
      if (titleRef.current && !next) titleRef.current.textContent = meeting.title
      return
    }
    void updateMeeting(meeting.id, { title: next })
  }

  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLHeadingElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      ;(e.currentTarget as HTMLElement).blur()
    }
  }

  const handleStop = async (): Promise<void> => {
    if (!meeting.recordingId) return
    setRecordingState('stopping')
    await window.api.stopManualRecording(meeting.recordingId)
  }

  const handleRegenerate = async (): Promise<void> => {
    await window.api.generateMeetingSummaryStreaming(meeting.id)
  }

  return (
    <div className="note-container">
      <main className="editor-content full-width">
        <NoteHeader
          meeting={meeting}
          dateLabel={formatDateLabel(date)}
          titleRef={titleRef}
          onTitleBlur={handleTitleBlur}
          onTitleKeyDown={handleTitleKeyDown}
        />

        <NotesEditor meeting={meeting} />

        <LiveTranscript meeting={meeting} isRecording={isRecording} />

        <AISummary
          meeting={meeting}
          streaming={streamingSummary}
          isRecording={isRecording}
          canRegenerate={!!meeting.transcript && meeting.transcript.length > 0}
          onRegenerate={handleRegenerate}
        />
      </main>

      <FloatingControls
        recordingState={recordingState}
        canRegenerate={!!meeting.transcript && meeting.transcript.length > 0}
        onStop={handleStop}
        onRegenerate={handleRegenerate}
      />
    </div>
  )
}

function NoteHeader({
  meeting,
  dateLabel,
  titleRef,
  onTitleBlur,
  onTitleKeyDown
}: {
  meeting: Meeting
  dateLabel: string
  titleRef: React.MutableRefObject<HTMLHeadingElement | null>
  onTitleBlur: () => void
  onTitleKeyDown: (e: React.KeyboardEvent<HTMLHeadingElement>) => void
}): JSX.Element {
  return (
    <div className="note-header">
      <div className="title-container">
        <h1
          id="noteTitle"
          ref={titleRef}
          contentEditable
          suppressContentEditableWarning
          onBlur={onTitleBlur}
          onKeyDown={onTitleKeyDown}
        >
          {meeting.title}
        </h1>
      </div>
      <div className="note-meta">
        <span className="note-date">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path
              d="M19 4H18V2H16V4H8V2H6V4H5C3.89 4 3.01 4.9 3.01 6L3 20C3 21.1 3.89 22 5 22H19C20.1 22 21 21.1 21 20V6C21 4.9 20.1 4 19 4ZM19 20H5V10H19V20ZM19 8H5V6H19V8Z"
              fill="#6947BD"
            />
          </svg>
          <span>{dateLabel}</span>
        </span>
        {meeting.platform && <span className="note-author">{meeting.platform}</span>}
        {meeting.transcript && meeting.transcript.length > 0 && (
          <span className="note-author">{meeting.transcript.length} entries</span>
        )}
        {meeting.recordingComplete && <span className="note-author done">Recorded</span>}
      </div>
    </div>
  )
}

function NotesEditor({ meeting }: { meeting: Meeting }): JSX.Element {
  const { updateMeeting } = useMeetings()
  const [draft, setDraft] = useState<string>(meeting.notes ?? '')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftRef = useRef<string>(draft)
  draftRef.current = draft

  // Reset draft only when switching meetings — not on every prop refresh from
  // transcript reloads, or live typing would get clobbered.
  useEffect(() => {
    setDraft(meeting.notes ?? '')
  }, [meeting.id])

  const flush = (): void => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    void updateMeeting(meeting.id, { notes: draftRef.current })
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        void updateMeeting(meeting.id, { notes: draftRef.current })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const value = e.target.value
    setDraft(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      void updateMeeting(meeting.id, { notes: value })
      debounceRef.current = null
    }, 400)
  }

  return (
    <section className="card notes-card">
      <div className="card-header">
        <h3>Notes</h3>
      </div>
      <div className="card-body">
        <textarea
          className="notes-textarea"
          value={draft}
          onChange={handleChange}
          onBlur={flush}
          placeholder="Type your notes here. They'll be combined with the transcript when AI summarizes."
          spellCheck
        />
      </div>
    </section>
  )
}

function LiveTranscript({
  meeting,
  isRecording
}: {
  meeting: Meeting
  isRecording: boolean
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const entries = meeting.transcript ?? []

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [entries.length])

  return (
    <section className="card transcript-card">
      <div className="card-header">
        {isRecording && <span className="detected-dot" />}
        <h3>{isRecording ? 'Live Transcript' : 'Transcript'}</h3>
        <span className="card-count">{entries.length}</span>
      </div>
      <div className="card-body transcript-body" ref={scrollRef}>
        {entries.length === 0 ? (
          <div className="card-placeholder">
            {isRecording
              ? 'Listening… transcript will appear here as people talk.'
              : 'No transcript captured for this meeting.'}
          </div>
        ) : (
          entries.map((e, idx) => {
            const isLast = idx === entries.length - 1
            return (
              <div
                key={`${e.timestamp}-${idx}`}
                className={`transcript-entry${isLast ? ' newest-entry' : ''}`}
              >
                <div className="transcript-speaker">{e.speaker}</div>
                <div className="transcript-text">{e.text}</div>
              </div>
            )
          })
        )}
      </div>
    </section>
  )
}

function AISummary({
  meeting,
  streaming,
  isRecording,
  canRegenerate,
  onRegenerate
}: {
  meeting: Meeting
  streaming: string | null
  isRecording: boolean
  canRegenerate: boolean
  onRegenerate: () => void
}): JSX.Element {
  const isStreaming = streaming !== null
  const hasSummary = meeting.hasSummary && !!meeting.content

  let body: JSX.Element
  if (isStreaming) {
    body = (
      <div className="summary-content">
        <ReactMarkdown>{streaming!}</ReactMarkdown>
      </div>
    )
  } else if (hasSummary) {
    body = (
      <div className="summary-content">
        <ReactMarkdown>{meeting.content}</ReactMarkdown>
      </div>
    )
  } else if (isRecording) {
    body = (
      <div className="card-placeholder">
        AI summary will be generated automatically when the meeting ends.
      </div>
    )
  } else if (canRegenerate) {
    body = (
      <div className="card-placeholder summary-cta">
        <p>No summary yet for this meeting.</p>
        <button className="btn primary" onClick={onRegenerate}>
          Generate AI Summary
        </button>
      </div>
    )
  } else {
    body = (
      <div className="card-placeholder">
        Nothing to summarize yet — start a recording to capture transcript.
      </div>
    )
  }

  return (
    <section className="card summary-card">
      <div className="card-header">
        <h3>AI Summary</h3>
        {isStreaming && <span className="card-badge streaming">Generating…</span>}
        {hasSummary && !isStreaming && (
          <button
            className="card-action"
            onClick={onRegenerate}
            disabled={!canRegenerate}
            title="Regenerate summary"
          >
            ↻ Regenerate
          </button>
        )}
      </div>
      <div className="card-body">{body}</div>
    </section>
  )
}

function FloatingControls({
  recordingState,
  canRegenerate,
  onStop,
  onRegenerate
}: {
  recordingState: 'idle' | 'recording' | 'stopping'
  canRegenerate: boolean
  onStop: () => void
  onRegenerate: () => void
}): JSX.Element {
  const isRecording = recordingState === 'recording'
  const isStopping = recordingState === 'stopping'
  return (
    <div className="floating-controls">
      <div className="control-buttons">
        {(isRecording || isStopping) && (
          <button
            className={`control-btn record-btn${isRecording ? ' recording' : ''}`}
            onClick={isRecording ? onStop : undefined}
            disabled={isStopping}
            aria-label={isRecording ? 'Stop recording' : 'Stopping…'}
            title={isRecording ? 'Stop recording' : 'Stopping…'}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M6 6h12v12H6V6z" fill="currentColor" />
            </svg>
          </button>
        )}
        <button
          className="control-btn generate-btn"
          onClick={onRegenerate}
          disabled={!canRegenerate}
          title={canRegenerate ? 'Generate AI summary' : 'No transcript to summarize yet'}
        >
          <svg width="14" height="14" viewBox="0 0 512 512" fill="none" style={{ marginRight: 4 }}>
            <path
              d="M208,512a24.84,24.84,0,0,1-23.34-16l-39.84-103.6a16.06,16.06,0,0,0-9.19-9.19L32,343.34a25,25,0,0,1,0-46.68l103.6-39.84a16.06,16.06,0,0,0,9.19-9.19L184.66,144a25,25,0,0,1,46.68,0l39.84,103.6a16.06,16.06,0,0,0,9.19,9.19l103,39.63A25.49,25.49,0,0,1,400,320.52a24.82,24.82,0,0,1-16,22.82l-103.6,39.84a16.06,16.06,0,0,0-9.19,9.19L231.34,496A24.84,24.84,0,0,1,208,512Z"
              fill="currentColor"
            />
          </svg>
          AI Summary
        </button>
      </div>
    </div>
  )
}
