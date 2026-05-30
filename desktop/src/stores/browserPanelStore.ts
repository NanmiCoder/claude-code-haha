import { create } from 'zustand'

export type BrowserSessionState = {
  isOpen: boolean
  url: string
  title: string
  history: string[]
  historyIndex: number
  loading: boolean
  pickerActive: boolean
  canGoBack: boolean
  canGoForward: boolean
}

type BrowserPanelState = {
  bySession: Record<string, BrowserSessionState>
  open: (sessionId: string, url: string) => void
  navigate: (sessionId: string, url: string) => void
  goBack: (sessionId: string) => void
  goForward: (sessionId: string) => void
  setLoading: (sessionId: string, loading: boolean) => void
  setPicker: (sessionId: string, active: boolean) => void
  close: (sessionId: string) => void
  setNavigated: (sessionId: string, url: string, title: string) => void
  setReady: (sessionId: string) => void
}

const empty = (url: string): BrowserSessionState => ({
  isOpen: true, url, title: '', history: [url], historyIndex: 0,
  loading: false, pickerActive: false, canGoBack: false, canGoForward: false,
})

const withNav = (s: BrowserSessionState): BrowserSessionState => ({
  ...s,
  url: s.history[s.historyIndex]!,
  canGoBack: s.historyIndex > 0,
  canGoForward: s.historyIndex < s.history.length - 1,
})

export const useBrowserPanelStore = create<BrowserPanelState>((set) => ({
  bySession: {},
  open: (sessionId, url) => set((st) => ({
    bySession: { ...st.bySession, [sessionId]: { ...empty(url), loading: true } },
  })),
  navigate: (sessionId, url) => set((st) => {
    const cur = st.bySession[sessionId] ?? empty(url)
    const history = [...cur.history.slice(0, cur.historyIndex + 1), url]
    return { bySession: { ...st.bySession, [sessionId]: withNav({ ...cur, isOpen: true, loading: true, history, historyIndex: history.length - 1 }) } }
  }),
  goBack: (sessionId) => set((st) => {
    const cur = st.bySession[sessionId]; if (!cur || cur.historyIndex <= 0) return st
    return { bySession: { ...st.bySession, [sessionId]: withNav({ ...cur, historyIndex: cur.historyIndex - 1 }) } }
  }),
  goForward: (sessionId) => set((st) => {
    const cur = st.bySession[sessionId]; if (!cur || cur.historyIndex >= cur.history.length - 1) return st
    return { bySession: { ...st.bySession, [sessionId]: withNav({ ...cur, historyIndex: cur.historyIndex + 1 }) } }
  }),
  setLoading: (sessionId, loading) => set((st) => {
    const cur = st.bySession[sessionId]; if (!cur) return st
    return { bySession: { ...st.bySession, [sessionId]: { ...cur, loading } } }
  }),
  setPicker: (sessionId, active) => set((st) => {
    const cur = st.bySession[sessionId]; if (!cur) return st
    return { bySession: { ...st.bySession, [sessionId]: { ...cur, pickerActive: active } } }
  }),
  close: (sessionId) => set((st) => {
    const cur = st.bySession[sessionId]; if (!cur) return st
    return { bySession: { ...st.bySession, [sessionId]: { ...cur, isOpen: false, pickerActive: false } } }
  }),
  setNavigated: (sessionId, url, title) => set((st) => {
    const cur = st.bySession[sessionId]; if (!cur) return st
    return { bySession: { ...st.bySession, [sessionId]: { ...cur, url, title, loading: false } } }
  }),
  setReady: (sessionId) => set((st) => {
    const cur = st.bySession[sessionId]; if (!cur) return st
    return { bySession: { ...st.bySession, [sessionId]: { ...cur, loading: false } } }
  }),
}))
