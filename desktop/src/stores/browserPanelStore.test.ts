import { beforeEach, describe, expect, it } from 'vitest'
import { useBrowserPanelStore } from './browserPanelStore'

const reset = () => useBrowserPanelStore.setState(useBrowserPanelStore.getInitialState(), true)

describe('browserPanelStore', () => {
  beforeEach(reset)

  it('opens a session at a url and records history', () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    const s = useBrowserPanelStore.getState().bySession['s1']!
    expect(s.url).toBe('http://localhost:5173/')
    expect(s.isOpen).toBe(true)
    expect(s.history).toEqual(['http://localhost:5173/'])
    expect(s.historyIndex).toBe(0)
    expect(s.canGoBack).toBe(false)
  })

  it('navigate pushes history and truncates forward entries', () => {
    const st = useBrowserPanelStore.getState()
    st.open('s1', 'http://localhost/a')
    st.navigate('s1', 'http://localhost/b')
    st.navigate('s1', 'http://localhost/c')
    st.goBack('s1')
    st.navigate('s1', 'http://localhost/d') // 截断 c
    const s = useBrowserPanelStore.getState().bySession['s1']!
    expect(s.history).toEqual(['http://localhost/a', 'http://localhost/b', 'http://localhost/d'])
    expect(s.url).toBe('http://localhost/d')
    expect(s.canGoForward).toBe(false)
  })

  it('goBack/goForward move within history without mutating it', () => {
    const st = useBrowserPanelStore.getState()
    st.open('s1', 'http://localhost/a')
    st.navigate('s1', 'http://localhost/b')
    st.goBack('s1')
    expect(useBrowserPanelStore.getState().bySession['s1']!.url).toBe('http://localhost/a')
    expect(useBrowserPanelStore.getState().bySession['s1']!.canGoForward).toBe(true)
    st.goForward('s1')
    expect(useBrowserPanelStore.getState().bySession['s1']!.url).toBe('http://localhost/b')
  })

  it('tracks loading and picker per session', () => {
    const st = useBrowserPanelStore.getState()
    st.open('s1', 'http://localhost/a')
    st.setLoading('s1', true)
    expect(useBrowserPanelStore.getState().bySession['s1']!.loading).toBe(true)
    st.setPicker('s1', true)
    expect(useBrowserPanelStore.getState().bySession['s1']!.pickerActive).toBe(true)
  })

  it('open starts a session in the loading state', () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost/a')
    expect(useBrowserPanelStore.getState().bySession['s1']!.loading).toBe(true)
  })

  it('navigate flips loading back on', () => {
    const st = useBrowserPanelStore.getState()
    st.open('s1', 'http://localhost/a')
    st.setReady('s1') // simulate the page finishing the first load
    expect(useBrowserPanelStore.getState().bySession['s1']!.loading).toBe(false)
    st.navigate('s1', 'http://localhost/b')
    expect(useBrowserPanelStore.getState().bySession['s1']!.loading).toBe(true)
  })

  it('setNavigated clears loading and updates url/title without growing history', () => {
    const st = useBrowserPanelStore.getState()
    st.open('s1', 'http://x/a')
    expect(useBrowserPanelStore.getState().bySession['s1']!.loading).toBe(true)
    st.setNavigated('s1', 'http://x/b', 'B')
    const s = useBrowserPanelStore.getState().bySession['s1']!
    expect(s.url).toBe('http://x/b')
    expect(s.title).toBe('B')
    expect(s.loading).toBe(false)
    expect(s.history).toEqual(['http://x/a'])
  })

  it('setReady clears loading', () => {
    const st = useBrowserPanelStore.getState()
    st.open('s1', 'http://x/a')
    expect(useBrowserPanelStore.getState().bySession['s1']!.loading).toBe(true)
    st.setReady('s1')
    expect(useBrowserPanelStore.getState().bySession['s1']!.loading).toBe(false)
  })
})
