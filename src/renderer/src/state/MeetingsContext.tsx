import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode
} from 'react'
import type { Meeting, MeetingsData } from '@shared/types'

interface MeetingsState {
  data: MeetingsData
  loading: boolean
  reload: () => Promise<void>
  updateMeeting: (id: string, patch: Partial<Meeting>) => Promise<void>
  deleteMeeting: (id: string) => Promise<void>
}

const Ctx = createContext<MeetingsState | null>(null)

const EMPTY: MeetingsData = { upcomingMeetings: [], pastMeetings: [] }

export function MeetingsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [data, setData] = useState<MeetingsData>(EMPTY)
  const [loading, setLoading] = useState(true)
  const dataRef = useRef<MeetingsData>(EMPTY)
  dataRef.current = data

  const reload = useCallback(async () => {
    const result = await window.api.loadMeetingsData()
    if (result.success) setData(result.data)
    setLoading(false)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    const offs = [
      window.api.onTranscriptUpdated(() => void reload()),
      window.api.onParticipantsUpdated(() => void reload()),
      window.api.onSummaryGenerated(() => void reload()),
      window.api.onRecordingCompleted(() => void reload()),
      window.api.onMeetingTitleUpdated(() => void reload())
    ]
    return () => offs.forEach((off) => off())
  }, [reload])

  const updateMeeting = useCallback(async (id: string, patch: Partial<Meeting>) => {
    const next: MeetingsData = {
      ...dataRef.current,
      pastMeetings: dataRef.current.pastMeetings.map((m) =>
        m.id === id ? { ...m, ...patch } : m
      )
    }
    setData(next)
    await window.api.saveMeetingsData(next)
  }, [])

  const deleteMeeting = useCallback(
    async (id: string) => {
      await window.api.deleteMeeting(id)
      await reload()
    },
    [reload]
  )

  const value = useMemo<MeetingsState>(
    () => ({ data, loading, reload, updateMeeting, deleteMeeting }),
    [data, loading, reload, updateMeeting, deleteMeeting]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useMeetings(): MeetingsState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useMeetings must be used within MeetingsProvider')
  return ctx
}
