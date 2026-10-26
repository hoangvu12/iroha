import { describe, expect, test } from 'bun:test'
import { gunzipSync } from 'node:zlib'
import { compressResponse } from '../../src/http/compression.ts'

function gzipRequest(path = 'http://iroha.test/thing', accept = 'gzip, deflate'): Request {
  return new Request(path, { headers: { 'accept-encoding': accept } })
}

function bodyResponse(body: string, contentType: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } })
}

const LARGE = 'a'.repeat(4_000)

describe('compressResponse', () => {
  test('gzip-compresses a large compressible response', async () => {
    const result = await compressResponse(gzipRequest(), bodyResponse(LARGE, 'text/html'))
    expect(result).toBeInstanceOf(Response)
    const response = result as Response
    expect(response.headers.get('content-encoding')).toBe('gzip')
    expect(response.headers.get('vary')?.toLowerCase()).toContain('accept-encoding')
    const decoded = gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8')
    expect(decoded).toBe(LARGE)
  })

  test('leans on the existing Vary header rather than replacing it', async () => {
    const original = bodyResponse(LARGE, 'application/json')
    original.headers.set('vary', 'Origin')
    const response = (await compressResponse(gzipRequest(), original)) as Response
    expect(response.headers.get('vary')).toContain('Origin')
    expect(response.headers.get('vary')?.toLowerCase()).toContain('accept-encoding')
  })

  test('never compresses text/event-stream', async () => {
    const original = bodyResponse(LARGE, 'text/event-stream')
    const result = await compressResponse(gzipRequest(), original)
    expect(result).toBe(original)
  })

  test('skips when the caller did not accept gzip', async () => {
    const original = bodyResponse(LARGE, 'application/json')
    expect(await compressResponse(gzipRequest('http://iroha.test/x', 'br'), original)).toBe(original)
  })

  test('skips a response that is already encoded', async () => {
    const original = new Response(LARGE, {
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    })
    expect(await compressResponse(gzipRequest(), original)).toBe(original)
  })

  test('does not compress a body below the minimum size', async () => {
    const small = '{}'
    const response = (await compressResponse(gzipRequest(), bodyResponse(small, 'application/json'))) as Response
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(await response.text()).toBe(small)
  })

  test('skips non-compressible content types', async () => {
    const original = bodyResponse(LARGE, 'image/png')
    expect(await compressResponse(gzipRequest(), original)).toBe(original)
  })

  test('skips bodyless responses', async () => {
    const noContent = new Response(null, { status: 204 })
    expect(await compressResponse(gzipRequest(), noContent)).toBe(noContent)
  })
})