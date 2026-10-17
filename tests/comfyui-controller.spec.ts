import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  absentCheckpoint,
  basicTextToImageWorkflow,
  ComfyImagesController,
  generationsOf,
  imageToImageWorkflow,
  injectSourceImage,
  savedTextToImageWorkflow,
  savedSamplerSettings,
  savedWorkflowOf,
  savedWorkflowOutput,
  savedWorkflowTask,
  savedWorkflowTakesPrompt,
  zImageTurboWorkflow,
} from '../src/index.ts'
import { fluxReferenceWorkflow } from '../src/flux.ts'
import type { ComfyGenerateRequest } from '../src/types.ts'

const signal = (): AbortSignal => new AbortController().signal

/** A saved FLUX.2 Klein reference edit as the frontend stores it: no KSampler, its
 * sampling split across RandomNoise, Flux2Scheduler and CFGGuider, and a latent sized
 * from the reference image rather than from the composer. */
function kleinEditGraph() {
  return {
    nodes: [
      { id: 1, type: 'UNETLoader', mode: 0, inputs: [], widgetsValues: ['flux-2-klein-4b-fp8.safetensors', 'default'] },
      { id: 2, type: 'CLIPLoader', mode: 0, inputs: [], widgetsValues: ['qwen_3_4b.safetensors', 'flux2', 'default'] },
      { id: 3, type: 'VAELoader', mode: 0, inputs: [], widgetsValues: ['flux2-vae.safetensors'] },
      { id: 4, type: 'LoadImage', mode: 0, inputs: [], widgetsValues: ['reference.png', 'image'] },
      { id: 5, type: 'GetImageSize', mode: 0, inputs: [{ name: 'image', link: 1 }], widgetsValues: [] },
      { id: 6, type: 'CLIPTextEncode', mode: 0, inputs: [{ name: 'clip', link: 2 }], widgetsValues: ['turn the day into night'] },
      { id: 8, type: 'EmptyFlux2LatentImage', mode: 0, inputs: [{ name: 'width', link: 5 }, { name: 'height', link: 6 }], widgetsValues: [1024, 1024, 1] },
      { id: 9, type: 'RandomNoise', mode: 0, inputs: [], widgetsValues: [42] },
      { id: 10, type: 'Flux2Scheduler', mode: 0, inputs: [{ name: 'width', link: 7 }, { name: 'height', link: 8 }], widgetsValues: [20] },
      { id: 11, type: 'CFGGuider', mode: 0, inputs: [{ name: 'model', link: 9 }, { name: 'positive', link: 10 }, { name: 'negative', link: 11 }], widgetsValues: [1] },
      { id: 16, type: 'KSamplerSelect', mode: 0, inputs: [], widgetsValues: ['euler'] },
      { id: 12, type: 'SamplerCustomAdvanced', mode: 0, inputs: [
        { name: 'noise', link: 12 }, { name: 'guider', link: 13 }, { name: 'sampler', link: 14 },
        { name: 'sigmas', link: 15 }, { name: 'latent_image', link: 16 },
      ], widgetsValues: [] },
      { id: 13, type: 'VAEDecode', mode: 0, inputs: [{ name: 'samples', link: 17 }, { name: 'vae', link: 18 }], widgetsValues: [] },
      { id: 14, type: 'SaveImage', mode: 0, inputs: [{ name: 'images', link: 19 }], widgetsValues: ['klein/edit'] },
    ],
    links: [
      [1, 4, 0, 5, 0], [2, 2, 0, 6, 0], [5, 5, 0, 8, 0], [6, 5, 1, 8, 1],
      [7, 5, 0, 10, 0], [8, 5, 1, 10, 1], [9, 1, 0, 11, 0], [10, 6, 0, 11, 1], [11, 6, 0, 11, 2],
      [12, 9, 0, 12, 0], [13, 11, 0, 12, 1], [14, 16, 0, 12, 2], [15, 10, 0, 12, 3], [16, 8, 0, 12, 4],
      [17, 12, 0, 13, 0], [18, 3, 0, 13, 1], [19, 13, 0, 14, 0],
    ],
  }
}

it('reads a saved workflow\'s output kind from the node that writes it', () => {
  expect(savedWorkflowOutput([{ type: 'CheckpointLoaderSimple' }, { type: 'SaveImage' }])).toBe('image')
  expect(savedWorkflowOutput([{ type: 'SaveImage' }, { type: 'SaveVideo' }])).toBe('video')
  expect(savedWorkflowOutput([{ type: 'VHS_VideoCombine' }])).toBe('video')
})

it('reads a saved graph\'s own sampler settings from whichever sampler it uses', () => {
  const nodes = (spec: { type: string; widgetsValues: unknown[] }[]) =>
    spec.map((node, index) => ({ id: index + 1, type: node.type, mode: 0, inputs: [], widgetsValues: node.widgetsValues }))

  expect(savedSamplerSettings(nodes([{ type: 'KSampler', widgetsValues: [0, 'randomize', 28, 6, 'euler', 'normal', 1] }])))
    .toEqual({ steps: 28, cfg: 6 })
  // KSamplerAdvanced keeps a frontend reseed control at index 2 that the API does not take.
  expect(savedSamplerSettings(nodes([{
    type: 'KSamplerAdvanced', widgetsValues: ['enable', 1, 'randomize', 4, 1, 'euler', 'simple', 0, 2, 'enable'],
  }]))).toEqual({ steps: 4, cfg: 1 })
  // The Flux 2 graphs split them across two nodes, which a fixed default got wrong.
  expect(savedSamplerSettings(nodes([
    { type: 'Flux2Scheduler', widgetsValues: [20, 1024, 1024] },
    { type: 'CFGGuider', widgetsValues: [5] },
  ]))).toEqual({ steps: 20, cfg: 5 })
  expect(savedSamplerSettings(nodes([{ type: 'SaveImage', widgetsValues: ['out'] }]))).toEqual({ steps: 24, cfg: 7 })
})

it('names why a node class cannot be submitted', () => {
  const graph = (type: string) => ({
    nodes: [
      { id: 1, type, mode: 0, inputs: [], widgetsValues: [] },
      { id: 2, type: 'CLIPTextEncode', mode: 0, inputs: [], widgetsValues: ['prompt'] },
      { id: 3, type: 'KSampler', mode: 0, inputs: [], widgetsValues: [0, 'randomize', 8, 1, 'euler', 'simple', 1] },
      { id: 4, type: 'SaveImage', mode: 0, inputs: [], widgetsValues: ['out'] },
    ],
    links: [],
  })

  // A subgraph the document did not describe is not a missing install.
  expect(() => savedTextToImageWorkflow(graph('7b34ab90-36f9-45ba-a665-71d418f0df18'), request, 1, 'AryaAI'))
    .toThrow('Subgraph 7b34ab90-36f9-45ba-a665-71d418f0df18 has no definition in this workflow')
  // The frontend evaluates these itself, so no node pack supplies them.
  expect(() => savedTextToImageWorkflow(graph('ComfySwitchNode'), request, 1, 'AryaAI'))
    .toThrow('Workflow needs the ComfyUI frontend node ComfySwitchNode, which the server cannot execute')
  // Anything else is an ordinary unregistered class.
  expect(() => savedTextToImageWorkflow(graph('SomeCustomNode'), request, 1, 'AryaAI'))
    .toThrow('Unsupported workflow node: SomeCustomNode')
})

it('flattens a saved document whose graph is held in subgraph definitions', () => {
  const parsed = savedWorkflowOf({
    nodes: [
      { id: 9, type: 'PrimitiveStringMultiline', mode: 0, inputs: [], outputs: [{ name: 'STRING', type: 'STRING' }], widgets_values: ['outer'] },
      { id: 50, type: 'sub-1', mode: 0, inputs: [], outputs: [{ name: 'LATENT', type: 'LATENT' }], widgets_values: [7] },
    ],
    links: [[101, 50, 0, 9, 0]],
    definitions: {
      subgraphs: [{
        id: 'sub-1',
        inputs: [{ name: 'seed', type: 'INT', linkIds: [12] }],
        outputs: [{ name: 'LATENT', type: 'LATENT', linkIds: [13] }],
        nodes: [
          { id: 2, type: 'PrimitiveInt', mode: 0, inputs: [{ name: 'value', link: 12 }], outputs: [{ name: 'INT', type: 'INT' }], widgets_values: [0] },
          { id: 4, type: 'KSampler', mode: 0, inputs: [], outputs: [{ name: 'LATENT', type: 'LATENT' }], widgets_values: [] },
        ],
        links: [
          { id: 12, origin_id: -10, origin_slot: 0, target_id: 2, target_slot: 0 },
          { id: 13, origin_id: 4, origin_slot: 0, target_id: -20, target_slot: 0 },
        ],
      }],
    },
  })

  // The instance is replaced by its interior, and its promoted value reaches the primitive.
  expect(parsed?.nodes.map(node => node.type)).toEqual(['PrimitiveStringMultiline', 'PrimitiveInt', 'KSampler'])
  expect(parsed?.nodes.find(node => node.type === 'PrimitiveInt')?.widgetsValues[0]).toBe(7)
  expect(parsed?.nodes.some(node => node.type === 'sub-1')).toBe(false)
})

it('rejects a value that is not a workflow document', () => {
  expect(savedWorkflowOf({ nodes: [], links: [] })).toEqual({ nodes: [], links: [] })
  expect(savedWorkflowOf({ links: [] })).toBeUndefined()
  expect(savedWorkflowOf('not a document')).toBeUndefined()
  // A subgraph the document does not describe stays in place rather than vanishing.
  expect(savedWorkflowOf({
    nodes: [{ id: 50, type: 'sub-1', mode: 0, inputs: [], outputs: [], widgets_values: [] }], links: [],
  })?.nodes[0]?.type).toBe('sub-1')
})

it('sends the prompt to the encoder feeding positive rather than the first in document order', () => {
  // An expanded subgraph can list the negative encoder first. Assigning by document order then
  // swaps guidance, so the sampler runs with the prompt as its negative and an empty positive.
  const graph = savedTextToImageWorkflow({
    nodes: [
      { id: 1, type: 'CLIPTextEncode', mode: 0, inputs: [], widgetsValues: ['baked first'] },
      { id: 2, type: 'CLIPTextEncode', mode: 0, inputs: [], widgetsValues: ['baked second'] },
      { id: 3, type: 'KSampler', mode: 0, inputs: [
        { name: 'positive', link: 2 }, { name: 'negative', link: 1 },
      ], widgetsValues: [0, 'randomize', 8, 1, 'euler', 'simple', 1] },
      { id: 4, type: 'SaveImage', mode: 0, inputs: [], widgetsValues: ['out'] },
    ],
    links: [[1, 1, 0, 3, 1], [2, 2, 0, 3, 0]],
  }, { ...request, prompt: 'the prompt', negativePrompt: 'the negative' }, 1, 'AryaAI')

  // Node 1 is first in document order but feeds negative; node 2 feeds positive.
  expect(graph['2']).toMatchObject({ inputs: { text: 'the prompt' } })
  expect(graph['1']).toMatchObject({ inputs: { text: 'the negative' } })
})

it('follows a zeroed conditioning branch back to the encoder that shares it', () => {
  const graph = savedTextToImageWorkflow({
    nodes: [
      { id: 1, type: 'CLIPTextEncode', mode: 0, inputs: [], widgetsValues: ['baked'] },
      { id: 2, type: 'ConditioningZeroOut', mode: 0, inputs: [{ name: 'conditioning', link: 1 }], widgetsValues: [] },
      { id: 3, type: 'KSampler', mode: 0, inputs: [
        { name: 'positive', link: 2 }, { name: 'negative', link: 3 },
      ], widgetsValues: [0, 'randomize', 8, 1, 'euler', 'simple', 1] },
      { id: 4, type: 'SaveImage', mode: 0, inputs: [], widgetsValues: ['out'] },
    ],
    links: [[1, 1, 0, 3, 0], [2, 2, 0, 3, 0], [3, 1, 0, 3, 1]],
  }, { ...request, prompt: 'the prompt', negativePrompt: 'the negative' }, 1, 'AryaAI')

  // Positive walks back through the zero-out. Both branches share node 1, so the prompt stands
  // and the negative prompt must not overwrite it.
  expect(graph['1']).toMatchObject({ inputs: { text: 'the prompt' } })
  expect(graph['2']).toMatchObject({ class_type: 'ConditioningZeroOut', inputs: { conditioning: ['1', 0] } })
})

it('falls back to document order when the sampler states no guidance inputs', () => {
  const graph = savedTextToImageWorkflow({
    nodes: [
      { id: 1, type: 'CLIPTextEncode', mode: 0, inputs: [], widgetsValues: ['baked first'] },
      { id: 2, type: 'CLIPTextEncode', mode: 0, inputs: [], widgetsValues: ['baked second'] },
      { id: 3, type: 'SamplerCustomAdvanced', mode: 0, inputs: [{ name: 'latent_image', link: 1 }], widgetsValues: [] },
      { id: 4, type: 'EmptyFlux2LatentImage', mode: 0, inputs: [], widgetsValues: [1024, 1024, 1] },
      { id: 5, type: 'SaveImage', mode: 0, inputs: [], widgetsValues: ['out'] },
    ],
    links: [[1, 4, 0, 3, 4]],
  }, { ...request, prompt: 'the prompt', negativePrompt: 'the negative' }, 1, 'AryaAI')

  expect(graph['1']).toMatchObject({ inputs: { text: 'the prompt' } })
  expect(graph['2']).toMatchObject({ inputs: { text: 'the negative' } })
})

it('keeps document order when a guidance link is malformed', () => {
  // The positive input names a link whose source is not in the graph, and the negative names a
  // node that states no conditioning input at all. Neither yields an encoder to target.
  const graph = savedTextToImageWorkflow({
    nodes: [
      { id: 1, type: 'CLIPTextEncode', mode: 0, inputs: [], widgetsValues: ['baked first'] },
      { id: 2, type: 'CLIPTextEncode', mode: 0, inputs: [], widgetsValues: ['baked second'] },
      { id: 3, type: 'KSampler', mode: 0, inputs: [
        { name: 'positive', link: 9 }, { name: 'negative', link: 8 },
      ], widgetsValues: [0, 'randomize', 8, 1, 'euler', 'simple', 1] },
      { id: 4, type: 'SaveImage', mode: 0, inputs: [], widgetsValues: ['out'] },
    ],
    links: [[8, 1, 0, 3, 1], [9, 4, 0, 3, 0]],
  }, { ...request, prompt: 'the prompt', negativePrompt: 'the negative' }, 1, 'AryaAI')

  expect(graph['1']).toMatchObject({ inputs: { text: 'the prompt' } })
  expect(graph['2']).toMatchObject({ inputs: { text: 'the negative' } })

  // A guidance link naming a node the document does not carry is not a reason to fail.
  const absent = savedTextToImageWorkflow({
    nodes: [
      { id: 1, type: 'CLIPTextEncode', mode: 0, inputs: [], widgetsValues: ['baked first'] },
      { id: 2, type: 'KSampler', mode: 0, inputs: [{ name: 'positive', link: 7 }], widgetsValues: [0, 'randomize', 8, 1, 'euler', 'simple', 1] },
      { id: 3, type: 'SaveImage', mode: 0, inputs: [], widgetsValues: ['out'] },
    ],
    links: [[7, 99, 0, 2, 0]],
  }, { ...request, prompt: 'the prompt' }, 1, 'AryaAI')

  expect(absent['1']).toMatchObject({ inputs: { text: 'the prompt' } })
})

it('stops walking a conditioning chain that loops back on itself', () => {
  const graph = savedTextToImageWorkflow({
    nodes: [
      { id: 1, type: 'CLIPTextEncode', mode: 0, inputs: [], widgetsValues: ['baked first'] },
      { id: 2, type: 'CLIPTextEncode', mode: 0, inputs: [], widgetsValues: ['baked second'] },
      { id: 3, type: 'ReferenceLatent', mode: 0, inputs: [{ name: 'conditioning', link: 4 }], widgetsValues: [] },
      { id: 4, type: 'ReferenceLatent', mode: 0, inputs: [{ name: 'conditioning', link: 3 }], widgetsValues: [] },
      { id: 5, type: 'KSampler', mode: 0, inputs: [{ name: 'positive', link: 3 }], widgetsValues: [0, 'randomize', 8, 1, 'euler', 'simple', 1] },
      { id: 6, type: 'SaveImage', mode: 0, inputs: [], widgetsValues: ['out'] },
    ],
    links: [[3, 4, 0, 3, 0], [4, 3, 0, 4, 0]],
  }, { ...request, prompt: 'the prompt', negativePrompt: 'the negative' }, 1, 'AryaAI')

  // The walk terminates rather than following the cycle, so document order stands.
  expect(graph['1']).toMatchObject({ inputs: { text: 'the prompt' } })
})

it('projects standard image and video output groups without duplicate media references', () => {
  const graph = basicTextToImageWorkflow(request, 'model.safetensors', 42, 'AryaAI')
  const clip = { filename: 'clip.mp4', subfolder: 'video', type: 'output' }
  const result = generationsOf({ run: { prompt: [1, graph], outputs: {
    '7': { images: [{ filename: 'photo.png', subfolder: '', type: 'output' }] },
    '8': { gifs: [clip, null, { filename: 42 }], videos: [clip] },
  } } })
  expect(result[0]?.images).toEqual([{ filename: 'photo.png', subfolder: '', type: 'output' }, clip])
})

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

it.each(['SaveVideo', 'VHS_VideoCombine'])('shows native video history without a SaveImage node: %s', (outputType) => {
  const clip = { filename: 'mug.mp4', subfolder: 'video', type: 'output' }
  const result = generationsOf({ run: { prompt: [1, {
    text: { class_type: 'CLIPTextEncode', inputs: { text: 'a slow camera push-in' } },
    sampler: { class_type: 'KSamplerAdvanced', inputs: { steps: 8, cfg: 5 } },
    model: { class_type: 'UNETLoader', inputs: { unet_name: 'wan2.2_ti2v_5B_fp16.safetensors' } },
    latent: { class_type: 'Wan22ImageToVideoLatent', inputs: { width: 512, height: 512, length: 49 } },
    save: { class_type: outputType, inputs: { filename_prefix: 'video/mug' } },
  }], outputs: { save: { images: [clip] } } } })
  expect(result.map(({ workflowLabel, width, height, images, modelLabel }) => ({ workflowLabel, width, height, images, modelLabel })))
    .toMatchInlineSnapshot(`
      [
        {
          "height": 512,
          "images": [
            {
              "filename": "mug.mp4",
              "subfolder": "video",
              "type": "output",
            },
          ],
          "modelLabel": "wan2.2_ti2v_5B_fp16.safetensors",
          "width": 512,
          "workflowLabel": "Custom video workflow",
        },
      ]
    `)
})

afterEach(() => { vi.unstubAllGlobals() })

it('submits a saved image-to-video graph with the selected source and requested canvas', async () => {
  const document = { nodes: [
    { id: 1, type: 'LoadImage', mode: 0, inputs: [], widgets_values: ['old.png', 'image'] },
    { id: 2, type: 'Wan22ImageToVideoLatent', mode: 0, inputs: [{ name: 'start_image', link: 1 }], widgets_values: [1280, 704, 49, 1] },
    { id: 3, type: 'SaveVideo', mode: 0, inputs: [{ name: 'video', link: 2 }], widgets_values: ['out', 'mp4', 'h264'] },
  ], links: [[1, 1, 0, 2, 0], [2, 2, 0, 3, 0]] }
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/userdata?')) return Response.json(['animate.json'])
    if (url.includes('/userdata/')) return Response.json(document)
    if (url.endsWith('/prompt')) {
      if (typeof init?.body !== 'string') throw new Error('Expected a serialized prompt')
      expect(JSON.parse(init.body)).toMatchObject({ prompt: {
        '1': { inputs: { image: 'refs/chosen.png [input]' } },
        '2': { inputs: { width: 832, height: 480, length: 49 } },
      } })
      return Response.json({ prompt_id: 'animation' })
    }
    return Response.json({})
  })
  vi.stubGlobal('fetch', fetch)
  const ctx = new Context()
  try {
    const controller = new ComfyImagesController(ctx)
    const result = await controller.generate({ ...request, workflow: 'saved:animate.json', width: 832, height: 480,
      sourceImage: { filename: 'chosen.png', subfolder: 'refs', type: 'input' } }, signal())
    expect(result.promptId).toBe('animation')
  } finally { await ctx.fiber.dispose() }
})

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
      await writeFile(join(root, 'clip.mp4'), 'video')
      const controller = new ComfyImagesController(new Context(), { outputDirectory: root })
      const first = await controller.library({ offset: 0, limit: 1 }, signal())
      const second = await controller.library({ offset: 1, limit: 1 }, signal())
      expect(first.total).toBe(3)
      expect([...first.images, ...second.images].map(item => item.image.filename)).toHaveLength(2)
      expect((await controller.library({ offset: 0, limit: 10 }, signal())).images.map(item => item.image.filename).sort()).toEqual(['chosen.webp', 'clip.mp4', 'older.png'])
      await expect(controller.deleteImage({ filename: 'older.png', subfolder: '..', type: 'output' }, signal())).rejects.toThrow()
      await controller.deleteImage({ filename: 'chosen.webp', subfolder: 'archive', type: 'output' }, signal())
      await expect(readFile(join(root, 'archive', 'chosen.webp'))).rejects.toThrow()
      const deleted = await controller.deleteImages({ images: [
        { filename: 'clip.mp4', subfolder: '', type: 'output' },
        { filename: 'missing.png', subfolder: '', type: 'output' },
      ] }, signal())
      expect(deleted.deleted.map(item => item.filename)).toEqual(['clip.mp4'])
      expect(deleted.failed.map(item => item.image.filename)).toEqual(['missing.png'])
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

  it('accepts a saved reference edit that samples through SamplerCustomAdvanced', () => {
    const graph = savedTextToImageWorkflow(kleinEditGraph(), { ...request, prompt: 'make it snow', steps: 12, cfg: 2 }, 99, 'AryaAI')

    expect(graph['6']).toMatchObject({ inputs: { text: 'make it snow' } })
    expect(graph['9']).toMatchObject({ inputs: { noise_seed: 99 } })
    expect(graph['11']).toMatchObject({ inputs: { cfg: 2 } })
    expect(graph['14']).toMatchObject({ inputs: { filename_prefix: 'AryaAI' } })
    // The scheduler owns its step count, while its size stays wired to the reference.
    expect(graph['10']).toMatchObject({ inputs: { steps: 12, width: ['5', 0], height: ['5', 1] } })
    // The latent takes the reference's own size: overriding it would lose the aspect.
    expect(graph['8']).toMatchObject({ inputs: { width: ['5', 0], height: ['5', 1] } })
  })

  it('leaves an advanced-sampling input that the graph wires to another node', () => {
    const saved = kleinEditGraph()
    const scheduler = saved.nodes.find(node => node.id === 10)
    scheduler?.inputs.push({ name: 'steps', link: 20 })
    saved.links.push([20, 5, 0, 10, 2])

    const graph = savedTextToImageWorkflow(saved, { ...request, prompt: 'make it snow', steps: 12 }, 99, 'AryaAI')

    expect(graph['10']).toMatchObject({ inputs: { steps: ['5', 0] } })
  })

  it('accepts a saved graph that samples nothing, such as an upscaler', () => {
    // A post-processing graph has no sampler and no text encoder and carries its own settings.
    // Rejecting it would refuse a workflow that runs perfectly well in native ComfyUI.
    const graph = savedTextToImageWorkflow({
      nodes: [
        { id: 1, type: 'LoadImage', mode: 0, inputs: [], widgetsValues: ['in.png', 'image'] },
        { id: 2, type: 'UpscaleModelLoader', mode: 0, inputs: [], widgetsValues: ['4x-UltraSharp.pth'] },
        { id: 3, type: 'ImageUpscaleWithModel', mode: 0, inputs: [
          { name: 'upscale_model', link: 2 }, { name: 'image', link: 1 },
        ], widgetsValues: [] },
        { id: 4, type: 'SaveImage', mode: 0, inputs: [{ name: 'images', link: 3 }], widgetsValues: ['up'] },
      ],
      links: [[1, 1, 0, 3, 1], [2, 2, 0, 3, 0], [3, 3, 0, 4, 0]],
    }, request, 5, 'AryaAI')

    expect(graph['3']).toMatchObject({ class_type: 'ImageUpscaleWithModel', inputs: { image: ['1', 0], upscale_model: ['2', 0] } })
    expect(graph['4']).toMatchObject({ inputs: { filename_prefix: 'AryaAI' } })
  })

  it('drops an input that names a bypassed node', () => {
    // A bypassed image loader leaves the latent it fed with nothing to resolve. The graph's own
    // default for that input is right, so the input is dropped rather than submitted broken.
    const graph = savedTextToImageWorkflow({
      nodes: [
        { id: 1, type: 'Wan22ImageToVideoLatent', mode: 0, inputs: [{ name: 'start_image', link: 1 }], widgetsValues: [1280, 704, 25, 1] },
        { id: 2, type: 'LoadImage', mode: 4, inputs: [], widgetsValues: ['example.png', 'image'] },
        { id: 3, type: 'KSampler', mode: 0, inputs: [{ name: 'latent_image', link: 2 }], widgetsValues: [0, 'randomize', 8, 1, 'euler', 'simple', 1] },
        { id: 4, type: 'SaveVideo', mode: 0, inputs: [], widgetsValues: ['out', 'auto', 'auto'] },
      ],
      links: [[1, 2, 0, 1, 5], [2, 1, 0, 3, 3]],
    }, request, 5, 'AryaAI')

    expect(graph['2']).toBeUndefined()
    expect(graph['1']).toMatchObject({ class_type: 'Wan22ImageToVideoLatent' })
    expect(Object.keys((graph['1'] as { inputs: Record<string, unknown> }).inputs)).not.toContain('start_image')
    expect(graph['3']).toMatchObject({ inputs: { latent_image: ['1', 0] } })
  })

  it('supplies the batch a newer graph omits for its latent', () => {
    // ComfyUI refuses the whole prompt when a required input is missing, and a graph saved by a
    // newer frontend may not state batch_size on the latent at all.
    const graph = savedTextToImageWorkflow({
      nodes: [
        { id: 1, type: 'EmptyFlux2LatentImage', mode: 0, inputs: [], widgetsValues: [1024, 1024] },
        { id: 2, type: 'KSampler', mode: 0, inputs: [{ name: 'latent_image', link: 1 }], widgetsValues: [0, 'randomize', 8, 1, 'euler', 'simple', 1] },
        { id: 3, type: 'SaveImage', mode: 0, inputs: [], widgetsValues: ['out'] },
      ],
      links: [[1, 1, 0, 2, 3]],
    }, { ...request, batchSize: 3 }, 5, 'AryaAI')

    expect(graph['1']).toMatchObject({
      class_type: 'EmptyFlux2LatentImage', inputs: { width: 1024, height: 1024, batch_size: 3 },
    })
  })

  it('marks a saved graph with an active image loader as an edit workflow', () => {
    // A caller that cannot supply a source image needs to know which entries require one.
    // A bypassed loader does not count, because that graph runs on its own.
    const withLoader = savedWorkflowTask([{ type: 'LoadImage', mode: 0 }, { type: 'SaveImage', mode: 0 }])
    const withBypassed = savedWorkflowTask([{ type: 'LoadImage', mode: 4 }, { type: 'SaveImage', mode: 0 }])
    const withoutLoader = savedWorkflowTask([{ type: 'KSampler', mode: 0 }, { type: 'SaveImage', mode: 0 }])

    expect(withLoader).toBe('edit')
    expect(withBypassed).toBeUndefined()
    expect(withoutLoader).toBeUndefined()
  })

  it('reports that a post-processing graph encodes no prompt', () => {
    // Upscaling and interpolation graphs discard a prompt, so asking their caller for one
    // demands input the graph ignores. Absent means a prompt applies.
    expect(savedWorkflowTakesPrompt([{ type: 'CLIPTextEncode', mode: 0 }, { type: 'SaveImage', mode: 0 }])).toBeUndefined()
    expect(savedWorkflowTakesPrompt([{ type: 'CLIPTextEncode', mode: 4 }, { type: 'SaveImage', mode: 0 }])).toBe(false)
    expect(savedWorkflowTakesPrompt([{ type: 'LoadImage', mode: 0 }, { type: 'SaveImage', mode: 0 }])).toBe(false)
    expect(savedWorkflowTakesPrompt([{ type: 'TextEncodeQwenImage21', mode: 0 }])).toBeUndefined()
    expect(savedWorkflowTakesPrompt([{ type: 'TextEncodeQwenImage21', mode: 4 }])).toBe(false)
  })

  it('updates Qwen guidance while retaining its reference and Turbo sigma schedule', () => {
    expect(savedSamplerSettings([
      { id: 1, type: 'ManualSigmas', mode: 0, inputs: [], widgetsValues: ['1, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0'] },
      { id: 2, type: 'CFGGuider', mode: 0, inputs: [], widgetsValues: [1] },
    ])).toEqual({ steps: 8, cfg: 1 })
    const graph = savedTextToImageWorkflow({
      nodes: [
        { id: 1, type: 'LoadImage', mode: 0, inputs: [], widgetsValues: ['reference.png'] },
        { id: 2, type: 'TextEncodeQwenImage21', mode: 0, inputs: [{ name: 'images.image_1', link: 1 }], widgetsValues: ['old', 'old negative', 1024] },
        { id: 3, type: 'QwenImage21Cache', mode: 0, inputs: [], widgetsValues: ['cpu', 'default'] },
        { id: 4, type: 'ManualSigmas', mode: 0, inputs: [], widgetsValues: ['1, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0'] },
        { id: 5, type: 'SaveImage', mode: 0, inputs: [], widgetsValues: ['out'] },
      ],
      links: [[1, 1, 0, 2, 0]],
    }, { ...request, prompt: 'make it blue', negativePrompt: 'text' }, 5, 'AryaAI')
    expect(graph['2']).toMatchObject({ inputs: { prompt: 'make it blue', negative_prompt: 'text', resolution: 1024, 'images.image_1': ['1', 0] } })
    expect(graph['3']).toMatchObject({ inputs: { device: 'cpu', dtype: 'default' } })
    expect(graph['4']).toMatchObject({ inputs: { sigmas: '1, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0' } })
    expect(injectSourceImage(graph, 'chosen.png')).toBe(true)
    expect(graph['1']).toMatchObject({ inputs: { image: 'chosen.png' } })
  })

  it('rejects a saved graph that writes no output', () => {
    expect(() => savedTextToImageWorkflow({
      nodes: [
        { id: 1, type: 'CLIPTextEncode', mode: 0, inputs: [], widgetsValues: ['saved prompt'] },
        { id: 2, type: 'KSampler', mode: 0, inputs: [], widgetsValues: [0, 'randomize', 8, 1, 'euler', 'simple', 1] },
      ],
      links: [],
    }, request, 5, 'AryaAI')).toThrow('Workflow is not a supported generation graph')
  })

  it('accepts a saved video graph and reads its loader and writer nodes', () => {
    const graph = savedTextToImageWorkflow({
      nodes: [
        { id: 1, type: 'UNETLoader', mode: 0, inputs: [], widgetsValues: ['wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors', 'default'] },
        { id: 2, type: 'LoadVideo', mode: 0, inputs: [], widgetsValues: ['start.mp4'] },
        { id: 3, type: 'CLIPTextEncode', mode: 0, inputs: [], widgetsValues: ['a slow pan'] },
        { id: 4, type: 'GetVideoComponents', mode: 0, inputs: [{ name: 'video', link: 1 }], widgetsValues: [] },
        { id: 5, type: 'KSampler', mode: 0, inputs: [
          { name: 'model', link: 2 }, { name: 'positive', link: 3 }, { name: 'negative', link: 4 }, { name: 'latent_image', link: 5 },
        ], widgetsValues: [0, 'randomize', 8, 1, 'euler', 'simple', 1] },
        { id: 6, type: 'CreateVideo', mode: 0, inputs: [{ name: 'images', link: 6 }], widgetsValues: [16, 'auto', 'sRGB', 'none'] },
        { id: 7, type: 'SaveVideo', mode: 0, inputs: [{ name: 'video', link: 7 }], widgetsValues: ['video/out', 'mp4', 'h264'] },
      ],
      links: [[1, 2, 0, 4, 0], [2, 1, 0, 5, 0], [3, 3, 0, 5, 1], [4, 3, 0, 5, 2], [5, 4, 0, 5, 3], [6, 5, 0, 6, 0], [7, 6, 0, 7, 0]],
    }, { ...request, prompt: 'a slow pan' }, 7, 'AryaAI')

    expect(graph['2']).toMatchObject({ class_type: 'LoadVideo', inputs: { file: 'start.mp4' } })
    expect(graph['6']).toMatchObject({ class_type: 'CreateVideo', inputs: { fps: 16, codec: 'none' } })
    expect(graph['7']).toMatchObject({ class_type: 'SaveVideo', inputs: { filename_prefix: 'AryaAI', format: 'mp4', codec: 'h264' } })
  })

  it('injects a chosen source image into a graph that loads its own reference', () => {
    const graph = { '1': { class_type: 'LoadImage', inputs: { image: 'baked.png' } }, '2': { class_type: 'SaveImage', inputs: {} } }

    expect(injectSourceImage(graph, 'input/aryaai-ref.png [input]')).toBe(true)
    expect(graph['1']).toMatchObject({ inputs: { image: 'input/aryaai-ref.png [input]' } })
    // A graph with no loader of its own reports that it has no slot to fill.
    expect(injectSourceImage({ '1': { class_type: 'SaveImage', inputs: {} } }, 'x.png')).toBe(false)
  })

  it('treats only a checkpoint the server does not report as a missing model file', () => {
    const models = [{
      id: 'checkpoint:arya.safetensors', label: 'arya.safetensors', kind: 'checkpoint' as const,
      checkpoint: 'arya.safetensors', recommendedSteps: 24, recommendedCfg: 7,
    }]
    const loading = (name: string) => ({ '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: name } } })

    expect(absentCheckpoint(loading('arya.safetensors'), models)).toBe(false)
    expect(absentCheckpoint(loading('missing.safetensors'), models)).toBe(true)
    // A graph that loads no checkpoint at all cannot be missing one: an upscale graph, a frame
    // interpolator, or a video graph whose model lives in another folder.
    expect(absentCheckpoint({ '1': { class_type: 'UpscaleModelLoader', inputs: { model_name: '4x-UltraSharp.pth' } } }, models)).toBe(false)
    // A loader with no file named is equally unverifiable here.
    expect(absentCheckpoint({ '1': { class_type: 'CheckpointLoaderSimple', inputs: {} } }, models)).toBe(false)
  })

  it('resolves a frontend switch by the literal its own control carries', () => {
    const graph = (choice: boolean) => ({
      nodes: [
        { id: 1, type: 'PrimitiveBoolean', mode: 0, inputs: [], outputs: [{ name: 'BOOLEAN', type: 'BOOLEAN' }], widgets_values: [choice] },
        { id: 2, type: 'UNETLoader', mode: 0, inputs: [], outputs: [{ name: 'MODEL', type: 'MODEL' }], widgets_values: ['high.safetensors', 'default'] },
        { id: 3, type: 'LoraLoaderModelOnly', mode: 0, inputs: [], outputs: [{ name: 'MODEL', type: 'MODEL' }], widgets_values: ['fast.safetensors'] },
        { id: 4, type: 'ComfySwitchNode', mode: 0, inputs: [{ name: 'on_false', link: 12 }, { name: 'on_true', link: 13 }, { name: 'switch', link: 11 }], outputs: [{ name: 'MODEL', type: 'MODEL' }], widgets_values: [false] },
        { id: 5, type: 'KSampler', mode: 0, inputs: [{ name: 'model', link: 14 }], outputs: [], widgets_values: [0, 'randomize', 8, 1, 'euler', 'simple', 1] },
      ],
      links: [[11, 1, 0, 4, 2], [12, 2, 0, 4, 0], [13, 3, 0, 4, 1], [14, 4, 0, 5, 0]],
    })

    // The document's own boolean decides, so the same graph resolves both ways.
    const off = savedWorkflowOf(graph(false))
    expect(off?.nodes.some(node => node.type === 'ComfySwitchNode')).toBe(false)
    expect(off?.links.find(link => link[0] === 14)?.[1]).toBe(2)

    const on = savedWorkflowOf(graph(true))
    expect(on?.links.find(link => link[0] === 14)?.[1]).toBe(3)
  })

  it('leaves a switch whose control is not a literal for the report to name', () => {
    const parsed = savedWorkflowOf({
      nodes: [
        { id: 1, type: 'SomeNode', mode: 0, inputs: [], outputs: [{ name: 'BOOLEAN', type: 'BOOLEAN' }], widgets_values: [] },
        { id: 2, type: 'ComfySwitchNode', mode: 0, inputs: [{ name: 'switch', link: 11 }], outputs: [{ name: 'MODEL', type: 'MODEL' }], widgets_values: [false] },
      ],
      links: [[11, 1, 0, 2, 0]],
    })

    expect(parsed?.nodes.some(node => node.type === 'ComfySwitchNode')).toBe(true)
  })

  it('resolves a switch held inside a subgraph, whose control the instance supplies', () => {
    const parsed = savedWorkflowOf({
      nodes: [
        { id: 50, type: 'sub-1', mode: 0, inputs: [], outputs: [{ name: 'MODEL', type: 'MODEL' }], widgets_values: [true] },
      ],
      links: [],
      definitions: {
        subgraphs: [{
          id: 'sub-1',
          inputs: [{ name: 'useLora', type: 'BOOLEAN', linkIds: [11] }],
          outputs: [{ name: 'MODEL', type: 'MODEL', linkIds: [14] }],
          nodes: [
            { id: 6, type: 'PrimitiveBoolean', mode: 0, inputs: [{ name: 'value', link: 11 }], outputs: [{ name: 'BOOLEAN', type: 'BOOLEAN' }], widgets_values: [false] },
            { id: 2, type: 'UNETLoader', mode: 0, inputs: [], outputs: [{ name: 'MODEL', type: 'MODEL' }], widgets_values: ['plain.safetensors', 'default'] },
            { id: 3, type: 'LoraLoaderModelOnly', mode: 0, inputs: [], outputs: [{ name: 'MODEL', type: 'MODEL' }], widgets_values: ['fast.safetensors'] },
            { id: 4, type: 'ComfySwitchNode', mode: 0, inputs: [{ name: 'on_false', link: 12 }, { name: 'on_true', link: 13 }, { name: 'switch', link: 15 }], outputs: [{ name: 'MODEL', type: 'MODEL' }], widgets_values: [false] },
            { id: 5, type: 'KSampler', mode: 0, inputs: [{ name: 'model', link: 14 }], outputs: [], widgets_values: [0, 'randomize', 8, 1, 'euler', 'simple', 1] },
          ],
          links: [
            { id: 11, origin_id: -10, origin_slot: 0, target_id: 6, target_slot: 0 },
            { id: 12, origin_id: 2, origin_slot: 0, target_id: 4, target_slot: 0 },
            { id: 13, origin_id: 3, origin_slot: 0, target_id: 4, target_slot: 1 },
            { id: 14, origin_id: 4, origin_slot: 0, target_id: 5, target_slot: 0 },
            { id: 15, origin_id: 6, origin_slot: 0, target_id: 4, target_slot: 2 },
          ],
        }],
      },
    })

    // The switch sat inside the definition while the value that drives it arrived from outside, so
    // this resolves only when subgraph expansion runs first. Expansion renumbers the interior
    // links, so the assertion follows the sampler's input rather than a link id.
    expect(parsed?.nodes.some(node => node.type === 'ComfySwitchNode')).toBe(false)
    const sampler = parsed?.nodes.find(node => node.type === 'KSampler')
    const modelLink = parsed?.links.find(link => link[0] === sampler?.inputs.find(input => input.name === 'model')?.link)
    expect(parsed?.nodes.find(node => node.id === modelLink?.[1])?.type).toBe('LoraLoaderModelOnly')
  })

  it('discovers checkpoints and a split Z-Image Turbo installation', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(Response.json({
        CheckpointLoaderSimple: { input: { required: { ckpt_name: [['arya.safetensors', 'flux.safetensors'], {}] } } },
      }))
      .mockResolvedValueOnce(Response.json({
        UNETLoader: { input: { required: { unet_name: [['z_image_turbo_bf16.safetensors', 'flux-2-klein-4b-fp8.safetensors', 'flux-2-klein-base-4b-fp8.safetensors']] } } },
      }))
      .mockResolvedValueOnce(Response.json({
        CLIPLoader: { input: { required: { clip_name: [['qwen_3_4b.safetensors']] } } },
      }))
      .mockResolvedValueOnce(Response.json({
        VAELoader: { input: { required: { vae_name: [['ae.safetensors', 'flux2-vae.safetensors']] } } },
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
        {
          id: 'flux2-klein:flux-2-klein-4b-fp8.safetensors', label: 'Flux 2 Klein', kind: 'flux2-klein',
          recommendedSteps: 4, recommendedCfg: 1,
        },
        {
          id: 'flux2-klein:flux-2-klein-base-4b-fp8.safetensors', label: 'Flux 2 Klein (base)', kind: 'flux2-klein',
          recommendedSteps: 20, recommendedCfg: 5,
        },
      ],
      workflows: [{
        id: 'built-in:standard', label: 'Z-Image Turbo · AryaAI standard', source: 'built-in', available: true,
        unavailableReason: null, recommendedSteps: 9, recommendedCfg: 1, supportsNegativePrompt: false,
        modelId: 'z-image-turbo:z_image_turbo_bf16.safetensors',
        starterPrompt: '', width: 1024, height: 1024, batchSize: 1, task: undefined, output: 'image',
      }, {
        id: 'built-in:flux-reference-edit', label: 'Flux 2 Klein · Edit image', source: 'built-in', available: true,
        unavailableReason: null, recommendedSteps: 4, recommendedCfg: 1, supportsNegativePrompt: false,
        task: 'edit', modelId: 'flux2-klein:flux-2-klein-4b-fp8.safetensors', starterPrompt: '', width: 1024, height: 1024, batchSize: 1, output: 'image',
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


describe('reference edit history', () => {
  it('converts a Director timeline without changing scene timing or reference guidance', async () => {
    const saved = savedWorkflowOf(JSON.parse(await readFile(new URL('./fixtures/ltx-director.json', import.meta.url), 'utf8')))
    expect(saved).toBeDefined()
    if (saved === undefined) throw new Error('Director fixture is not a saved workflow')
    expect(savedWorkflowTakesPrompt(saved.nodes)).toBeUndefined()
    expect(savedWorkflowOutput(saved.nodes)).toBe('video')
    const timeline = JSON.stringify({ segments: [{ start: 0, end: 2, prompt: 'Mist over water' }], image: 'lake.png' })
    const withTimeline = { ...saved, nodes: saved.nodes.map(node => node.type === 'LTXDirector'
      ? { ...node, widgetsValues: node.widgetsValues.map((value, index) => index === 6 ? timeline : value) } : node) }
    const graph = savedTextToImageWorkflow(withTimeline, { ...request, prompt: 'A lake at sunset', width: 640, height: 384 }, 7, 'AryaAI')
    expect(graph['20']).toMatchObject({ inputs: {
      global_prompt: 'A lake at sunset', custom_width: 640, custom_height: 384,
      duration_frames: 120, frame_rate: 24, timeline_data: timeline, guide_strength: '',
      use_custom_audio: false, use_custom_motion: true, inpaint_audio: true,
    } })
    expect(graph['7']).toMatchObject({ inputs: { width: 640, height: 384, length: 121 } })
    expect(graph['22']).toMatchObject({ inputs: { guide_data: ['20', 4], motion_guide_data: ['20', 5], model: ['20', 0] } })
    expect(graph['23']).toMatchObject({ inputs: { latent: ['15', 0] } })
    expect(injectSourceImage(graph, 'customer-reference.png')).toBe(true)
    const initial = Object.entries(graph).find(([, node]) => node.class_type === 'LTXVImgToVideo')
    expect(initial?.[1].inputs).toMatchObject({ width: 640, height: 384, length: 121, vae: ['1', 2], positive: ['6', 0] })
    expect(graph['22']?.inputs.latent).toEqual([initial?.[0], 2])
    expect(generationsOf({ director: { prompt: [1, graph], outputs: {} } })[0]).toMatchObject({
      prompt: 'A lake at sunset', width: 640, height: 384, steps: 8,
    })
  })
  it('retains Qwen edit prompts, references and fixed schedule in recent runs', () => {
    const result = generationsOf({ edit: { prompt: [1, {
      '1': { class_type: 'UNETLoader', inputs: { unet_name: 'qwen_image_2.1_turbo_int8_convrot.safetensors' } },
      '2': { class_type: 'TextEncodeQwenImage21', inputs: { prompt: 'blue jacket', negative_prompt: 'text', 'images.image_1': ['3', 0] } },
      '3': { class_type: 'LoadImage', inputs: { image: 'archive/reference.png [output]' } },
      '4': { class_type: 'SamplerCustomAdvanced', inputs: {} },
      '5': { class_type: 'ManualSigmas', inputs: { sigmas: '1, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0' } },
      '6': { class_type: 'SaveImage', inputs: {} },
    }], outputs: {} } })
    expect(result[0]).toMatchObject({ prompt: 'blue jacket', negativePrompt: 'text', steps: 8,
      modelLabel: 'Qwen Image 2.1 · qwen_image_2.1_turbo_int8_convrot.safetensors',
      sourceImage: { filename: 'reference.png', subfolder: 'archive', type: 'output' } })
  })
  it('keeps custom Flux edits and their reference conditioning visible in recent runs', () => {
    const graph = fluxReferenceWorkflow({ ...request, steps: 4, cfg: 1 }, {
      diffusionModel: 'flux-2-klein-4b-fp8.safetensors', textEncoder: 'qwen_3_4b.safetensors', vae: 'flux2-vae.safetensors',
    }, 'archive/source.png [output]', 123, 'AryaAI')
    expect(graph['16']?.inputs).toEqual({ model: ['1', 0], positive: ['10', 0], negative: ['11', 0], cfg: 1 })
    expect(graph['12']?.inputs).toEqual({ width: ['6', 0], height: ['6', 1], batch_size: 1 })
    const result = generationsOf({ edit: { prompt: [1, graph, {}, { aryaai: { width: 832, height: 1216 } }], outputs: {
      '19': { images: [{ filename: 'edited.png', subfolder: '', type: 'output' }] },
    } } })
    expect(result[0]).toMatchObject({ modelLabel: 'Flux 2 Klein · flux-2-klein-4b-fp8.safetensors', width: 832, height: 1216, steps: 4, cfg: 1, seed: 123,
      sourceImage: { filename: 'source.png', subfolder: 'archive', type: 'output' } })
    expect(result.map(run => ({ model: run.modelLabel, source: run.sourceImage, steps: run.steps, images: run.images }))).toMatchInlineSnapshot(`
      [
        {
          "images": [
            {
              "filename": "edited.png",
              "subfolder": "",
              "type": "output",
            },
          ],
          "model": "Flux 2 Klein · flux-2-klein-4b-fp8.safetensors",
          "source": {
            "filename": "source.png",
            "subfolder": "archive",
            "type": "output",
          },
          "steps": 4,
        },
      ]
    `)
  })
  it('retains basic image-to-image runs after the empty latent is removed', () => {
    const graph = basicTextToImageWorkflow(request, 'arya.safetensors', 42, 'AryaAI')
    imageToImageWorkflow(graph, 'source.png [input]', 0.55)
    const result = generationsOf({ edit: { prompt: [1, graph], outputs: {} } })
    expect(result[0]).toMatchObject({ sourceImage: { filename: 'source.png', subfolder: '', type: 'input' }, denoise: 0.55 })
  })
})
