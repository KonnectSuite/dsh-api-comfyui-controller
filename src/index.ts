/** The `comfyImages` Remote namespace over one configured local ComfyUI host. */
import { fluxReferenceWorkflow } from './flux.ts'
import { expandSubgraphs } from './subgraph.ts'
import { applyVideoSettings } from './video-settings.ts'
import { assembleFilm } from './film.ts'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { SubgraphDefinition, SubgraphSlot } from './subgraph.ts'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { randomInt, randomUUID } from 'node:crypto'
import { readdir, stat, unlink } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-connection'
import {
  COMFY_ARCHIVE_PATH, COMFY_BATCH_LIMIT, COMFY_MEDIA_EXTENSIONS, COMFY_MEDIA_PATH,
  comfyArchiveResponse, comfyRemoteArchiveResponse, comfyMediaResponse, localMedia,
} from './media.ts'
import type {
  ComfyCancelRequest,
  ComfyDeleteRequest,
  ComfyDeleteImagesRequest,
  ComfyDeleteImagesResult,
  ComfyGenerateReceipt,
  ComfyGenerateRequest,
  ComfyGeneration,
  ComfyHistoryRequest,
  ComfyImageData,
  ComfyImageModel,
  ComfyImageWorkflow,
  ComfyImageReference,
  ComfyImageRequest,
  ComfyImagesStatus,
  ComfyLibraryPage,
  ComfyLibraryRequest,
  ComfyServerControlResult,
  ComfyStoredImage,
  ComfyFilmRequest,
  ComfyFilmResult,
} from './types.ts'

export type * from './types.ts'

interface Config {
  /** Local ComfyUI HTTP endpoint. */
  readonly baseUrl?: string
  /** Prefix for generated output filenames. */
  readonly outputPrefix?: string
  /** Deadline for ComfyUI HTTP requests. */
  readonly requestTimeoutMs?: number
  /** Local ComfyUI output folder used for library browsing and file deletion. */
  readonly outputDirectory?: string
  /**
   * Interpreter that runs ComfyUI, so the panel can start the server itself.
   * Empty leaves start unavailable and only the HTTP controls usable.
   */
  readonly serverPythonPath?: string
  /** Checkout holding `main.py`; the working directory a start runs in. */
  readonly serverDirectory?: string
  /** How long a start may take before the panel reports it as not running. */
  readonly serverStartTimeoutMs?: number
  /** Maximum duration of one generated scene; longer films use ordered scenes. */
  readonly maxVideoSeconds?: number
  /** Local FFmpeg executable; empty disables film assembly. */
  readonly ffmpegPath?: string
  /** Maximum time allowed for one CPU film assembly. */
  readonly filmTimeoutMs?: number
  /** Maximum assembled film duration. */
  readonly maxFilmSeconds?: number
  /** H.264 quality factor; lower values retain more detail. */
  readonly filmCrf?: number
  /** FFmpeg H.264 speed preset. */
  readonly filmEncoderPreset?: 'ultrafast' | 'fast' | 'medium' | 'slow'
}

interface ResolvedConfig {
  readonly baseUrl: string
  readonly outputPrefix: string
  readonly requestTimeoutMs: number
  readonly outputDirectory: string | null
  readonly serverPythonPath: string | null
  readonly serverDirectory: string | null
  readonly serverStartTimeoutMs: number
  readonly maxVideoSeconds: number
  readonly ffmpegPath: string | null
  readonly filmTimeoutMs: number
  readonly maxFilmSeconds: number
  readonly filmCrf: number
  readonly filmEncoderPreset: string
}

interface WorkflowNode {
  readonly class_type: string
  readonly inputs: Record<string, unknown>
}

/** A validated ComfyUI API graph keyed by node identity. */
export type Workflow = Record<string, WorkflowNode>

interface SavedWorkflowNode {
  readonly id: number
  readonly type: string
  readonly mode: number
  readonly inputs: readonly { readonly name: string; readonly link: number | null }[]
  readonly widgetsValues: readonly unknown[]
}

interface SavedWorkflow {
  readonly nodes: readonly SavedWorkflowNode[]
  readonly links: readonly (readonly unknown[])[]
}

interface CatalogWorkflow extends ComfyImageWorkflow {
  readonly saved?: SavedWorkflow
}

interface SavedCatalogEntry {
  readonly name: string
  readonly workflow?: SavedWorkflow
  readonly error?: string
}

/** Saved workflow identity used when reconstructing ComfyUI history. */
export interface HistoryWorkflowIdentity {
  readonly id: string
  readonly label: string
  readonly outputPrefixes: readonly string[]
  readonly fingerprint?: string
}

type CatalogModel =
  | ComfyImageModel & { readonly kind: 'checkpoint'; readonly checkpoint: string }
  | ComfyImageModel & {
    readonly kind: 'z-image-turbo' | 'flux2-klein'
    readonly diffusionModel: string
    readonly textEncoder: string
    readonly vae: string
  }

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `comfyImages` Remote namespace. */
    comfyImagesController: ComfyImagesController
  }
}

function normalizedBaseUrl(value: string): string {
  return value.replace(/\/+$/u, '')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function integer(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`)
  }
  return value
}

/** Build the standard-node text-to-image graph shared by the controller and its tests.
 * @param request - Validated generation settings.
 * @param checkpoint - Installed checkpoint filename.
 * @param seed - Resolved sampler seed.
 * @param prefix - Output image filename prefix.
 * @returns ComfyUI prompt graph.
 */
export function basicTextToImageWorkflow(request: ComfyGenerateRequest, checkpoint: string, seed: number, prefix: string): Workflow {
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: request.prompt, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: request.negativePrompt, clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: request.width, height: request.height, batch_size: request.batchSize } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed, steps: request.steps, cfg: request.cfg, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
        model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0],
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { filename_prefix: prefix, images: ['6', 0] } },
  }
}

/** Build the official standard-node Z-Image Turbo text-to-image graph.
 * @param request - Validated generation settings.
 * @param files - Installed model, encoder, and VAE filenames.
 * @param seed - Resolved sampler seed.
 * @param prefix - Output image filename prefix.
 * @returns ComfyUI prompt graph.
 */
export function zImageTurboWorkflow(
  request: ComfyGenerateRequest,
  files: { readonly diffusionModel: string; readonly textEncoder: string; readonly vae: string },
  seed: number,
  prefix: string,
): Workflow {
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: files.diffusionModel, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: files.textEncoder, type: 'lumina2', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: files.vae } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: request.prompt, clip: ['2', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: request.negativePrompt, clip: ['2', 0] } },
    '6': { class_type: 'EmptySD3LatentImage', inputs: { width: request.width, height: request.height, batch_size: request.batchSize } },
    '7': {
      class_type: 'KSampler',
      inputs: {
        seed, steps: request.steps, cfg: request.cfg, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
        model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0],
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: prefix, images: ['8', 0] } },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const SAVED_NODE_WIDGET_INPUTS: Readonly<Record<string, readonly string[]>> = {
  CheckpointLoaderSimple: ['ckpt_name'],
  UNETLoader: ['unet_name', 'weight_dtype'],
  ModelSamplingAuraFlow: ['shift', 'sampling'],
  CLIPLoader: ['clip_name', 'type', 'device'],
  CLIPTextEncode: ['text'],
  TextEncodeQwenImage21: ['prompt', 'negative_prompt', 'resolution'],
  QwenImage21Cache: ['device', 'dtype'],
  LTXDirector: ['start_second', 'end_second', 'duration_seconds', 'start_frame', 'end_frame', 'duration_frames', 'timeline_data', 'local_prompts', 'segment_lengths', 'epsilon', 'guide_strength', 'use_custom_audio', 'use_custom_motion', 'inpaint_audio', 'frame_rate', 'display_mode', 'custom_width', 'custom_height', 'resize_method', 'divisible_by', 'img_compression', 'override_audio'],
  LTXDirectorGuide: ['ic_lora_name', 'ic_lora_strength', 'scale_by', 'upscale_method', 'image_attention_strength', 'crop', 'auto_snap_ic_grid', 'use_tiled_encode', 'tile_size', 'tile_overlap', 'retake_mode'],
  LTXDirectorCropGuides: [],
  LTXAVTextEncoderLoader: ['text_encoder', 'ckpt_name', 'device'],
  LTXVAudioVAELoader: ['ckpt_name'],
  EmptyLTXVLatentVideo: ['width', 'height', 'length', 'batch_size'],
  LTXVImgToVideo: ['width', 'height', 'length', 'batch_size', 'strength'],
  LTXVEmptyLatentAudio: ['frames_number', 'frame_rate', 'batch_size'],
  LTXVConcatAVLatent: [],
  LTXVSeparateAVLatent: [],
  LTXVAudioVAEDecode: [],
  LTXVConditioning: ['frame_rate'],
  VAEDecodeTiled: ['tile_size', 'overlap', 'temporal_size', 'temporal_overlap'],
  SamplerEulerAncestral: ['eta', 's_noise'],
  ManualSigmas: ['sigmas'],
  ConditioningZeroOut: [],
  EmptyLatentImage: ['width', 'height', 'batch_size'],
  EmptySD3LatentImage: ['width', 'height', 'batch_size'],
  VAELoader: ['vae_name'],
  VAEDecode: [],
  SaveImage: ['filename_prefix'],
  // Reference editing and advanced sampling, as the built-in Flux 2 edit graph uses
  // them. Without these a saved edit workflow fails to convert at all.
  LoadImage: ['image'],
  ImageScaleToTotalPixels: ['upscale_method', 'megapixels', 'resolution_steps'],
  GetImageSize: [],
  VAEEncode: [],
  ReferenceLatent: [],
  EmptyFlux2LatentImage: ['width', 'height', 'batch_size'],
  RandomNoise: ['noise_seed'],
  KSamplerSelect: ['sampler_name'],
  Flux2Scheduler: ['steps', 'width', 'height'],
  CFGGuider: ['cfg'],
  SamplerCustomAdvanced: [],
  // Style, upscaling and reference conditioning, so those saved workflows are
  // submittable rather than only present in ComfyUI.
  LoraLoader: ['lora_name', 'strength_model', 'strength_clip'],
  UpscaleModelLoader: ['model_name'],
  ImageUpscaleWithModel: [],
  IPAdapterModelLoader: ['ipadapter_file'],
  IPAdapterUnifiedLoader: ['preset'],
  IPAdapterAdvanced: ['weight', 'weight_type', 'combine_embeds', 'start_at', 'end_at', 'embeds_scaling'],
  CLIPVisionLoader: ['clip_name'],
  PrimitiveStringMultiline: ['value'],
  // Video, so an image-to-video or interpolation graph is submittable and its result is
  // written where the history reader already looks for video.
  SaveVideo: ['filename_prefix', 'format', 'codec'],
  LoadVideo: ['file'],
  CreateVideo: ['fps', 'bit_depth', 'color_space', 'codec'],
  GetVideoComponents: [],
  'RIFE VFI': ['ckpt_name', 'clear_cache_after_n_frames', 'multiplier', 'fast_mode', 'ensemble', 'scale_factor', 'dtype', 'torch_compile', 'batch_size'],
  // Nodes a subgraph's interior contributes once its instance is expanded, including the
  // primitive nodes a subgraph uses to carry a promoted value inward.
  PrimitiveInt: ['value'],
  PrimitiveFloat: ['value'],
  PrimitiveBoolean: ['value'],
  PrimitiveString: ['value'],
  WanImageToVideo: ['width', 'height', 'length', 'batch_size'],
  Wan22ImageToVideoLatent: ['width', 'height', 'length', 'batch_size'],
  EmptyHunyuanLatentVideo: ['width', 'height', 'length', 'batch_size'],
  ModelSamplingSD3: ['shift'],
  LoraLoaderModelOnly: ['lora_name', 'strength_model'],
  ImageScale: ['upscale_method', 'width', 'height', 'crop'],
  ImageFromBatch: ['batch_index', 'length'],
  LatentUpscale: ['upscale_method', 'width', 'height', 'crop'],
}

/**
 * Replace each frontend switch with the branch the graph's own boolean selects.
 *
 * ComfyUI's frontend resolves a switch before submitting, so a document saved with one is a normal
 * workflow in the UI and a graph the server refuses. The boolean arrives from a literal primitive,
 * which makes the branch determined: taking the value the document ships with keeps the author's
 * choice instead of substituting one. A switch whose control is not a literal is left in place, so
 * the report that names it stays accurate rather than a branch being invented for it.
 * @param nodes - The flattened graph's nodes.
 * @param links - The flattened graph's links.
 * @returns the graph with every resolvable switch replaced by its selected branch.
 */
export function resolveSwitches(
  nodes: readonly SavedWorkflowNode[],
  links: readonly (readonly unknown[])[],
): { nodes: SavedWorkflowNode[]; links: readonly (readonly unknown[])[] } {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const rewired = links.map(link => [...link])
  const linkAt = (link: number): unknown[] | undefined => rewired.find(candidate => candidate[0] === link)
  const resolved = new Set<number>()
  for (const node of nodes) {
    if (node.type !== 'ComfySwitchNode') continue
    const control = node.inputs.find(input => input.name === 'switch')
    const controlLink = control === undefined || control.link === null ? undefined : linkAt(control.link)
    const source = controlLink === undefined ? undefined : byId.get(controlLink[1] as number)
    // Only a literal decides the branch. Anything else stays for the report to name.
    if (source === undefined || !/^Primitive/u.test(source.type)) continue
    const branch = node.inputs.find(input => input.name === (source.widgetsValues[0] === true ? 'on_true' : 'on_false'))
    const chosen = branch === undefined || branch.link === null ? undefined : linkAt(branch.link)
    if (chosen === undefined) continue
    // Consumers of the switch read the chosen source directly; the switch itself is gone.
    for (const consumer of nodes) {
      for (const input of consumer.inputs) {
        if (input.link === null) continue
        const found = linkAt(input.link)
        if (found === undefined || found[1] !== node.id) continue
        found[1] = chosen[1]
        found[2] = chosen[2]
      }
    }
    resolved.add(node.id)
  }
  return { nodes: nodes.filter(node => !resolved.has(node.id)), links: rewired }
}

/**
 * Read one ComfyUI saved-workflow document into the graph the converter consumes.
 *
 * Subgraph instances are expanded here, so a document that stores part of its graph in
 * `definitions.subgraphs` converts to the same flat nodes and links a hand-built one does.
 * @param value - Untrusted workflow document, as ComfyUI serves it from `/userdata`.
 * @returns the parsed graph, or undefined when the document is not a workflow.
 */
export function savedWorkflowOf(value: unknown): SavedWorkflow | undefined {
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.links)) return undefined
  const rawNodes = value.nodes.filter(isRecord).flatMap(raw => (
    typeof raw.id === 'number' && typeof raw.type === 'string'
      ? [{
        id: raw.id,
        type: raw.type,
        mode: typeof raw.mode === 'number' ? raw.mode : 0,
        inputs: namedLinks(raw.inputs),
        outputs: typedOutputs(raw.outputs),
        widgets_values: Array.isArray(raw.widgets_values) ? raw.widgets_values : [],
      }]
      : []
  ))
  const definitions = subgraphDefinitions(value.definitions)
  const expanded = expandSubgraphs(rawNodes, value.links.filter(Array.isArray), definitions)
  const resolved = resolveSwitches(expanded.nodes.map(node => ({
    id: node.id,
    type: node.type,
    mode: node.mode,
    inputs: node.inputs.map(input => ({ name: input.name, link: input.link })),
    widgetsValues: node.widgetsValues,
  })), expanded.links)
  const nodes: SavedWorkflowNode[] = resolved.nodes
  return { nodes, links: resolved.links }
}

/** Read a node's declared inputs, keeping only those that name their own link. */
function namedLinks(value: unknown): { name: string; link: number | null }[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).flatMap(input => (
    typeof input.name === 'string'
      ? [{ name: input.name, link: typeof input.link === 'number' ? input.link : null }]
      : []
  ))
}

/** Read a node's declared outputs. */
function typedOutputs(value: unknown): { name: string; type: string }[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).flatMap(output => (
    typeof output.name === 'string' && typeof output.type === 'string'
      ? [{ name: output.name, type: output.type }]
      : []
  ))
}

/** Read the document's subgraph definitions, which a subgraph instance expands from. */
function subgraphDefinitions(value: unknown): SubgraphDefinition[] {
  if (!isRecord(value) || !Array.isArray(value.subgraphs)) return []
  return value.subgraphs.filter(isRecord).flatMap(definition => (
    typeof definition.id !== 'string'
      ? []
      : [{
        id: definition.id,
        inputs: subgraphSlots(definition.inputs),
        outputs: subgraphSlots(definition.outputs),
        nodes: Array.isArray(definition.nodes) ? definition.nodes.filter(isRecord).flatMap(node => (
          typeof node.id === 'number' && typeof node.type === 'string'
            ? [{
              id: node.id,
              type: node.type,
              mode: typeof node.mode === 'number' ? node.mode : 0,
              inputs: namedLinks(node.inputs),
              outputs: typedOutputs(node.outputs),
              widgets_values: Array.isArray(node.widgets_values) ? node.widgets_values : [],
            }]
            : []
        )) : [],
        links: Array.isArray(definition.links) ? definition.links.filter(isRecord).flatMap(link => (
          typeof link.id === 'number' && typeof link.origin_id === 'number' && typeof link.target_id === 'number'
            ? [{
              id: link.id,
              origin_id: link.origin_id,
              origin_slot: typeof link.origin_slot === 'number' ? link.origin_slot : 0,
              target_id: link.target_id,
              target_slot: typeof link.target_slot === 'number' ? link.target_slot : 0,
            }]
            : []
        )) : [],
      }]
  ))
}

/** Read the promoted inputs or outputs of one subgraph definition. */
function subgraphSlots(value: unknown): SubgraphSlot[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).flatMap(slot => (
    typeof slot.name === 'string' && typeof slot.type === 'string'
      ? [{
        name: slot.name,
        type: slot.type,
        linkIds: Array.isArray(slot.linkIds) ? slot.linkIds.filter((id): id is number => typeof id === 'number') : [],
      }]
      : []
  ))
}

function savedWidgetInputs(node: SavedWorkflowNode): Record<string, unknown> {
  if (node.type === 'KSampler') {
    const values = node.widgetsValues
    return {
      seed: values[0], steps: values[2], cfg: values[3], sampler_name: values[4], scheduler: values[5], denoise: values[6],
    }
  }
  if (node.type === 'KSamplerAdvanced') {
    // The frontend keeps a reseed control at index 2 that the API does not accept, so the
    // values after it are read by position rather than through the shared table.
    const values = node.widgetsValues
    return {
      add_noise: values[0], noise_seed: values[1], steps: values[3], cfg: values[4], sampler_name: values[5],
      scheduler: values[6], start_at_step: values[7], end_at_step: values[8], return_with_leftover_noise: values[9],
    }
  }
  const names = SAVED_NODE_WIDGET_INPUTS[node.type]
  if (names === undefined) throw new Error(unsupportedNodeReason(node.type))
  return Object.fromEntries(names.flatMap((name, index) => (
    node.widgetsValues[index] === undefined ? [] : [[name, node.widgetsValues[index]]]
  )))
}

/** A type that is a subgraph instance rather than a node class. */
const SUBGRAPH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
/** A type the ComfyUI frontend defines and the server never executes. */
const FRONTEND_NODE = /^Comfy[A-Za-z]+Node$/u

/**
 * Explain a node class this deployment cannot submit.
 *
 * The two interesting cases are not missing node packs: a subgraph instance whose definition
 * the document does not carry, and a node the ComfyUI frontend evaluates itself so it never
 * reaches the server. Naming which one it is saves the reader installing a pack that would
 * not help.
 * @param type - The node's declared class.
 * @returns the reason to report.
 */
function unsupportedNodeReason(type: string): string {
  if (SUBGRAPH_ID.test(type)) return `Subgraph ${type} has no definition in this workflow`
  if (FRONTEND_NODE.test(type)) return `Workflow needs the ComfyUI frontend node ${type}, which the server cannot execute`
  return `Unsupported workflow node: ${type}`
}

/**
 * Read a saved workflow's own sampler settings.
 *
 * A graph states steps and guidance on whichever sampler it uses: KSampler carries both,
 * KSamplerAdvanced carries them behind a frontend reseed control, and the Flux 2 graphs
 * split them across Flux2Scheduler and CFGGuider. Defaulting to a fixed pair instead would
 * offer a submission on settings the graph was not tuned for, which for a guidance-distilled
 * graph is the difference between a render and noise.
 * @param nodes - A saved workflow's flat nodes, with subgraphs already expanded.
 * @returns the step count and guidance scale the graph states, or this deployment's defaults.
 */
export function savedSamplerSettings(nodes: readonly SavedWorkflowNode[]): { steps: number; cfg: number } {
  const valuesOf = (type: string): readonly unknown[] =>
    nodes.find(node => node.type === type)?.widgetsValues ?? []
  const sampler = valuesOf('KSampler')
  const advanced = valuesOf('KSamplerAdvanced')
  const sigmas = valuesOf('ManualSigmas')[0]
  const sigmaSteps = typeof sigmas === 'string' ? Math.max(0, sigmas.split(',').filter(part => part.trim() !== '').length - 1) : undefined
  const steps = [sampler[2], advanced[3], valuesOf('Flux2Scheduler')[0], sigmaSteps].find(value => typeof value === 'number')
  const cfg = [sampler[3], advanced[4], valuesOf('CFGGuider')[0]].find(value => typeof value === 'number')
  return {
    steps: typeof steps === 'number' ? steps : 24,
    cfg: typeof cfg === 'number' ? cfg : 7,
  }
}

/** Follow conditioning links back to the text encoder that produced them. */
function encoderFeeding(graph: Workflow, startId: string, inputName: string): string | undefined {
  const seen = new Set<string>()
  let current: string = startId
  let input: string = inputName
  while (!seen.has(current)) {
    seen.add(current)
    const node: Workflow[string] | undefined = graph[current]
    if (node === undefined) return undefined
    if (node.class_type === 'CLIPTextEncode') return current
    const link: unknown = node.inputs[input] ?? node.inputs.conditioning
    if (!Array.isArray(link) || typeof link[0] !== 'string') return undefined
    current = link[0]
    input = 'conditioning'
  }
  return undefined
}

/** Find the encoders feeding the sampling node's positive and negative conditioning. */
function guidanceEncoders(graph: Workflow): { positive?: string | undefined; negative?: string | undefined } {
  const sampling = nodeOf(graph, 'CFGGuider') ?? nodeOf(graph, 'KSampler') ?? nodeOf(graph, 'KSamplerAdvanced')
  if (sampling === undefined) return {}
  const [id] = sampling
  return {
    positive: encoderFeeding(graph, id, 'positive'),
    negative: encoderFeeding(graph, id, 'negative'),
  }
}

/**
 * Convert one supported ComfyUI saved workflow into an API prompt graph.
 * @param saved - Saved workflow graph.
 * @param request - Validated generation settings.
 * @param seed - Resolved sampler seed.
 * @param prefix - Output image filename prefix.
 * @returns ComfyUI prompt graph.
 */
export function savedTextToImageWorkflow(
  saved: SavedWorkflow,
  request: ComfyGenerateRequest,
  seed: number,
  prefix: string,
): Workflow {
  const graph: Workflow = {}
  const links = new Map<number, readonly unknown[]>()
  for (const link of saved.links) if (typeof link[0] === 'number') links.set(link[0], link)
  let promptAssigned = false
  for (const node of saved.nodes) {
    if (node.mode !== 0 || node.type === 'Note' || node.type === 'MarkdownNote') continue
    const inputs = savedWidgetInputs(node)
    for (const input of node.inputs) {
      if (input.link === null) continue
      const link = links.get(input.link)
      if (link === undefined || typeof link[1] !== 'number' || typeof link[2] !== 'number') {
        throw new Error(`Workflow link ${input.link} is invalid`)
      }
      inputs[input.name] = [String(link[1]), link[2]]
    }
    if (node.type === 'CLIPTextEncode') {
      inputs.text = promptAssigned ? request.negativePrompt : request.prompt
      promptAssigned = true
    } else if (node.type === 'TextEncodeQwenImage21') {
      Object.assign(inputs, { prompt: request.prompt, negative_prompt: request.negativePrompt })
    } else if (node.type === 'LTXDirector') {
      Object.assign(inputs, { global_prompt: request.prompt, custom_width: request.width, custom_height: request.height })
    } else if (node.type === 'EmptyLatentImage' || node.type === 'EmptySD3LatentImage' || node.type === 'Wan22ImageToVideoLatent' || node.type === 'WanImageToVideo' || node.type === 'EmptyLTXVLatentVideo' || node.type === 'LTXVImgToVideo') {
      Object.assign(inputs, { width: request.width, height: request.height, batch_size: request.batchSize })
    } else if (node.type === 'KSampler') {
      Object.assign(inputs, { seed, steps: request.steps, cfg: request.cfg })
    } else if (node.type === 'RandomNoise') {
      // Advanced sampling splits across nodes what KSampler carries in one. Assign only
      // an unlinked value: an array input is another node's output.
      if (!Array.isArray(inputs.noise_seed)) inputs.noise_seed = seed
    } else if (node.type === 'Flux2Scheduler') {
      if (!Array.isArray(inputs.steps)) inputs.steps = request.steps
    } else if (node.type === 'CFGGuider') {
      if (!Array.isArray(inputs.cfg)) inputs.cfg = request.cfg
    } else if (node.type === 'EmptyFlux2LatentImage') {
      // The size follows the reference image, but the batch is the composer's. A graph saved by
      // a newer frontend may not state batch_size at all, and ComfyUI refuses the whole prompt
      // when a required input is missing.
      if (inputs.batch_size === undefined) inputs.batch_size = request.batchSize
    } else if (node.type === 'SaveImage' || node.type === 'SaveVideo') {
      // Both writers take the prefix this deployment attributes outputs by, and the
      // history reader resolves a saved workflow from either writer's prefix.
      inputs.filename_prefix = prefix
    }
    // EmptyFlux2LatentImage takes its size from the reference image, so it is
    // deliberately left alone: overriding it would discard the source aspect ratio.
    graph[String(node.id)] = { class_type: node.type, inputs }
  }
  // A bypassed or note node was skipped above, so an input still naming it has nothing to
  // resolve: drop the input rather than submit a reference ComfyUI cannot follow. A bypassed
  // image loader is the common case, and the graph's own default for that input is right.
  for (const node of Object.values(graph)) {
    for (const [name, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && typeof value[0] === 'string' && graph[value[0]] === undefined) {
        Reflect.deleteProperty(node.inputs, name)
      }
    }
  }

  // The composer's prompt belongs on the encoder feeding the sampler's positive conditioning,
  // and its negative on the one feeding the negative. Document order is not that: an expanded
  // subgraph can list the negative encoder first, which swaps guidance and changes the picture
  // entirely. The loop above assigns by order, so this corrects it when the graph states the
  // wiring. A graph whose two conditioning branches share one encoder keeps its prompt there.
  const { positive, negative } = guidanceEncoders(graph)
  if (positive !== undefined) {
    // Both ids came from this graph, so each names a node.
    const encoder = graph[positive] as Workflow[string]
    encoder.inputs.text = request.prompt
    if (negative !== undefined && negative !== positive) {
      const opposing = graph[negative] as Workflow[string]
      opposing.inputs.text = request.negativePrompt
    }
  }

  // A saved graph is submittable when it writes an output. A post-processing graph — upscaling,
  // frame interpolation — has no sampler and no text encoder and carries its own settings, so
  // requiring either would reject a workflow that runs perfectly well in native ComfyUI. A graph
  // that states an encoder had its text assigned above, so the prompt needs no separate check.
  const output = nodeOf(graph, 'SaveImage') ?? nodeOf(graph, 'SaveVideo')
  if (output === undefined) {
    throw new Error('Workflow is not a supported generation graph')
  }
  return graph
}

/**
 * Point a graph's own image loader at the chosen source image.
 *
 * A saved workflow that loads an image already carries the reference slot its author
 * built it around. Appending image-to-image sampling instead would feed the graph from a
 * second copy of the image and leave that slot — and any conditioning downstream of it —
 * unused.
 * @param graph - ComfyUI prompt graph.
 * @param filename - ComfyUI annotated image path, including its directory type.
 * @returns true when the graph loads an image that could be pointed at.
 */
export function injectSourceImage(graph: Workflow, filename: string): boolean {
  const director = nodeOf(graph, 'LTXDirector')
  const guide = nodeOf(graph, 'LTXDirectorGuide')
  const latent = nodeOf(graph, 'EmptyLTXVLatentVideo')
  if (director !== undefined && guide !== undefined && latent !== undefined) {
    const next = Math.max(0, ...Object.keys(graph).map(Number).filter(Number.isFinite)) + 1
    const imageId = String(next); const latentId = String(next + 1)
    graph[imageId] = { class_type: 'LoadImage', inputs: { image: filename } }
    graph[latentId] = { class_type: 'LTXVImgToVideo', inputs: {
      ...latent[1].inputs, image: [imageId, 0], vae: guide[1].inputs.vae,
      positive: guide[1].inputs.positive, negative: guide[1].inputs.negative, strength: guide[1].inputs.image_attention_strength,
    } }
    Object.assign(guide[1].inputs, { positive: [latentId, 0], negative: [latentId, 1], latent: [latentId, 2] })
    return true
  }
  const loader = nodeOf(graph, 'LoadImage')
  if (loader === undefined) return false
  loader[1].inputs.image = filename
  return true
}

/** Replace an empty latent in-place with an image encoded through the graph's VAE.
 * @param graph - Saved or built-in text-to-image graph to modify.
 * @param filename - ComfyUI annotated image path, including its directory type.
 * @param denoise - Sampler change strength from 0.05 to 1.
 * @returns The same graph with its sampler connected to the encoded image.
 */
export function imageToImageWorkflow(graph: Workflow, filename: string, denoise: number): Workflow {
  const sampler = nodeOf(graph, 'KSampler')
  const vae = nodeOf(graph, 'VAELoader') ?? nodeOf(graph, 'CheckpointLoaderSimple')
  if (sampler === undefined || vae === undefined) throw new Error('Workflow cannot use an input image')
  const vaeOutput = vae[1].class_type === 'CheckpointLoaderSimple' ? 2 : 0
  const nextId = Math.max(0, ...Object.keys(graph).map(Number).filter(Number.isFinite)) + 1
  const loadId = String(nextId)
  const encodeId = String(nextId + 1)
  const priorLatent = sampler[1].inputs.latent_image
  if (Array.isArray(priorLatent) && typeof priorLatent[0] === 'string') {
    const node = graph[priorLatent[0]]
    if (node?.class_type === 'EmptyLatentImage' || node?.class_type === 'EmptySD3LatentImage') {
      Reflect.deleteProperty(graph, priorLatent[0])
    }
  }
  graph[loadId] = { class_type: 'LoadImage', inputs: { image: filename } }
  graph[encodeId] = { class_type: 'VAEEncode', inputs: { pixels: [loadId, 0], vae: [vae[0], vaeOutput] } }
  sampler[1].inputs.latent_image = [encodeId, 0]
  sampler[1].inputs.denoise = denoise
  return graph
}

function isWorkflow(value: unknown): value is Workflow {
  return isRecord(value) && Object.values(value).some(node => isRecord(node) && typeof node.class_type === 'string' && isRecord(node.inputs))
}

function workflowOf(value: unknown): Workflow | undefined {
  if (isWorkflow(value)) return value
  if (!Array.isArray(value)) return undefined
  return value.find(isWorkflow)
}

function stringInput(graph: Workflow, node: string, key: string): string {
  const value = graph[node]?.inputs[key]
  return typeof value === 'string' ? value : ''
}

function numberInput(graph: Workflow, node: string, key: string): number {
  const value = graph[node]?.inputs[key]
  return typeof value === 'number' ? value : 0
}

function nodeOf(graph: Workflow, classType: string): [string, WorkflowNode] | undefined {
  return Object.entries(graph).find(([, node]) => node.class_type === classType)
}

function imagesOf(value: unknown): ComfyImageReference[] {
  if (!isRecord(value)) return []
  const images: ComfyImageReference[] = []
  for (const output of Object.values(value)) {
    if (!isRecord(output)) continue
    const files: unknown[] = []
    for (const items of [output.images, output.gifs, output.videos]) {
      if (Array.isArray(items)) for (const item of items) files.push(item)
    }
    for (const image of files) {
      if (!isRecord(image) || typeof image.filename !== 'string') continue
      const reference = {
        filename: image.filename,
        subfolder: typeof image.subfolder === 'string' ? image.subfolder : '',
        type: typeof image.type === 'string' ? image.type : 'output',
      }
      if (!images.some(item => item.filename === reference.filename
        && item.subfolder === reference.subfolder && item.type === reference.type)) {
        images.push(reference)
      }
    }
  }
  return images
}

function workflowFingerprint(graph: Workflow): string {
  const dynamicInputs: Readonly<Record<string, readonly string[]>> = {
    CLIPTextEncode: ['text'],
    EmptyLatentImage: ['width', 'height', 'batch_size'],
    EmptySD3LatentImage: ['width', 'height', 'batch_size'],
    KSampler: ['seed', 'steps', 'cfg'],
    SaveImage: ['filename_prefix'],
  }
  return JSON.stringify(Object.fromEntries(Object.entries(graph).sort(([left], [right]) => left.localeCompare(right)).map(([id, node]) => {
    const omitted = new Set(dynamicInputs[node.class_type] ?? [])
    return [id, {
      class_type: node.class_type,
      inputs: Object.fromEntries(Object.entries(node.inputs)
        .filter(([name]) => !omitted.has(name))
        .sort(([left], [right]) => left.localeCompare(right))),
    }]
  })))
}

function workflowMetadataOf(value: unknown): { readonly id: string; readonly label: string } | undefined {
  if (!Array.isArray(value)) return undefined
  for (const part of value) {
    if (!isRecord(part) || !isRecord(part.aryaai)) continue
    const { workflowId, workflowLabel } = part.aryaai
    if (typeof workflowId === 'string' && typeof workflowLabel === 'string') {
      return { id: workflowId, label: workflowLabel }
    }
  }
  return undefined
}

function inferredWorkflow(
  graph: Workflow,
  identities: readonly HistoryWorkflowIdentity[],
): { readonly id: string | null; readonly label: string } {
  const fingerprint = workflowFingerprint(graph)
  const prefixes = Object.values(graph).flatMap(node => (
    ['SaveImage', 'SaveVideo', 'VHS_VideoCombine'].includes(node.class_type) && typeof node.inputs.filename_prefix === 'string'
      ? [node.inputs.filename_prefix]
      : []
  ))
  const prefixMatch = identities.find(identity => identity.outputPrefixes.some(prefix => prefixes.includes(prefix)))
  const fingerprintMatches = identities.filter(identity => identity.fingerprint === fingerprint)
  const matched = prefixMatch ?? (fingerprintMatches.length === 1 ? fingerprintMatches[0] : undefined)
  if (matched !== undefined) return { id: matched.id, label: matched.label }
  if (nodeOf(graph, 'SaveVideo') !== undefined || nodeOf(graph, 'VHS_VideoCombine') !== undefined) return { id: null, label: 'Custom video workflow' }
  if (nodeOf(graph, 'TextEncodeQwenImage21') !== undefined) return { id: null, label: 'Custom Qwen Image 2.1 workflow' }
  return nodeOf(graph, 'UNETLoader') === undefined
    ? { id: null, label: 'Custom checkpoint workflow' }
    : { id: null, label: 'Custom Z-Image workflow' }
}

/**
 * Read a saved UI-format workflow's output kind from its own output nodes.
 *
 * ComfyUI names a video graph by the node that muxes it. Without this the composer
 * can only say which workflows exist, so a saved image-to-video graph is presented
 * as though it produced a still.
 * @param nodes - The saved workflow's nodes.
 * @returns `video` when the graph writes one, otherwise `image`.
 */
/**
 * Read whether a saved graph encodes a prompt, from an active text encoder.
 *
 * A post-processing graph — upscaling, frame interpolation — has none, and asking its caller for
 * a prompt demands input the graph discards. Absent encodes this as `undefined`, which callers
 * read as "a prompt applies"; only the negative answer is stated.
 * @param nodes - The saved graph's nodes.
 * @returns `false` when the graph encodes no prompt, otherwise `undefined`.
 */
export function savedWorkflowTakesPrompt(
  nodes: readonly { readonly type: string; readonly mode?: number | undefined }[],
): false | undefined {
  return nodes.some(node => (node.type === 'CLIPTextEncode' || node.type === 'TextEncodeQwenImage21' || node.type === 'LTXDirector') && (node.mode ?? 0) === 0) ? undefined : false
}

/**
 * Read whether a saved graph needs a source image, from an active image loader.
 *
 * A caller that cannot supply one — the generation tool, or a first request in the panel — needs
 * this to tell a create workflow from one that would run against whatever file the graph names.
 * A bypassed loader does not count, because that graph runs on its own.
 * @param nodes - The saved graph's nodes.
 * @returns `edit` when a source image is required, otherwise `undefined`.
 */
export function savedWorkflowTask(nodes: readonly { readonly type: string; readonly mode?: number | undefined }[]): 'edit' | undefined {
  return nodes.some(node => node.type === 'LoadImage' && (node.mode ?? 0) === 0) ? 'edit' : undefined
}

/**
 * Whether a converted graph names a checkpoint the server does not report.
 *
 * A graph whose model loader this catalog does not model — an upscale graph, a frame interpolator,
 * a video or Flux 2 graph — has nothing to compare here, so it reports false: treating an
 * unmodelled loader as a missing file hides a workflow the deployment can in fact submit.
 * @param graph - The converted prompt graph.
 * @param models - The models the connected server reports.
 * @returns true only when the graph loads a checkpoint the server does not list.
 */
export function absentCheckpoint(graph: Workflow, models: readonly CatalogModel[]): boolean {
  const checkpoint = nodeOf(graph, 'CheckpointLoaderSimple')
  if (checkpoint === undefined) return false
  const name = stringInput(graph, checkpoint[0], 'ckpt_name')
  // A loader whose file name is empty names nothing to compare against.
  if (name === '') return false
  return !models.some(model => model.kind === 'checkpoint' && model.checkpoint === name)
}

/**
 * Read whether a saved graph writes a still or a video, from the node that writes it.
 *
 * The writer node decides, not the model or the graph's title, so a video workflow is never
 * presented as a still one.
 * @param nodes - The saved graph's nodes.
 * @returns `video` when the graph writes one, otherwise `image`.
 */
export function savedWorkflowOutput(nodes: readonly { readonly type: string }[]): 'image' | 'video' {
  return nodes.some(node => node.type === 'SaveVideo' || node.type === 'VHS_VideoCombine') ? 'video' : 'image'
}

/** Reconstruct generations from ComfyUI history entries.
 * @param value - Untrusted ComfyUI history JSON.
 * @param identities - Saved workflow identities available at read time.
 * @returns Generations with image references and resolved workflow labels.
 */export function generationsOf(
  value: unknown,
  identities: readonly HistoryWorkflowIdentity[] = [],
): ComfyGeneration[] {
  if (!isRecord(value)) return []
  const generations: ComfyGeneration[] = []
  for (const [promptId, raw] of Object.entries(value).reverse()) {
    if (!isRecord(raw)) continue
    const graph = workflowOf(raw.prompt)
    if (graph === undefined) continue
    const video = nodeOf(graph, 'SaveVideo') !== undefined || nodeOf(graph, 'VHS_VideoCombine') !== undefined
    if (!video && nodeOf(graph, 'SaveImage') === undefined) continue
    const status = isRecord(raw.status) ? raw.status : undefined
    const checkpoint = nodeOf(graph, 'CheckpointLoaderSimple')
    const diffusion = nodeOf(graph, 'UNETLoader')
    const qwen = nodeOf(graph, 'TextEncodeQwenImage21')
    const director = nodeOf(graph, 'LTXDirector')
    const positive = director ?? qwen ?? nodeOf(graph, 'CLIPTextEncode')
    const encoders = Object.entries(graph).filter(([, node]) => node.class_type === 'CLIPTextEncode')
    const negative = encoders[1]
    const latent = nodeOf(graph, 'EmptyLTXVLatentVideo') ?? nodeOf(graph, 'EmptyFlux2LatentImage') ?? nodeOf(graph, 'Wan22ImageToVideoLatent') ?? nodeOf(graph, 'WanImageToVideo')
      ?? nodeOf(graph, qwen !== undefined || checkpoint !== undefined ? 'EmptyLatentImage' : 'EmptySD3LatentImage')
    const sampler = nodeOf(graph, 'KSampler') ?? nodeOf(graph, 'KSamplerAdvanced') ?? nodeOf(graph, 'SamplerCustomAdvanced')
    if (positive === undefined || sampler === undefined) continue
    const flux = nodeOf(graph, 'Flux2Scheduler') !== undefined
    const scheduler = nodeOf(graph, 'Flux2Scheduler')
    const guider = nodeOf(graph, 'CFGGuider')
    const noise = nodeOf(graph, 'RandomNoise')
    const manualSigmas = nodeOf(graph, 'ManualSigmas')
    const promptParts: unknown[] = Array.isArray(raw.prompt) ? raw.prompt : []
    const metadataPart = promptParts.find(part => isRecord(part) && isRecord(part.aryaai))
    const runSettings = isRecord(metadataPart) && isRecord(metadataPart.aryaai) ? metadataPart.aryaai : undefined
    let sourceNode = nodeOf(graph, 'VAEEncode')?.[1] ?? nodeOf(graph, 'LTXVImgToVideo')?.[1]
    const reference = qwen?.[1].inputs['images.image_1']
    if (Array.isArray(reference) && typeof reference[0] === 'string') sourceNode = graph[reference[0]]
    const visited = new Set<string>()
    while (sourceNode !== undefined && sourceNode.class_type !== 'LoadImage') {
      const link = sourceNode.inputs.pixels ?? sourceNode.inputs.image
      if (!Array.isArray(link) || typeof link[0] !== 'string' || visited.has(link[0])) { sourceNode = undefined; break }
      visited.add(link[0]); sourceNode = graph[link[0]]
    }
    const annotated = typeof sourceNode?.inputs.image === 'string' ? sourceNode.inputs.image : ''
    const match = /^(.*?)(?: \[(input|output|temp)\])?$/u.exec(annotated)
    const sourcePath = match?.[1] ?? ''
    const slash = sourcePath.lastIndexOf('/')
    const sourceImage: ComfyImageReference | null = sourcePath === '' ? null : {
      filename: sourcePath.slice(slash + 1), subfolder: slash < 0 ? '' : sourcePath.slice(0, slash), type: match?.[2] ?? 'input',
    }
    const model = checkpoint === undefined
      ? `${video ? 'diffusion' : qwen !== undefined ? 'qwen-image-2.1' : flux ? 'flux2-klein' : 'z-image-turbo'}:${encodeURIComponent(stringInput(graph, diffusion?.[0] ?? '', 'unet_name'))}`
      : `checkpoint:${encodeURIComponent(stringInput(graph, checkpoint[0], 'ckpt_name'))}`
    const modelLabel = checkpoint === undefined
      ? video ? stringInput(graph, diffusion?.[0] ?? '', 'unet_name') : `${qwen !== undefined ? 'Qwen Image 2.1' : flux ? 'Flux 2 Klein' : 'Z-Image Turbo'} · ${stringInput(graph, diffusion?.[0] ?? '', 'unet_name')}`
      : stringInput(graph, checkpoint[0], 'ckpt_name')
    const metadata = workflowMetadataOf(raw.prompt)
    const workflow = metadata ?? inferredWorkflow(graph, identities)
    generations.push({
      promptId,
      state: status?.status_str === 'error' ? 'error' : 'complete',
      workflow: 'id' in workflow ? workflow.id : null,
      workflowLabel: workflow.label,
      prompt: stringInput(graph, positive[0], director !== undefined ? 'global_prompt' : qwen === undefined ? 'text' : 'prompt'),
      negativePrompt: qwen === undefined ? negative === undefined ? '' : stringInput(graph, negative[0], 'text') : stringInput(graph, qwen[0], 'negative_prompt'),
      model,
      modelLabel,
      width: typeof runSettings?.width === 'number' ? runSettings.width : numberInput(graph, latent?.[0] ?? '', 'width'),
      height: typeof runSettings?.height === 'number' ? runSettings.height : numberInput(graph, latent?.[0] ?? '', 'height'),
      steps: manualSigmas === undefined ? numberInput(graph, scheduler?.[0] ?? sampler[0], 'steps')
        : Math.max(0, stringInput(graph, manualSigmas[0], 'sigmas').split(',').filter(part => part.trim() !== '').length - 1),
      cfg: numberInput(graph, guider?.[0] ?? sampler[0], 'cfg'),
      seed: noise === undefined ? numberInput(graph, sampler[0], 'seed') : numberInput(graph, noise[0], 'noise_seed'),
      sourceImage, denoise: numberInput(graph, sampler[0], 'denoise'),
      images: imagesOf(raw.outputs),
    })
  }
  return generations
}

/** `execFile` returns a stream unless it is given a callback; this is the promise form. */
const execFileAsync = promisify(execFile)

/** Remote controller used by the Images Cordis UI plugin. */
export class ComfyImagesController extends TypertRemoteService {
  static Config: z<Config, ResolvedConfig> = z.object({
    baseUrl: z.string().min(1).default('http://127.0.0.1:8188'),
    outputPrefix: z.string().min(1).default('AryaAI'),
    requestTimeoutMs: z.number().step(1).min(1_000).max(300_000).default(30_000),
    outputDirectory: z.string().default(''),
    serverPythonPath: z.string().default(''),
    serverDirectory: z.string().default(''),
    serverStartTimeoutMs: z.number().step(1).min(1_000).max(600_000).default(120_000),
    maxVideoSeconds: z.number().min(1).max(120).default(30),
    ffmpegPath: z.string().default(''),
    filmTimeoutMs: z.number().step(1).min(1000).max(3600000).default(600000),
    maxFilmSeconds: z.number().min(1).max(86400).default(1800),
    filmCrf: z.number().step(1).min(0).max(51).default(20),
    filmEncoderPreset: z.union(['ultrafast', 'fast', 'medium', 'slow']).default('medium'),
  })

  private readonly config: ResolvedConfig
  private savedCatalogCache: { readonly expiresAt: number; readonly value: Promise<readonly SavedCatalogEntry[]> } | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'comfyImagesController', { namespace: 'comfyImages' })
    this.config = {
      baseUrl: normalizedBaseUrl(config.baseUrl ?? 'http://127.0.0.1:8188'),
      outputPrefix: config.outputPrefix ?? 'AryaAI',
      requestTimeoutMs: config.requestTimeoutMs ?? 30_000,
      outputDirectory: config.outputDirectory?.trim() ? resolve(config.outputDirectory) : null,
      serverPythonPath: config.serverPythonPath?.trim() ? resolve(config.serverPythonPath) : null,
      serverDirectory: config.serverDirectory?.trim() ? resolve(config.serverDirectory) : null,
      serverStartTimeoutMs: config.serverStartTimeoutMs ?? 120_000,
      maxVideoSeconds: config.maxVideoSeconds ?? 30,
      ffmpegPath: config.ffmpegPath?.trim() || null,
      filmTimeoutMs: config.filmTimeoutMs ?? 600000,
      maxFilmSeconds: config.maxFilmSeconds ?? 1800,
      filmCrf: config.filmCrf ?? 20,
      filmEncoderPreset: config.filmEncoderPreset ?? 'medium',
    }
    ctx.inject(['connection'], (connected) => {
      connected.effect(() => connected.connection.fetch.register({
        path: COMFY_MEDIA_PATH, methods: ['GET', 'HEAD'], requestBody: 'buffered',
        fetch: request => this.config.outputDirectory === null
          ? Promise.resolve(new Response('Local media is unavailable', { status: 404 }))
          : comfyMediaResponse(this.config.outputDirectory, request),
      }), 'comfyui-controller: media route')
      connected.effect(() => connected.connection.fetch.register({
        path: COMFY_ARCHIVE_PATH, methods: ['GET', 'HEAD'], requestBody: 'buffered',
        fetch: request => this.config.outputDirectory === null
          ? comfyRemoteArchiveResponse(request, (image, method, signal) => {
            const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type })
            return this.request(`/view?${query}`, { method }, signal)
          })
          : comfyArchiveResponse(this.config.outputDirectory, request),
      }), 'comfyui-controller: archive route')
    })
  }

  private async request(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    return fetch(`${this.config.baseUrl}${path}`, { ...init, signal: combined })
  }

  private annotatedSourceImage(image: ComfyImageReference): string {
    if (!['input', 'output', 'temp'].includes(image.type) || image.filename !== basename(image.filename)) {
      throw new Error('Invalid ComfyUI source image')
    }
    const segments = image.subfolder.split(/[\\/]/u).filter(Boolean)
    if (segments.some(segment => segment === '..' || segment === '.' || segment.includes(':'))) {
      throw new Error('Invalid ComfyUI source image folder')
    }
    return `${[...segments, image.filename].join('/')} [${image.type}]`
  }

  private async nodeChoices(node: string, input: string, signal?: AbortSignal): Promise<string[]> {
    const response = await this.request(`/object_info/${node}`, {}, signal)
    if (!response.ok) return []
    const body: unknown = await response.json()
    if (!isRecord(body)) return []
    const loader = body[node]
    if (!isRecord(loader) || !isRecord(loader.input) || !isRecord(loader.input.required)) return []
    const choices = loader.input.required[input]
    if (!Array.isArray(choices) || !Array.isArray(choices[0])) return []
    return choices[0].filter((item): item is string => typeof item === 'string')
  }

  private async models(signal?: AbortSignal): Promise<CatalogModel[]> {
    const [checkpoints, diffusionModels, textEncoders, vaes] = await Promise.all([
      this.nodeChoices('CheckpointLoaderSimple', 'ckpt_name', signal),
      this.nodeChoices('UNETLoader', 'unet_name', signal),
      this.nodeChoices('CLIPLoader', 'clip_name', signal),
      this.nodeChoices('VAELoader', 'vae_name', signal),
    ])
    const models: CatalogModel[] = checkpoints.map(checkpoint => ({
      id: `checkpoint:${encodeURIComponent(checkpoint)}`,
      label: checkpoint,
      kind: 'checkpoint',
      recommendedSteps: 24,
      recommendedCfg: 7,
      checkpoint,
    }))
    const diffusionModel = diffusionModels.find(name => /z[_-]image.*turbo/iu.test(name))
    const textEncoder = textEncoders.find(name => /qwen[_-]3[_-]4b/iu.test(name))
    const vae = vaes.find(name => /^ae(?:\.|_)/iu.test(name))
    if (diffusionModel !== undefined && textEncoder !== undefined && vae !== undefined) {
      models.unshift({
        id: `z-image-turbo:${encodeURIComponent(diffusionModel)}`,
        label: 'Z-Image Turbo',
        kind: 'z-image-turbo',
        recommendedSteps: 9,
        recommendedCfg: 1,
        diffusionModel,
        textEncoder,
        vae,
      })
    }
    const flux = diffusionModels.find(name => /flux[-_]2[-_]klein[-_]4b/iu.test(name) && !/base/iu.test(name))
    const fluxVae = vaes.find(name => /flux2[-_]vae/iu.test(name))
    if (flux !== undefined && textEncoder !== undefined && fluxVae !== undefined) {
      models.push({ id: 'flux2-klein:' + encodeURIComponent(flux), label: 'Flux 2 Klein', kind: 'flux2-klein',
        recommendedSteps: 4, recommendedCfg: 1, diffusionModel: flux, textEncoder, vae: fluxVae })
    }
    // The base variant is the same installation without step distillation. A saved workflow that
    // loads it runs, so omitting it would report an installed model as absent, and a graph that
    // names it would be listed without a model even though the server has one.
    const baseFlux = diffusionModels.find(name => /flux[-_]2[-_]klein[-_]?base[-_]4b/iu.test(name))
    if (baseFlux !== undefined && textEncoder !== undefined && fluxVae !== undefined) {
      models.push({ id: 'flux2-klein:' + encodeURIComponent(baseFlux), label: 'Flux 2 Klein (base)', kind: 'flux2-klein',
        recommendedSteps: 20, recommendedCfg: 5, diffusionModel: baseFlux, textEncoder, vae: fluxVae })
    }
    return models
  }

  private graphModel(graph: Workflow, models: readonly CatalogModel[]): CatalogModel | undefined {
    const checkpoint = nodeOf(graph, 'CheckpointLoaderSimple')
    if (checkpoint !== undefined) {
      const name = stringInput(graph, checkpoint[0], 'ckpt_name')
      return models.find(model => model.kind === 'checkpoint' && model.checkpoint === name)
    }
    const unet = nodeOf(graph, 'UNETLoader')
    const clip = nodeOf(graph, 'CLIPLoader')
    const vae = nodeOf(graph, 'VAELoader')
    if (unet === undefined || clip === undefined || vae === undefined) return undefined
    // Any split installation, not only Z-Image Turbo: a Flux 2 Klein graph loads the same three
    // files, and naming its model only for one kind leaves the other without one.
    return models.find(model => model.kind !== 'checkpoint'
      && model.diffusionModel === stringInput(graph, unet[0], 'unet_name')
      && model.textEncoder === stringInput(graph, clip[0], 'clip_name')
      && model.vae === stringInput(graph, vae[0], 'vae_name'))
  }

  private async savedWorkflow(name: string, signal?: AbortSignal): Promise<SavedWorkflow> {
    const response = await this.request(`/userdata/${encodeURIComponent(`workflows/${name}`)}`, {}, signal)
    if (!response.ok) throw new Error(`ComfyUI workflow ${name} returned HTTP ${response.status}`)
    const workflow = savedWorkflowOf(await response.json())
    if (workflow === undefined) throw new Error(`ComfyUI workflow ${name} is invalid`)
    return workflow
  }

  private savedCatalog(): Promise<readonly SavedCatalogEntry[]> {
    const now = Date.now()
    if (this.savedCatalogCache !== undefined && this.savedCatalogCache.expiresAt > now) return this.savedCatalogCache.value
    const value = (async () => {
      const response = await this.request('/userdata?dir=workflows&recurse=true&split=false')
      if (!response.ok) return []
      const raw: unknown = await response.json()
      if (!Array.isArray(raw)) return []
      const names = raw.filter((item): item is string => typeof item === 'string' && item.toLowerCase().endsWith('.json')).slice(0, 100)
      return Promise.all(names.map(async (name): Promise<SavedCatalogEntry> => {
        try {
          return { name, workflow: await this.savedWorkflow(name) }
        } catch (error) {
          return { name, error: messageOf(error) }
        }
      }))
    })()
    this.savedCatalogCache = { expiresAt: now + 5_000, value }
    void value.catch(() => { if (this.savedCatalogCache?.value === value) this.savedCatalogCache = undefined })
    return value
  }

  private historyWorkflowIdentities(saved: readonly SavedCatalogEntry[]): HistoryWorkflowIdentity[] {
    return saved.flatMap(({ name, workflow }) => {
      if (workflow === undefined) return []
      const id = `saved:${encodeURIComponent(name)}`
      const label = name.replace(/\.json$/iu, '')
      const sampler = workflow.nodes.find(node => node.type === 'KSampler')
      const values = sampler?.widgetsValues ?? []
      const example: ComfyGenerateRequest = {
        prompt: 'history identity', negativePrompt: '', model: null, workflow: id,
        width: 1024, height: 1024, steps: typeof values[2] === 'number' ? values[2] : 24,
        cfg: typeof values[3] === 'number' ? values[3] : 7, seed: 0, batchSize: 1,
        sourceImage: null, denoise: 1,
      }
      try {
        const graph = savedTextToImageWorkflow(workflow, example, 0, this.config.outputPrefix)
        const outputPrefixes = workflow.nodes.flatMap(node => (
          node.type === 'SaveImage' && typeof node.widgetsValues[0] === 'string' ? [node.widgetsValues[0]] : []
        ))
        return [{ id, label, outputPrefixes, fingerprint: workflowFingerprint(graph) }]
      } catch {
        return []
      }
    })
  }

  private async workflows(models: readonly CatalogModel[], signal?: AbortSignal): Promise<CatalogWorkflow[]> {
    const primary = models.find(model => model.kind !== 'flux2-klein')
    const editModel = models.find(model => model.kind === 'flux2-klein')
    const edit: CatalogWorkflow = {
      id: 'built-in:flux-reference-edit', label: 'Flux 2 Klein · Edit image', source: 'built-in', task: 'edit',
      available: editModel !== undefined, unavailableReason: editModel === undefined ? 'Flux 2 Klein 4B, Qwen 3 4B and Flux 2 VAE are required' : null,
      recommendedSteps: 4, recommendedCfg: 1, supportsNegativePrompt: false, modelId: editModel?.id ?? null,
      starterPrompt: '', width: 1024, height: 1024, batchSize: 1, output: 'image',
    }
    const builtIn: CatalogWorkflow = {
      id: 'built-in:standard',
      label: primary?.kind === 'z-image-turbo' ? 'Z-Image Turbo · AryaAI standard' : 'AryaAI standard',
      source: 'built-in',
      available: primary !== undefined,
      unavailableReason: primary === undefined ? 'No compatible model is installed' : null,
      recommendedSteps: primary?.recommendedSteps ?? 24,
      recommendedCfg: primary?.recommendedCfg ?? 7,
      supportsNegativePrompt: primary?.kind !== 'z-image-turbo',
      modelId: primary?.id ?? null,
      starterPrompt: '', width: 1024, height: 1024, batchSize: 1, output: 'image',
    }
    try {
      const catalog = await this.savedCatalog()
      signal?.throwIfAborted()
      const saved = catalog.map(({ name, workflow, error }): CatalogWorkflow => {
        const id = `saved:${encodeURIComponent(name)}`
        const label = name.replace(/\.json$/iu, '')
        try {
          if (workflow === undefined) throw new Error(error ?? `ComfyUI workflow ${name} is invalid`)
          // Read at the UI level, where the graph still names its own output nodes.
          const output = savedWorkflowOutput(workflow.nodes)
          const settings = savedSamplerSettings(workflow.nodes)
          const example: ComfyGenerateRequest = {
            prompt: 'compatibility probe', negativePrompt: '', model: null, workflow: id,
            width: 1024, height: 1024, steps: settings.steps, cfg: settings.cfg, seed: 0, batchSize: 1,
            sourceImage: null, denoise: 1,
          }
          const graph = savedTextToImageWorkflow(workflow, example, 0, this.config.outputPrefix)
          const matchedModel = this.graphModel(graph, models)
          const available = !absentCheckpoint(graph, models)
          const starter = workflow.nodes.find(node => (node.type === 'CLIPTextEncode' || node.type === 'TextEncodeQwenImage21') && node.mode === 0)
          const latent = workflow.nodes.find(node => (
            node.type === 'EmptyLatentImage' || node.type === 'EmptySD3LatentImage' || node.type === 'Wan22ImageToVideoLatent' || node.type === 'WanImageToVideo' || node.type === 'EmptyLTXVLatentVideo') && node.mode === 0)
          const latentValues = latent?.widgetsValues ?? []
          return {
            id, label, source: 'saved', available,
            ...(workflow.nodes.some(node => node.type === 'LTXDirector') && workflow.nodes.some(node => node.type === 'LTXDirectorGuide') ? { acceptsReference: true } : {}),
            unavailableReason: available ? null : 'Required model files are not installed',
            // A saved graph that loads an image needs a staged source, which is what the panel's
            // Edit action supplies.
            task: savedWorkflowTask(workflow.nodes),
            recommendedSteps: example.steps,
            recommendedCfg: example.cfg,
            supportsNegativePrompt: workflow.nodes.some(node => node.type === 'TextEncodeQwenImage21' && node.mode === 0)
              || workflow.nodes.filter(node => node.type === 'CLIPTextEncode' && node.mode === 0).length > 1,
            takesPrompt: savedWorkflowTakesPrompt(workflow.nodes),
            modelId: matchedModel?.id ?? null,
            starterPrompt: typeof starter?.widgetsValues[0] === 'string' ? starter.widgetsValues[0] : '',
            width: typeof latentValues[0] === 'number' ? latentValues[0] : 1024,
            height: typeof latentValues[1] === 'number' ? latentValues[1] : 1024,
            batchSize: typeof latentValues[2] === 'number' ? latentValues[2] : 1,
            output,
            saved: workflow,
          }
        } catch (error) {
          return {
            id, label, source: 'saved', available: false, unavailableReason: messageOf(error),
            recommendedSteps: 24, recommendedCfg: 7, supportsNegativePrompt: true,
            modelId: null,
            starterPrompt: '', width: 1024, height: 1024, batchSize: 1, output: 'image',
          }
        }
      })
      return [...saved, builtIn, edit]
    } catch {
      return [builtIn, edit]
    }
  }

  /** Probe ComfyUI and list locally installed model configurations Arya can run.
   * @param signal - Cancellation signal for the Remote call.
   * @returns Connection state, models, and saved workflows.
   */
  @Remote
  async status(signal: AbortSignal): Promise<ComfyImagesStatus> {
    try {
      const response = await this.request('/system_stats', {}, signal)
      if (!response.ok) throw new Error(`ComfyUI returned HTTP ${response.status}`)
      const catalogModels = await this.models(signal)
      const models = catalogModels.map(({ id, label, kind, recommendedSteps, recommendedCfg }) => ({
        id, label, kind, recommendedSteps, recommendedCfg,
      }))
      const workflows = (await this.workflows(catalogModels, signal)).map(({
        id, label, source, available, unavailableReason, recommendedSteps, recommendedCfg, supportsNegativePrompt, modelId,
        starterPrompt, width, height, batchSize, task, output,
      }) => ({ id, label, source, available, unavailableReason, recommendedSteps, recommendedCfg, supportsNegativePrompt, modelId,
        starterPrompt, width, height, batchSize, task, output }))
      return { reachable: true, baseUrl: this.config.baseUrl, models, workflows,
        libraryAvailable: this.config.outputDirectory !== null, error: null }
    } catch (error) {
      return { reachable: false, baseUrl: this.config.baseUrl, models: [], workflows: [],
        libraryAvailable: this.config.outputDirectory !== null, error: messageOf(error) }
    }
  }

  /** Queue one supported ComfyUI workflow.
   * @param request - Generation settings and optional source image.
   * @param signal - Cancellation signal for the Remote call.
   * @returns Queued prompt identifier and resolved seed.
   */
  /**
   * ComfyUI's own processes on this machine, matched by the command line that
   * runs `main.py` on the configured port.
   *
   * Identity comes from the command line rather than from the listening port,
   * because this machine's Tailscale daemon also listens on the ComfyUI port
   * to forward it onto the tailnet. A port match would kill the tunnel.
   * @returns the matching process ids; empty when none run.
   */
  private async comfyServerPids(): Promise<readonly number[]> {
    if (process.platform !== 'win32') return []
    const port = new URL(this.config.baseUrl).port
    const script = 'Get-CimInstance Win32_Process -Filter "Name=\'python.exe\'"'
      + ` | Where-Object { $_.CommandLine -match 'main\\.py' -and $_.CommandLine -match '${port}' }`
      + ' | Select-Object -ExpandProperty ProcessId | ConvertTo-Json -Compress'
    const { stdout } = await execFileAsync(
      'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 20_000 },
    )
    const trimmed = stdout.trim()
    if (trimmed.length === 0) return []
    const parsed: unknown = JSON.parse(trimmed)
    const ids: readonly unknown[] = Array.isArray(parsed) ? parsed : [parsed]
    return ids.filter((id): id is number => typeof id === 'number')
  }

  /**
   * Whether ComfyUI answers on its HTTP endpoint.
   * @param signal - caller cancellation for the probe.
   * @returns true when `/system_stats` answers.
   */
  private async serverAnswers(signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.baseUrl}/system_stats`, {
        signal: signal ?? AbortSignal.timeout(5_000),
      })
      return response.ok
    } catch {
      // A refused connection is the answer: nothing is listening.
      return false
    }
  }

  /**
   * Validate the configured start paths.
   * @returns the interpreter and working directory, or why they are unusable.
   */
  private async serverPaths(): Promise<{ readonly python: string; readonly cwd: string } | { readonly error: string }> {
    const python = this.config.serverPythonPath
    const cwd = this.config.serverDirectory
    if (python === null || cwd === null) {
      return { error: 'Set the ComfyUI interpreter and server directory to control the server from this panel.' }
    }
    try {
      await stat(python)
    } catch {
      return { error: `ComfyUI interpreter not found: ${python}` }
    }
    try {
      await stat(join(cwd, 'main.py'))
    } catch {
      return { error: `main.py not found under ${cwd}` }
    }
    return { python, cwd }
  }

  /**
   * Start ComfyUI, detached from this process so it outlives the application.
   * @param signal - caller cancellation for the readiness probe.
   * @returns whether it answered, and what happened.
   */
  @Remote
  async startServer(signal: AbortSignal): Promise<ComfyServerControlResult> {
    if (await this.serverAnswers(signal)) return { running: true, detail: 'ComfyUI was already running.' }
    const paths = await this.serverPaths()
    if ('error' in paths) return { running: false, detail: paths.error }

    const port = new URL(this.config.baseUrl).port
    const child = spawn(paths.python, [
      'main.py', '--port', port, '--listen', '127.0.0.1', '--disable-auto-launch',
    ], { cwd: paths.cwd, detached: true, stdio: 'ignore', windowsHide: true })
    // Detached and unreferenced: the server keeps running when this process
    // exits, which is what makes the panel's Start durable.
    child.unref()

    const deadline = Date.now() + this.config.serverStartTimeoutMs
    while (Date.now() < deadline) {
      if (await this.serverAnswers(signal)) return { running: true, detail: 'ComfyUI started.' }
      await new Promise(done => setTimeout(done, 1_000))
    }
    const seconds = Math.round(this.config.serverStartTimeoutMs / 1_000)
    return { running: false, detail: `ComfyUI did not answer within ${String(seconds)}s.` }
  }

  /**
   * Stop ComfyUI.
   * @param signal - caller cancellation for the final state probe.
   * @returns whether it still answers, and what happened.
   */
  @Remote
  async stopServer(signal: AbortSignal): Promise<ComfyServerControlResult> {
    const pids = await this.comfyServerPids()
    if (pids.length === 0) {
      return { running: await this.serverAnswers(signal), detail: 'No ComfyUI process was running.' }
    }
    for (const pid of pids) process.kill(pid)
    for (let waited = 0; waited < 30_000; waited += 500) {
      if ((await this.comfyServerPids()).length === 0) break
      await new Promise(done => setTimeout(done, 500))
    }
    const running = await this.serverAnswers(signal)
    const count = `${String(pids.length)} process${pids.length === 1 ? '' : 'es'}`
    return { running, detail: running ? 'ComfyUI did not stop.' : `Stopped ComfyUI (${count}).` }
  }

  /**
   * Restart ComfyUI: stop, then start again.
   * @param signal - caller cancellation for the readiness probe.
   * @returns whether it answered, and what happened.
   */
  @Remote
  async restartServer(signal: AbortSignal): Promise<ComfyServerControlResult> {
    const stopped = await this.stopServer(signal)
    if (stopped.running) return stopped
    return await this.startServer(signal)
  }

  /** Submit a validated catalog workflow to the configured ComfyUI server.
   * @param request - Prompt, workflow, model, and generation settings.
   * @param signal - Cancels discovery and submission requests.
   * @returns The submitted prompt identifier and resolved seed.
   */
  @Remote
  async generate(request: ComfyGenerateRequest, signal: AbortSignal): Promise<ComfyGenerateReceipt> {
    const prompt = request.prompt.trim()
    if (prompt.length === 0) throw new Error('Describe the image before generating it')
    if (prompt.length > 8_000 || request.negativePrompt.length > 8_000) throw new Error('Prompt text is too long')
    integer('width', request.width, 64, 4096)
    integer('height', request.height, 64, 4096)
    if (request.width % 8 !== 0 || request.height % 8 !== 0) throw new Error('width and height must be multiples of 8')
    integer('steps', request.steps, 1, 150)
    integer('batchSize', request.batchSize, 1, 8)
    if (!Number.isFinite(request.cfg) || request.cfg < 0 || request.cfg > 30) throw new Error('cfg must be from 0 to 30')
    if (!Number.isFinite(request.denoise) || request.denoise < 0.05 || request.denoise > 1) {
      throw new Error('Image change strength must be from 0.05 to 1')
    }
    const available = await this.models(signal)
    const workflows = await this.workflows(available, signal)
    const workflowChoice = request.workflow === null
      ? workflows.find(item => item.available)
      : workflows.find(item => item.id === request.workflow && item.available)
    if (workflowChoice === undefined) throw new Error('ComfyUI has no compatible image workflow available')
    const seed = request.seed ?? randomInt(0, 2_147_483_647)
    integer('seed', seed, 0, Number.MAX_SAFE_INTEGER)
    const normalizedRequest = { ...request, prompt }
    let workflow: Workflow
    if (workflowChoice.task === 'edit' && request.sourceImage === null) throw new Error('Select a source image for this workflow')
    if (workflowChoice.task === 'edit' && workflowChoice.source === 'built-in') {
      const model = available.find(item => item.id === workflowChoice.modelId)
      if (model?.kind !== 'flux2-klein' || request.sourceImage === null) throw new Error('Select a source image for Flux reference editing')
      workflow = fluxReferenceWorkflow(
        normalizedRequest, model, this.annotatedSourceImage(request.sourceImage), seed, this.config.outputPrefix,
      )
    } else if (workflowChoice.source === 'saved' && workflowChoice.saved !== undefined) {
      workflow = savedTextToImageWorkflow(workflowChoice.saved, normalizedRequest, seed, this.config.outputPrefix)
    } else {
      const model = request.model === null ? available[0] : available.find(item => item.id === request.model)
      if (model === undefined || model.kind === 'flux2-klein') throw new Error('Select a text-to-image model for this workflow')
      workflow = model.kind === 'checkpoint'
        ? basicTextToImageWorkflow(normalizedRequest, model.checkpoint, seed, this.config.outputPrefix)
        : zImageTurboWorkflow(normalizedRequest, {
          diffusionModel: model.diffusionModel, textEncoder: model.textEncoder, vae: model.vae,
        }, seed, this.config.outputPrefix)
    }
    if (request.sourceImage !== null && !(workflowChoice.task === 'edit' && workflowChoice.source === 'built-in')) {
      const filename = this.annotatedSourceImage(request.sourceImage)
      if (workflowChoice.source !== 'saved' || !injectSourceImage(workflow, filename)) {
        imageToImageWorkflow(workflow, filename, request.denoise)
      }
    }
    if (request.videoSettings !== undefined) applyVideoSettings(workflow, request.videoSettings, this.config.maxVideoSeconds)
    const response = await this.request('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: workflow,
        client_id: `aryaai-${randomUUID()}`,
        extra_data: { aryaai: {
          workflowId: workflowChoice.id, workflowLabel: workflowChoice.label,
          sourceImage: request.sourceImage, width: request.width, height: request.height,
        } },
      }),
    }, signal)
    if (!response.ok) throw new Error(`ComfyUI rejected the workflow with HTTP ${response.status}: ${await response.text()}`)
    const body: unknown = await response.json()
    if (!isRecord(body) || typeof body.prompt_id !== 'string') throw new Error('ComfyUI returned no prompt id')
    return { promptId: body.prompt_id, seed }
  }

  /** Assemble retained output clips into a new film without altering the originals.
   * @param request - Ordered local clips, trims, transitions and optional captions.
   * @param signal - Cancels probing and encoding.
   * @returns Completed film reference in the local media library.
   */
  @Remote
  async assemble(request: ComfyFilmRequest, signal: AbortSignal): Promise<ComfyFilmResult> {
    const runtime = this.ctx.get('subprocess')
    if (runtime === undefined || this.config.ffmpegPath === null || this.config.outputDirectory === null) throw new Error('Film assembly requires a local subprocess provider, ffmpegPath and outputDirectory')
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(this.config.filmTimeoutMs)])
    return assembleFilm(runtime, this.config.ffmpegPath, this.config.outputDirectory, request, boundedSignal, {
      maxSeconds: this.config.maxFilmSeconds, crf: this.config.filmCrf, preset: this.config.filmEncoderPreset,
    })
  }

  /** Read completed and failed generations from ComfyUI history.
   * @param request - Maximum number of history entries.
   * @param signal - Cancellation signal for the Remote call.
   * @returns Recent completed and failed generations.
   */
  @Remote
  async history(request: ComfyHistoryRequest, signal: AbortSignal): Promise<readonly ComfyGeneration[]> {
    const limit = integer('limit', request.limit, 1, 100)
    const response = await this.request(`/history?max_items=${limit}`, {}, signal)
    if (!response.ok) throw new Error(`ComfyUI history returned HTTP ${response.status}`)
    const value: unknown = await response.json()
    const identities = this.historyWorkflowIdentities(await this.savedCatalog())
    signal.throwIfAborted()
    return generationsOf(value, identities).slice(0, limit)
  }

  /** Read an output image or video through the Host so browser CORS never reaches ComfyUI.
   * @param request - ComfyUI image reference.
   * @param signal - Cancellation signal for the Remote call.
   * @returns Media MIME type and base64 bytes, bounded to 50 MB.
   */
  @Remote
  async image(request: ComfyImageRequest, signal: AbortSignal): Promise<ComfyImageData> {
    if (!['input', 'output', 'temp'].includes(request.type)) throw new Error('Unsupported ComfyUI image type')
    const query = new URLSearchParams({ filename: request.filename, subfolder: request.subfolder, type: request.type })
    const response = await this.request(`/view?${query}`, {}, signal)
    if (!response.ok) throw new Error(`ComfyUI image returned HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > 50 * 1024 * 1024) throw new Error('ComfyUI image is larger than 50 MB')
    return { contentType: response.headers.get('content-type') ?? 'image/png', base64: bytes.toString('base64') }
  }

  /** Browse files retained on disk even when ComfyUI has pruned their history.
   * @param request - Page offset and size.
   * @param signal - Cancellation signal for the Remote call.
   * @returns Newest output files and total file count.
   */
  @Remote
  async library(request: ComfyLibraryRequest, signal: AbortSignal): Promise<ComfyLibraryPage> {
    const root = this.config.outputDirectory
    if (root === null) throw new Error('Configure outputDirectory to browse local ComfyUI images')
    const offset = integer('offset', request.offset, 0, Number.MAX_SAFE_INTEGER)
    const limit = integer('limit', request.limit, 1, 100)
    const images: ComfyStoredImage[] = []
    const directories = ['']
    for (let subfolder = directories.pop(); subfolder !== undefined; subfolder = directories.pop()) {
      signal.throwIfAborted()
      for (const entry of await readdir(join(root, subfolder), { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue
        const child = join(subfolder, entry.name)
        if (entry.isDirectory()) {
          directories.push(child)
        } else if (entry.isFile() && COMFY_MEDIA_EXTENSIONS.includes(extname(entry.name).toLowerCase())) {
          const info = await stat(join(root, child))
          images.push({ image: { filename: entry.name, subfolder, type: 'output' },
            modifiedAt: info.mtimeMs, bytes: info.size })
        }
      }
    }
    images.sort((left, right) => right.modifiedAt - left.modifiedAt)
    return { images: images.slice(offset, offset + limit), total: images.length }
  }

  /** Delete one local output file without deleting other images from its generation.
   * @param request - Output image under the configured directory.
   * @param signal - Cancellation signal for the Remote call.
   */
  @Remote
  async deleteImage(request: ComfyImageRequest, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const root = this.config.outputDirectory
    if (root === null) throw new Error('Configure outputDirectory to browse local ComfyUI images')
    const file = await localMedia(root, request)
    signal.throwIfAborted()
    await unlink(file.path)
  }

  /** Delete selected local images and videos, reporting each failure independently.
   * @param request - One to 100 local output references.
   * @param signal - Cancellation signal for the Remote call.
   * @returns References deleted and references that failed.
   */
  @Remote
  async deleteImages(request: ComfyDeleteImagesRequest, signal: AbortSignal): Promise<ComfyDeleteImagesResult> {
    if (request.images.length < 1 || request.images.length > COMFY_BATCH_LIMIT) throw new Error('Invalid media selection')
    const root = this.config.outputDirectory
    if (root === null) throw new Error('Configure outputDirectory to delete local ComfyUI files')
    const unique = new Map<string, ComfyImageReference>()
    for (const image of request.images) unique.set(`${image.subfolder}\0${image.filename}`, image)
    const deleted: ComfyImageReference[] = []
    const failed: { image: ComfyImageReference; message: string }[] = []
    for (const image of unique.values()) {
      signal.throwIfAborted()
      try {
        const file = await localMedia(root, image)
        await unlink(file.path)
        deleted.push(image)
      } catch (error) {
        failed.push({ image, message: messageOf(error) })
      }
    }
    return { deleted, failed }
  }

  /** Remove one completed generation from ComfyUI history.
   * @param request - Prompt identifier to remove.
   * @param signal - Cancellation signal for the Remote call.
   */
  @Remote
  async deleteGeneration(request: ComfyDeleteRequest, signal: AbortSignal): Promise<void> {
    const promptId = request.promptId.trim()
    if (promptId.length === 0 || promptId.length > 200) throw new Error('Invalid ComfyUI prompt id')
    const response = await this.request('/history', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delete: [promptId] }),
    }, signal)
    if (!response.ok) throw new Error(`ComfyUI history returned HTTP ${response.status}`)
  }

  /** Remove a queued prompt and interrupt the current execution when it is running.
   * @param request - Prompt identifier to cancel.
   * @param signal - Cancellation signal for the Remote call.
   */
  @Remote
  async cancel(request: ComfyCancelRequest, signal: AbortSignal): Promise<void> {
    const queue = await this.request('/queue', {}, signal)
    if (!queue.ok) throw new Error(`ComfyUI queue returned HTTP ${queue.status}`)
    const snapshot: unknown = await queue.json()
    const running = isRecord(snapshot) && Array.isArray(snapshot.queue_running)
      ? snapshot.queue_running.some(item => Array.isArray(item) && item[1] === request.promptId)
      : false
    const queued = await this.request('/queue', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delete: [request.promptId] }),
    }, signal)
    if (!queued.ok) throw new Error(`ComfyUI queue returned HTTP ${queued.status}`)
    if (running) {
      const interrupted = await this.request('/interrupt', { method: 'POST' }, signal)
      if (!interrupted.ok) throw new Error(`ComfyUI interrupt returned HTTP ${interrupted.status}`)
    }
  }
}

export default ComfyImagesController
