import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppShell } from '@desktop/components/layout/AppShell'
import { runWebRuntimeBootstrap } from '@desktop/lib/desktopRuntime'
import './styles.css'

runWebRuntimeBootstrap()

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Missing #root element in index.html')

createRoot(rootElement).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
)
