import { describe, expect, it } from 'bun:test'
import { corsHeaders } from './cors'

describe('corsHeaders', () => {
  it('allows localhost browser origins', () => {
    expect(corsHeaders('http://127.0.0.1:1420')['Access-Control-Allow-Origin']).toBe('http://127.0.0.1:1420')
    expect(corsHeaders('http://localhost:3000')['Access-Control-Allow-Origin']).toBe('http://localhost:3000')
  })

  it('falls back for unknown origins', () => {
    expect(corsHeaders('tauri://localhost')['Access-Control-Allow-Origin']).toBe('http://localhost:3000')
    expect(corsHeaders('https://example.com')['Access-Control-Allow-Origin']).toBe('http://localhost:3000')
    expect(corsHeaders(null)['Access-Control-Allow-Origin']).toBe('http://localhost:3000')
  })
})
