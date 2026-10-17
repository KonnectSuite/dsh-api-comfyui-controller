import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { assembleFilm } from '../src/film.ts'

const executable = process.env.ARYA_FFMPEG_TEST_PATH

it.skipIf(executable === undefined)('assembles silent and audio clips with trims, fades and embedded captions', async () => {
  if (executable === undefined) throw new Error('Set ARYA_FFMPEG_TEST_PATH for the local encoder smoke')
  const root = await mkdtemp(join(tmpdir(), 'arya-film-smoke-'))
  const ctx = new Context()
  try {
    await ctx.plugin(LocalSubprocess)
    const runtime = ctx.subprocess
    for (const [filename, audio] of [['silent.mp4', false], ['sound.mp4', true]] as const) {
      const args = ['-hide_banner', '-nostdin', '-n', '-f', 'lavfi', '-i', 'color=c=blue:s=128x96:r=24:d=1']
      if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac')
      args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(root, filename))
      const child = runtime.spawn({ argv: [executable, ...args], cwd: root, graceMs: 2000,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } } })
      expect((await child.done).exitCode).toBe(0)
      await child.waitForExit()
    }
    const signal = new AbortController().signal
    const clips = [
      { media: { filename: 'silent.mp4', subfolder: '', type: 'output' }, caption: 'A quiet scene' },
      { media: { filename: 'sound.mp4', subfolder: '', type: 'output' }, startSeconds: 0.1, seconds: 0.8 },
    ]
    const result = await assembleFilm(runtime, executable, root, { clips, width: 128, height: 96, frameRate: 24, fadeSeconds: 0.1 }, signal, { maxSeconds: 1800, crf: 20, preset: 'medium' })
    expect(result.seconds).toBeCloseTo(1.7)
    expect((await stat(join(root, result.media.filename))).size).toBeGreaterThan(1000)
    const probe = runtime.spawn({ argv: [executable, '-hide_banner', '-nostdin', '-i', join(root, result.media.filename)], cwd: root, graceMs: 2000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } } })
    await probe.done
    await probe.waitForExit()
    expect(probe.collected.stderr?.readFrom(0).text).toContain('Subtitle: mov_text')
    expect((await readdir(root)).filter(name => name.startsWith('.arya-film-'))).toEqual([])
    await expect(assembleFilm(runtime, executable, root, { clips: [{ ...clips[0]!, seconds: 100 }], width: 128, height: 96, frameRate: 24, fadeSeconds: 0 }, signal, { maxSeconds: 1800, crf: 20, preset: 'medium' })).rejects.toThrow('outside')
    expect((await readdir(root)).filter(name => name.startsWith('AryaFilm-'))).toHaveLength(1)
    await expect(assembleFilm(runtime, executable, root, { clips: [{ media: { filename: 'silent.mp4', subfolder: '../outside', type: 'output' } }], width: 128, height: 96, frameRate: 24, fadeSeconds: 0 }, signal, { maxSeconds: 1800, crf: 20, preset: 'medium' })).rejects.toThrow('outside')
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})
