import { useEffect, useState, type JSX } from 'react'
import { Header } from './components/Header'
import { HomePage } from './pages/HomePage'
import { NoteEditor } from './pages/NoteEditor'
import { MeetingsProvider } from './state/MeetingsContext'
import { RecordingProvider } from './state/RecordingContext'

function Shell(): JSX.Element {
  const [view, setView] = useState<{ name: 'home' } | { name: 'editor'; meetingId: string }>({
    name: 'home'
  })

  useEffect(() => {
    return window.api.onOpenMeetingNote((id) => setView({ name: 'editor', meetingId: id }))
  }, [])

  return (
    <div className="app-container">
      <Header
        view={view.name}
        onBack={() => setView({ name: 'home' })}
        onOpenMeeting={(id) => setView({ name: 'editor', meetingId: id })}
      />
      {view.name === 'home' && (
        <div id="homeView">
          <HomePage onOpenMeeting={(id) => setView({ name: 'editor', meetingId: id })} />
        </div>
      )}
      {view.name === 'editor' && (
        <div id="editorView">
          <NoteEditor meetingId={view.meetingId} />
        </div>
      )}
    </div>
  )
}

function App(): JSX.Element {
  return (
    <MeetingsProvider>
      <RecordingProvider>
        <Shell />
      </RecordingProvider>
    </MeetingsProvider>
  )
}

export default App
