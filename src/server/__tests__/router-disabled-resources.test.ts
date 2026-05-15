import { describe, expect, it } from 'bun:test'
import { handleApiRequest } from '../router.js'

async function dispatch(method: string, pathname: string) {
  const req = new Request(`http://localhost${pathname}`, { method })
  const url = new URL(req.url)
  return handleApiRequest(req, url)
}

describe('router (SaaS profile)', () => {
  it.each([
    '/api/computer-use',
    '/api/h5-access',
    '/api/haha-oauth',
    '/api/haha-openai-oauth',
    '/api/doctor',
  ])('returns 404 for %s', async (path) => {
    const res = await dispatch('GET', path)
    expect(res.status).toBe(404)
  })
})
