import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { comfyArchiveResponse, comfyRemoteArchiveResponse, comfyMediaResponse } from '../src/media.ts'
import type { ComfyImageReference } from '../src/types.ts'

function reference(filename: string, subfolder = ''): ComfyImageReference {
  return { filename, subfolder, type: 'output' }
}

describe('local ComfyUI media', () => {
  it('downloads remote outputs without a local directory and rejects invalid archive names before fetching', async () => {
    const files = [reference('picture.png'), reference('clip.webm', 'nested')]
    const url = `http://localhost/api/comfyui-archive?${new URLSearchParams({ files: JSON.stringify(files) })}`
    const calls: string[] = []
    const fetchMedia = async (image: ComfyImageReference, method: 'GET' | 'HEAD'): Promise<Response> => {
      calls.push(`${method}:${image.filename}`)
      return new Response(method === 'HEAD' ? null : image.filename)
    }
    const response = await comfyRemoteArchiveResponse(new Request(url), fetchMedia)
    const archive = unzipSync(new Uint8Array(await response.arrayBuffer()))
    expect(new TextDecoder().decode(archive['picture.png'])).toBe('picture.png')
    expect(new TextDecoder().decode(archive['nested/clip.webm'])).toBe('clip.webm')
    expect(calls).toEqual(['HEAD:picture.png', 'HEAD:clip.webm', 'GET:picture.png', 'GET:clip.webm'])
    for (const invalid of [reference('../picture.png'), reference('picture.png', '..'),
      reference('picture.png', '/root'), reference('script.exe'), reference('picture.png', 'a/../b')]) {
      const before = calls.length
      const denied = await comfyRemoteArchiveResponse(new Request(`http://localhost/api/comfyui-archive?${new URLSearchParams({ files: JSON.stringify([invalid]) })}`), fetchMedia)
      expect(denied.status).toBe(400)
      expect(calls).toHaveLength(before)
    }
    const missing = await comfyRemoteArchiveResponse(new Request(url), async () => new Response(null, { status: 404 }))
    expect(missing.status).toBe(400)
    const head = await comfyRemoteArchiveResponse(new Request(url, { method: 'HEAD' }), fetchMedia)
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  })
  it('streams videos with seekable byte ranges and rejects traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arya-comfy-media-'))
    try {
      await writeFile(join(root, 'clip.mp4'), 'video-bytes')
      const range = await comfyMediaResponse(root, new Request('http://localhost/api/comfyui-media?filename=clip.mp4', {
        headers: { range: 'bytes=2-6' },
      }))
      expect(range.status).toBe(206)
      expect(range.headers.get('content-type')).toBe('video/mp4')
      expect(range.headers.get('content-range')).toBe('bytes 2-6/11')
      expect(await range.text()).toBe('deo-b')

      for (const [requested, expected, contentRange] of [
        ['bytes=-5', 'bytes', 'bytes 6-10/11'],
        ['bytes=6-', 'bytes', 'bytes 6-10/11'],
        ['bytes=6-999999999999999999999', 'bytes', 'bytes 6-10/11'],
        ['bytes=-999999999999999999999', 'video-bytes', 'bytes 0-10/11'],
      ]) {
        const response = await comfyMediaResponse(root, new Request('http://localhost/api/comfyui-media?filename=clip.mp4', {
          headers: { range: requested! },
        }))
        expect(response.status).toBe(206)
        expect(response.headers.get('content-range')).toBe(contentRange)
        expect(await response.text()).toBe(expected)
      }
      for (const requested of ['bytes=11-', 'bytes=-0', 'bytes=999999999999999999999-']) {
        const response = await comfyMediaResponse(root, new Request('http://localhost/api/comfyui-media?filename=clip.mp4', {
          headers: { range: requested },
        }))
        expect(response.status).toBe(416)
        expect(response.headers.get('content-range')).toBe('bytes */11')
      }
      const head = await comfyMediaResponse(root, new Request('http://localhost/api/comfyui-media?filename=clip.mp4', {
        method: 'HEAD', headers: { range: 'bytes=2-6' },
      }))
      expect(head.status).toBe(200)
      expect(head.headers.get('content-length')).toBe('11')
      expect(head.headers.get('content-range')).toBeNull()
      expect(await head.text()).toBe('')
      for (const requested of ['items=0-1', 'bytes=0-1,4-5']) {
        const response = await comfyMediaResponse(root, new Request('http://localhost/api/comfyui-media?filename=clip.mp4', {
          headers: { range: requested },
        }))
        expect(response.status).toBe(200)
        expect(await response.text()).toBe('video-bytes')
      }
      for (const requested of ['bytes=4-2', 'bytes=-', 'bytes=invalid']) {
        const response = await comfyMediaResponse(root, new Request('http://localhost/api/comfyui-media?filename=clip.mp4', {
          headers: { range: requested },
        }))
        expect(response.status).toBe(400)
      }

      await writeFile(join(root, 'empty.mp4'), '')
      const empty = await comfyMediaResponse(root, new Request('http://localhost/api/comfyui-media?filename=empty.mp4'))
      expect(empty.status).toBe(200)
      expect(empty.headers.get('content-length')).toBe('0')
      expect(await empty.text()).toBe('')
      const emptyRange = await comfyMediaResponse(root, new Request('http://localhost/api/comfyui-media?filename=empty.mp4', {
        headers: { range: 'bytes=0-' },
      }))
      expect(emptyRange.status).toBe(416)
      expect(emptyRange.headers.get('content-range')).toBe('bytes */0')

      const escaped = await comfyMediaResponse(root, new Request('http://localhost/api/comfyui-media?filename=clip.mp4&subfolder=..'))
      expect(escaped.status).toBe(400)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('downloads mixed images and videos as one ZIP and validates all entries before streaming', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arya-comfy-archive-'))
    try {
      await mkdir(join(root, 'nested'))
      await writeFile(join(root, 'picture.png'), 'image-data')
      await writeFile(join(root, 'nested', 'clip.webm'), 'video-data')
      const files = [reference('picture.png'), reference('clip.webm', 'nested')]
      const url = `http://localhost/api/comfyui-archive?${new URLSearchParams({ files: JSON.stringify(files) })}`
      const response = await comfyArchiveResponse(root, new Request(url))
      expect(response.status).toBe(200)
      const archive = unzipSync(new Uint8Array(await response.arrayBuffer()))
      expect(new TextDecoder().decode(archive['picture.png'])).toBe('image-data')
      expect(new TextDecoder().decode(archive['nested/clip.webm'])).toBe('video-data')

      const missing = [reference('picture.png'), reference('missing.mp4')]
      const invalid = await comfyArchiveResponse(root, new Request(`http://localhost/api/comfyui-archive?${new URLSearchParams({ files: JSON.stringify(missing) })}`))
      expect(invalid.status).toBe(400)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
