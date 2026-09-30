import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { comfyArchiveResponse, comfyMediaResponse } from '../src/media.ts'
import type { ComfyImageReference } from '../src/types.ts'

function reference(filename: string, subfolder = ''): ComfyImageReference {
  return { filename, subfolder, type: 'output' }
}

describe('local ComfyUI media', () => {
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
