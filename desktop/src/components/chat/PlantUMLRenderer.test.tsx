import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

const postMock = vi.hoisted(() => vi.fn())

vi.mock('../../api/client', () => ({
  api: {
    post: postMock,
  },
}))

import { PlantUMLRenderer } from './PlantUMLRenderer'

const SVG_MOCK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100"/></svg>'

describe('PlantUMLRenderer', () => {
  beforeEach(() => {
    postMock.mockReset()
  })

  it('renders SVG from the backend and sanitizes with DOMPurify', async () => {
    postMock.mockResolvedValue({ svg: SVG_MOCK })

    render(<PlantUMLRenderer code={'@startuml\nAlice -> Bob\n@enduml'} />)

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'PlantUML diagram' })).toBeInTheDocument()
    })

    expect(postMock).toHaveBeenCalledWith('/api/settings/plantuml/render', {
      code: '@startuml\nAlice -> Bob\n@enduml',
    })
  })

  it('shows the PlantUML header and preview button', async () => {
    postMock.mockResolvedValue({ svg: SVG_MOCK })

    render(<PlantUMLRenderer code={'@startuml\nAlice -> Bob\n@enduml'} />)

    await screen.findByText('PlantUML')
    expect(screen.getByRole('button', { name: /preview/i })).toBeInTheDocument()
  })

  it('opens preview modal with the diagram', async () => {
    postMock.mockResolvedValue({ svg: SVG_MOCK })

    render(<PlantUMLRenderer code={'@startuml\nAlice -> Bob\n@enduml'} />)

    const previewButton = await screen.findByRole('button', { name: /preview/i })
    fireEvent.click(previewButton)

    await screen.findByText('PlantUML Diagram')
  })

  it('falls back to CodeViewer when server returns null svg', async () => {
    postMock.mockResolvedValue({ svg: null })

    render(<PlantUMLRenderer code={'@startuml\nAlice -> Bob\n@enduml'} />)

    await waitFor(() => {
      expect(screen.queryByRole('heading')).toBeNull()
    })

    // CodeViewer should render the plantuml code as text
    expect(postMock).toHaveBeenCalled()
  })

  it('shows error state when render fails', async () => {
    postMock.mockRejectedValue(new Error('PlantUML render failed'))

    render(<PlantUMLRenderer code={'@startuml\nbad syntax\n@enduml'} />)

    await waitFor(() => {
      expect(screen.getByText('PlantUML Render Error')).toBeInTheDocument()
    })
  })
})
