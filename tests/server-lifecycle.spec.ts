/**
 * ComfyUI server lifecycle: process targeting, start refusal, and the states
 * the Images panel reports. The process list and the HTTP endpoint are the two
 * external facts, so both are stubbed; everything else is the real service.
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }))
vi.mock('node:child_process', () => ({
  execFile: mocks.execFile,
  spawn: mocks.spawn,
}))

const { ComfyImagesController } = await import('../src/index.ts')

const signal = (): AbortSignal => new AbortController().signal

/** Answer the promisified `execFile` with one process list. */
function processList(...answers: readonly string[]): void {
  let index = 0
  mocks.execFile.mockImplementation((...args: readonly unknown[]) => {
    const done = args[args.length - 1]
    const stdout = answers[Math.min(index, answers.length - 1)] ?? ''
    index += 1
    // Real `execFile` carries a custom promisify that settles to
    // `{ stdout, stderr }`. The replaced mock answers that settled value as the
    // callback's success argument, because replacing the function drops the
    // custom symbol and pass-by-position is then what promisify resolves.
    if (typeof done === 'function') (done as (error: unknown, value: unknown) => void)(null, { stdout, stderr: '' })
  })
}

/** Stub the endpoint: every probe fails, so ComfyUI never answers. */
function endpointDown(): void {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('refused') }))
}

let root: string | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  mocks.execFile.mockReset()
  mocks.spawn.mockReset()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A directory holding a plausible interpreter and main.py. */
async function serverPaths(): Promise<{ readonly python: string; readonly cwd: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-comfy-server-'))
  const python = join(root, 'python.exe')
  await writeFile(python, '')
  await writeFile(join(root, 'main.py'), '')
  return { python, cwd: root }
}

describe('ComfyUI server lifecycle', () => {
  it('stops ComfyUI by its command line and never a process that merely holds the port', async () => {
    const killed: number[] = []
    vi.spyOn(process, 'kill').mockImplementation((pid: number) => { killed.push(pid); return true })
    endpointDown()
    // The list query answers with ComfyUI's pids, then empty once they are gone.
    processList('[51372,19912]', '[]')
    const controller = new ComfyImagesController(new Context(), { serverStartTimeoutMs: 1_000 })

    const result = await controller.stopServer(signal())

    expect(killed).toEqual([51372, 19912])
    expect(result.running).toBe(false)
    expect(result.detail).toBe('Stopped ComfyUI (2 processes).')
    // The match is the command line running main.py on the configured port, so
    // a daemon holding that port is never a candidate.
    const script = String((mocks.execFile.mock.calls[0] as readonly unknown[])[1])
    expect(script).toContain('main\\.py')
    expect(script).toContain('8188')
    expect(script).not.toContain('Get-NetTCPConnection')
  })

  it('reports that nothing was running instead of pretending it stopped something', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    endpointDown()
    processList('')
    const controller = new ComfyImagesController(new Context())

    const result = await controller.stopServer(signal())

    expect(kill).not.toHaveBeenCalled()
    expect(result).toEqual({ running: false, detail: 'No ComfyUI process was running.' })
  })

  it('refuses to start when the profile names no interpreter', async () => {
    endpointDown()
    const controller = new ComfyImagesController(new Context())

    const result = await controller.startServer(signal())

    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(result.running).toBe(false)
    expect(result.detail).toContain('Set the ComfyUI interpreter and server directory')
  })

  it('refuses to start when the configured interpreter is missing', async () => {
    endpointDown()
    const controller = new ComfyImagesController(new Context(), {
      serverPythonPath: join(tmpdir(), 'dsh-absent-interpreter.exe'),
      serverDirectory: tmpdir(),
    })

    const result = await controller.startServer(signal())

    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(result.detail).toContain('interpreter not found')
  })

  it('starts ComfyUI detached and reports a start that never answers', async () => {
    endpointDown()
    const paths = await serverPaths()
    const unref = vi.fn()
    mocks.spawn.mockReturnValue({ unref })
    const controller = new ComfyImagesController(new Context(), {
      serverPythonPath: paths.python,
      serverDirectory: paths.cwd,
      serverStartTimeoutMs: 1_000,
    })

    const result = await controller.startServer(signal())

    // Detached and unreferenced: the server must outlive the application.
    expect(mocks.spawn).toHaveBeenCalledWith(
      paths.python,
      ['main.py', '--port', '8188', '--listen', '127.0.0.1', '--disable-auto-launch'],
      expect.objectContaining({ detached: true }),
    )
    expect(unref).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ running: false, detail: 'ComfyUI did not answer within 1s.' })
  })

  it('stops before it starts, so a restart cannot leave two servers running', async () => {
    const killed: number[] = []
    vi.spyOn(process, 'kill').mockImplementation((pid: number) => { killed.push(pid); return true })
    endpointDown()
    processList('[100]', '[]')
    const paths = await serverPaths()
    mocks.spawn.mockReturnValue({ unref: vi.fn() })
    const controller = new ComfyImagesController(new Context(), {
      serverPythonPath: paths.python,
      serverDirectory: paths.cwd,
      serverStartTimeoutMs: 1_000,
    })

    const result = await controller.restartServer(signal())

    expect(killed).toEqual([100])
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(result.detail).toBe('ComfyUI did not answer within 1s.')
  })

  it('reports the running server instead of starting a second one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const controller = new ComfyImagesController(new Context())

    const result = await controller.startServer(signal())

    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(result).toEqual({ running: true, detail: 'ComfyUI was already running.' })
  })

  it('reports a start that succeeds once the new server answers', async () => {
    let probes = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      probes += 1
      // Down for the pre-flight check, up once the spawned server reports in.
      if (probes === 1) throw new Error('refused')
      return new Response('{}', { status: 200 })
    }))
    const paths = await serverPaths()
    mocks.spawn.mockReturnValue({ unref: vi.fn() })
    const controller = new ComfyImagesController(new Context(), {
      serverPythonPath: paths.python,
      serverDirectory: paths.cwd,
      serverStartTimeoutMs: 5_000,
    })

    const result = await controller.startServer(signal())

    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ running: true, detail: 'ComfyUI started.' })
  })

  it('says so when ComfyUI refuses to stop, and a restart leaves it alone', async () => {
    vi.useFakeTimers()
    try {
      vi.spyOn(process, 'kill').mockImplementation(() => true)
      // The endpoint keeps answering: the process survived the signal.
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
      // Every list query still names the process, so the stop wait runs out.
      processList('[777]')
      const controller = new ComfyImagesController(new Context())

      const stopping = controller.stopServer(signal())
      await vi.advanceTimersByTimeAsync(31_000)
      expect(await stopping).toEqual({ running: true, detail: 'ComfyUI did not stop.' })

      const restarting = controller.restartServer(signal())
      await vi.advanceTimersByTimeAsync(31_000)
      const result = await restarting
      // A server that would not stop is not started again on top of itself.
      expect(result).toEqual({ running: true, detail: 'ComfyUI did not stop.' })
      expect(mocks.spawn).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
