import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  basicTextToImageWorkflow,
  ComfyImagesController,
  generationsOf,
  imageToImageWorkflow,
  savedTextToImageWorkflow,
  zImageTurboWorkflow,
} from '../src/index.ts'
import type { ComfyGenerateRequest } from '../src/types.ts'

const signal = (): AbortSignal => new AbortController().signal

const request: ComfyGenerateRequest = {
  prompt: 'an illustrated robot',
  negativePrompt: 'blurry',
  model: 'checkpoint:arya.safetensors',
  workflow: 'built-in:standard',
  width: 1024,
  height: 1024,
  steps: 24,
  cfg: 7,
  seed: 42,
  batchSize: 2,
  sourceImage: null,
  denoise: 1,
}

afterEach(() => { vi.unstubAllGlobals() })

describe('ComfyImagesController', () => {
  it('builds a standard-node graph whose sampler and output remain connected', () => {
    const graph = basicTextToImageWorkflow(request, 'arya.safetensors', 42, 'AryaAI')
    expect(graph['5']).toMatchObject({
      class_type: 'KSampler',
      inputs: { seed: 42, model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0] },
    })
    expect(graph['7']).toEqual({ class_type: 'SaveImage', inputs: { filename_prefix: 'AryaAI', images: ['6', 0] } })
  })

  it('builds the official Z-Image Turbo split-model graph', () => {
    const graph = zImageTurboWorkflow(request, {
      diffusionModel: 'z_image_turbo_bf16.safetensors',
      textEncoder: 'qwen_3_4b.safetensors',
      vae: 'ae.safetensors',
    }, 42, 'AryaAI')
    expect(graph['1']).toEqual({
      class_type: 'UNETLoader', inputs: { unet_name: 'z_image_turbo_bf16.safetensors', weight_dtype: 'default' },
    })
    expect(graph['2']).toMatchObject({ class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_4b.safetensors', type: 'lumina2' } })
    expect(graph['6']).toMatchObject({ class_type: 'EmptySD3LatentImage' })
    expect(graph['7']).toMatchObject({
      class_type: 'KSampler',
      inputs: { seed: 42, model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0], scheduler: 'simple' },
    })
    expect(graph['9']).toEqual({ class_type: 'SaveImage', inputs: { filename_prefix: 'AryaAI', images: ['8', 0] } })
  })

  it('uses an uploaded image as the sampler latent while retaining the chosen sampler', () => {
    const graph = zImageTurboWorkflow(request, {
      diffusionModel: 'z_image_turbo_bf16.safetensors', textEncoder: 'qwen_3_4b.safetensors', vae: 'ae.safetensors',
    }, 42, 'AryaAI')
    imageToImageWorkflow(graph, 'source.png', 0.55)
    expect(graph['6']).toBeUndefined()
    expect(graph['10']).toEqual({ class_type: 'LoadImage', inputs: { image: 'source.png' } })
    expect(graph['11']).toEqual({ class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['3', 0] } })
    expect(graph['7']?.inputs).toMatchObject({ sampler_name: 'euler', latent_image: ['11', 0], denoise: 0.55 })
  })

  it('lists retained output files independently of history and removes only the selected file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arya-comfy-library-'))
    try {
      await mkdir(join(root, 'archive'))
      await writeFile(join(root, 'older.png'), 'older')
      await writeFile(join(root, 'archive', 'chosen.webp'), 'chosen')
      const controller = new ComfyImagesController(new Context(), { outputDirectory: root })
      const first = await controller.library({ offset: 0, limit: 1 }, signal())
      const second = await controller.library({ offset: 1, limit: 1 }, signal())
      expect(first.total).toBe(2)
      expect([...first.images, ...second.images].map(item => item.image.filename).sort()).toEqual(['chosen.webp', 'older.png'])
      await expect(controller.deleteImage({ filename: 'older.png', subfolder: '..', type: 'output' }, signal())).rejects.toThrow()
      await controller.deleteImage({ filename: 'chosen.webp', subfolder: 'archive', type: 'output' }, signal())
      await expect(readFile(join(root, 'archive', 'chosen.webp'))).rejects.toThrow()
      expect((await controller.library({ offset: 0, limit: 10 }, signal())).total).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('restores saved workflow names for old history and explicit metadata for new history', () => {
    const graph = basicTextToImageWorkflow(request, 'arya.safetensors', 42, 'hmi-doc')
    const history = {
      old: { prompt: [1, graph, {}, { client_id: 'legacy' }, []], outputs: {} },
      current: {
        prompt: [2, graph, {}, {
          aryaai: { workflowId: 'saved:Modern-Deck-Background.json', workflowLabel: 'Modern-Deck-Background' },
        }, []],
        outputs: {},
      },
    }

    const generations = generationsOf(history, [{
      id: 'saved:HMI-Doc-Schematic.json', label: 'HMI-Doc-Schematic', outputPrefixes: ['hmi-doc'],
    }])

    expect(generations.map(({ promptId, workflow, workflowLabel }) => ({ promptId, workflow, workflowLabel }))).toEqual([
      { promptId: 'current', workflow: 'saved:Modern-Deck-Background.json', workflowLabel: 'Modern-Deck-Background' },
      { promptId: 'old', workflow: 'saved:HMI-Doc-Schematic.json', workflowLabel: 'HMI-Doc-Schematic' },
    ])
  })

  it('preserves compatible saved-workflow nodes and applies composer values', () => {
    const graph = savedTextToImageWorkflow({
      nodes: [
        { id: 1, type: 'UNETLoader', mode: 0, inputs: [], widgetsValues: ['z_image_turbo_bf16.safetensors', 'default'] },
        { id: 2, type: 'ModelSamplingAuraFlow', mode: 0, inputs: [{ name: 'model', link: 1 }], widgetsValues: [3, 'flow'] },
        { id: 3, type: 'CLIPLoader', mode: 0, inputs: [], widgetsValues: ['qwen_3_4b.safetensors', 'lumina2', 'default'] },
        { id: 4, type: 'CLIPTextEncode', mode: 0, inputs: [{ name: 'clip', link: 2 }], widgetsValues: ['saved prompt'] },
        { id: 5, type: 'ConditioningZeroOut', mode: 0, inputs: [{ name: 'conditioning', link: 3 }], widgetsValues: [] },
        { id: 6, type: 'EmptySD3LatentImage', mode: 0, inputs: [], widgetsValues: [768, 768, 1] },
        { id: 7, type: 'KSampler', mode: 0, inputs: [
          { name: 'model', link: 4 }, { name: 'positive', link: 5 }, { name: 'negative', link: 6 }, { name: 'latent_image', link: 7 },
        ], widgetsValues: [0, 'randomize', 8, 1, 'res_multistep', 'simple', 1] },
        { id: 8, type: 'VAELoader', mode: 0, inputs: [], widgetsValues: ['ae.safetensors'] },
        { id: 9, type: 'VAEDecode', mode: 0, inputs: [{ name: 'samples', link: 8 }, { name: 'vae', link: 9 }], widgetsValues: [] },
        { id: 10, type: 'SaveImage', mode: 0, inputs: [{ name: 'images', link: 10 }], widgetsValues: ['zimage-turbo'] },
      ],
      links: [
        [1, 1, 0, 2, 0], [2, 3, 0, 4, 0], [3, 4, 0, 5, 0], [4, 2, 0, 7, 0], [5, 4, 0, 7, 1],
        [6, 5, 0, 7, 2], [7, 6, 0, 7, 3], [8, 7, 0, 9, 0], [9, 8, 0, 9, 1], [10, 9, 0, 10, 0],
      ],
    }, { ...request, prompt: 'Arya prompt', width: 1024, height: 1024, steps: 8, cfg: 1 }, 77, 'AryaAI')

    expect(graph['2']).toMatchObject({ class_type: 'ModelSamplingAuraFlow', inputs: { shift: 3, sampling: 'flow' } })
    expect(graph['4']).toMatchObject({ inputs: { text: 'Arya prompt', clip: ['3', 0] } })
    expect(graph['7']).toMatchObject({ inputs: { seed: 77, steps: 8, cfg: 1, sampler_name: 'res_multistep' } })
    expect(graph['10']).toMatchObject({ inputs: { filename_prefix: 'AryaAI', images: ['9', 0] } })
  })

  it('discovers checkpoints and a split Z-Image Turbo installation', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(Response.json({
        CheckpointLoaderSimple: { input: { required: { ckpt_name: [['arya.safetensors', 'flux.safetensors'], {}] } } },
      }))
      .mockResolvedValueOnce(Response.json({
        UNETLoader: { input: { required: { unet_name: [['z_image_turbo_bf16.safetensors']] } } },
      }))
      .mockResolvedValueOnce(Response.json({
        CLIPLoader: { input: { required: { clip_name: [['qwen_3_4b.safetensors']] } } },
      }))
      .mockResolvedValueOnce(Response.json({
        VAELoader: { input: { required: { vae_name: [['ae.safetensors']] } } },
      }))
    vi.stubGlobal('fetch', fetch)
    const controller = new ComfyImagesController(new Context(), { baseUrl: 'http://127.0.0.1:8188/' })

    await expect(controller.status(signal())).resolves.toEqual({
      reachable: true,
      baseUrl: 'http://127.0.0.1:8188',
      models: [
        {
          id: 'z-image-turbo:z_image_turbo_bf16.safetensors', label: 'Z-Image Turbo', kind: 'z-image-turbo',
          recommendedSteps: 9, recommendedCfg: 1,
        },
        {
          id: 'checkpoint:arya.safetensors', label: 'arya.safetensors', kind: 'checkpoint',
          recommendedSteps: 24, recommendedCfg: 7,
        },
        {
          id: 'checkpoint:flux.safetensors', label: 'flux.safetensors', kind: 'checkpoint',
          recommendedSteps: 24, recommendedCfg: 7,
        },
      ],
      workflows: [{
        id: 'built-in:standard', label: 'Z-Image Turbo · AryaAI standard', source: 'built-in', available: true,
        unavailableReason: null, recommendedSteps: 9, recommendedCfg: 1, supportsNegativePrompt: false,
        modelId: 'z-image-turbo:z_image_turbo_bf16.safetensors',
        starterPrompt: '', width: 1024, height: 1024, batchSize: 1,
      }],
      libraryAvailable: false,
      error: null,
    })
  })

  it('interrupts only when the requested prompt is the running job', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ queue_running: [[1, 'different-prompt', {}, {}]], queue_pending: [] }))
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({ queue_running: [[2, 'owned-prompt', {}, {}]], queue_pending: [] }))
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({}))
    vi.stubGlobal('fetch', fetch)
    const controller = new ComfyImagesController(new Context())

    await controller.cancel({ promptId: 'queued-prompt' }, signal())
    await controller.cancel({ promptId: 'owned-prompt' }, signal())

    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:8188/queue',
      'http://127.0.0.1:8188/queue',
      'http://127.0.0.1:8188/queue',
      'http://127.0.0.1:8188/queue',
      'http://127.0.0.1:8188/interrupt',
    ])
  })

  it('removes one completed generation from ComfyUI history', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const controller = new ComfyImagesController(new Context())

    await controller.deleteGeneration({ promptId: 'completed-prompt' }, signal())

    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:8188/history', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ delete: ['completed-prompt'] }),
    }))
  })
})
