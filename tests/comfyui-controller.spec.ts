import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  basicTextToImageWorkflow,
  ComfyImagesController,
  generationsOf,
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
      }],
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
