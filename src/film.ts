/** CPU assembly of retained ComfyUI clips into a new MP4. */
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { localMedia } from './media.ts'
import type { ComfyFilmRequest, ComfyFilmResult } from './types.ts'

async function command(
  runtime: SubprocessRuntime, executable: string, args: string[], cwd: string, signal: AbortSignal, probe = false,
): Promise<string> {
  const process = runtime.spawn({ argv: [executable, ...args], cwd, signal, graceMs: 2000,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } } })
  try {
    const outcome = await process.done
    signal.throwIfAborted()
    const text = process.collected.stderr?.readFrom(0).text ?? ''
    if (!probe && outcome.exitCode !== 0) throw new Error(`Video assembly failed: ${text.slice(-4000)}`)
    return text
  } finally { process.terminate(); await process.waitForExit() }
}

function timestamp(seconds: number): string {
  const ms = Math.round(seconds * 1000)
  return `${Math.floor(ms / 3600000).toString().padStart(2, '0')}:${Math.floor(ms / 60000 % 60).toString().padStart(2, '0')}:${Math.floor(ms / 1000 % 60).toString().padStart(2, '0')},${(ms % 1000).toString().padStart(3, '0')}`
}

/** Assemble validated local clips with trims, cuts or fades, native audio and optional captions.
 * @param runtime - Local subprocess provider managing cancellation and child cleanup.
 * @param executable - Deployment FFmpeg executable.
 * @param root - Configured ComfyUI output folder.
 * @param request - Ordered clips and output settings.
 * @param signal - Cancels probing and assembly.
 * @param encoding - Deployment limits and H.264 quality settings.
 * @returns New film reference after the encoder has completed.
 */
export async function assembleFilm(
  runtime: SubprocessRuntime, executable: string, root: string, request: ComfyFilmRequest,
  signal: AbortSignal, encoding: { maxSeconds: number; crf: number; preset: string },
): Promise<ComfyFilmResult> {
  const { width, height, frameRate: fps, fadeSeconds: fade } = request
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 64 || height < 64 || width > 4096 || height > 4096 || width % 2 || height % 2) throw new Error('Film dimensions must be even integers from 64 to 4096')
  if (!Number.isFinite(fps) || fps < 1 || fps > 60 || !Number.isFinite(fade) || fade < 0 || fade > 2) throw new Error('Invalid film frame rate or transition length')
  if (request.clips.length < 1 || request.clips.length > 100) throw new Error('Choose 1 to 100 clips')
  const clips = []
  for (const clip of request.clips) {
    const media = await localMedia(root, clip.media)
    if (!['.mp4', '.mov', '.webm', '.mkv'].includes(extname(media.path).toLowerCase())) throw new Error('Film inputs must be video clips')
    const text = await command(runtime, executable, ['-hide_banner', '-nostdin', '-i', media.path], root, signal, true)
    const match = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/u.exec(text)
    if (match === null || !/Video:/u.test(text)) throw new Error('Could not read the clip duration')
    const duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
    const start = clip.startSeconds ?? 0
    const seconds = clip.seconds ?? duration - start
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(seconds) || seconds <= fade || start + seconds > duration + 0.05) throw new Error('Clip trim is outside its duration or shorter than its transition')
    if (clip.caption !== undefined && (clip.caption.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(clip.caption))) throw new Error('Invalid clip caption')
    clips.push({ ...clip, path: media.path, start, seconds, audio: /Audio:/u.test(text) })
  }
  const seconds = clips.reduce((sum, clip) => sum + clip.seconds, 0) - fade * (clips.length - 1)
  if (seconds > encoding.maxSeconds) throw new Error(`Assembled film exceeds ${encoding.maxSeconds} seconds`)
  const temporary = await mkdtemp(join(root, '.arya-film-'))
  const filename = `AryaFilm-${randomUUID()}.mp4`
  const output = join(root, filename)
  let committed = false
  try {
    const args = ['-hide_banner', '-nostdin', '-n']
    for (const clip of clips) args.push('-i', clip.path)
    const filters: string[] = []
    const captions: string[] = []
    let offset = 0
    for (const [index, clip] of clips.entries()) {
      filters.push(`[${index}:v]trim=start=${clip.start}:duration=${clip.seconds},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p,settb=AVTB[v${index}]`)
      filters.push(clip.audio
        ? `[${index}:a]atrim=start=${clip.start}:duration=${clip.seconds},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${clip.seconds}[a${index}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${clip.seconds}[a${index}]`)
      if (clip.caption?.trim()) captions.push(`${captions.length + 1}\n${timestamp(offset)} --> ${timestamp(offset + clip.seconds - (index < clips.length - 1 ? fade : 0))}\n${clip.caption.trim()}\n`)
      offset += clip.seconds - (index < clips.length - 1 ? fade : 0)
    }
    let video = 'v0'; let audio = 'a0'; let elapsed = clips[0]?.seconds ?? 0
    if (fade > 0 && clips.length > 1) {
      for (let index = 1; index < clips.length; index++) {
        filters.push(`[${video}][v${index}]xfade=transition=fade:duration=${fade}:offset=${elapsed - fade}[vx${index}]`)
        filters.push(`[${audio}][a${index}]acrossfade=d=${fade}[ax${index}]`)
        video = `vx${index}`; audio = `ax${index}`; elapsed += (clips[index]?.seconds ?? 0) - fade
      }
    } else {
      filters.push(clips.map((_clip, index) => `[v${index}][a${index}]`).join('') + `concat=n=${clips.length}:v=1:a=1[vout][aout]`)
      video = 'vout'; audio = 'aout'
    }
    if (captions.length > 0) {
      const captionFile = join(temporary, 'captions.srt')
      await writeFile(captionFile, captions.join('\n'), { mode: 0o600 })
      args.push('-i', captionFile)
    }
    args.push('-filter_complex', filters.join(';'), '-map', `[${video}]`, '-map', `[${audio}]`)
    if (captions.length > 0) args.push('-map', `${clips.length}:0`, '-c:s', 'mov_text')
    args.push('-t', String(seconds), '-c:v', 'libx264', '-preset', encoding.preset, '-crf', String(encoding.crf), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', output)
    await command(runtime, executable, args, root, signal)
    if ((await stat(output)).size === 0) throw new Error('Video assembly produced an empty file')
    committed = true
    return { media: { filename, subfolder: '', type: 'output' }, seconds, clips: clips.length }
  } finally {
    await rm(temporary, { recursive: true, force: true })
    if (!committed) await rm(output, { force: true })
  }
}
