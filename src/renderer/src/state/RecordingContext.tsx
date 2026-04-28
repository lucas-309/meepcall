import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type ReactNode
} from 'react'

interface RecordingState {
  meetingDetected: boolean
  commAppsRunning: string[]
  activeRecordingId: string | null
  setActiveRecordingId: (id: string | null) => void
}

const Ctx = createContext<RecordingState | null>(null)

export function RecordingProvider({ children }: { children: ReactNode }): JSX.Element {
  const [meetingDetected, setMeetingDetected] = useState(false)
  const [commAppsRunning, setCommAppsRunning] = useState<string[]>([])
  const [activeRecordingId, setActiveRecordingId] = useState<string | null>(null)

  useEffect(() => {
    void window.api.checkForDetectedMeeting().then(setMeetingDetected)
    return window.api.onMeetingDetectionStatus(({ detected }) => setMeetingDetected(detected))
  }, [])

  useEffect(() => {
    return window.api.onCommAppsRunning((apps) => setCommAppsRunning(apps))
  }, [])

  const value = useMemo<RecordingState>(
    () => ({ meetingDetected, commAppsRunning, activeRecordingId, setActiveRecordingId }),
    [meetingDetected, commAppsRunning, activeRecordingId]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useRecording(): RecordingState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useRecording must be used within RecordingProvider')
  return ctx
}
