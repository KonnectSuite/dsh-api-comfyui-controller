/** Health and model catalog reported by the configured ComfyUI host. */
export interface ComfyImagesStatus {
  readonly reachable: boolean
  readonly baseUrl: string
  readonly models: ComfyImageModel[]
  readonly workflows: ComfyImageWorkflow[]
  /** Whether the Host can browse ComfyUI's configured output directory. */
  readonly libraryAvailable: boolean
  readonly error: string | null
}

/** One built-in or saved ComfyUI workflow exposed in the Images composer. */
export interface ComfyImageWorkflow {
  /** A create graph may optionally accept an initial reference image. */
  readonly acceptsReference?: boolean | undefined
  /** Reference editing requires a source image; absent means a legacy create workflow. */
  readonly task?: 'create' | 'edit' | undefined
  /** What the graph writes: a still image, or a video assembled from frames. Read from
   * the graph's output node, so a video workflow is never presented as a still one. */
  readonly output: 'image' | 'video'
  readonly id: string
  readonly label: string
  readonly source: 'built-in' | 'saved'
  readonly available: boolean
  readonly unavailableReason: string | null
  readonly recommendedSteps: number
  readonly recommendedCfg: number
  readonly supportsNegativePrompt: boolean
  /** Whether the graph encodes a prompt at all. Absent means it does, so a post-processing
   * graph — upscaling, frame interpolation — is the only reason to set it false. */
  readonly takesPrompt?: boolean | undefined
  /** Installed model wired into this saved graph; null when unavailable. */
  readonly modelId: string | null
  /** Editable starting values taken from the saved graph. */
  readonly starterPrompt: string
  readonly width: number
  readonly height: number
  readonly batchSize: number
}

/** One locally installed model configuration Arya can run through ComfyUI. */
export interface ComfyImageModel {
  readonly id: string
  readonly label: string
  readonly kind: 'checkpoint' | 'z-image-turbo' | 'flux2-klein'
  readonly recommendedSteps: number
  readonly recommendedCfg: number
}

/** A basic text-to-image request. */
export interface ComfyGenerateRequest {
  /** Optional scene timing; rejected when the selected graph cannot apply it. */
  readonly videoSettings?: ComfyVideoSettings | undefined
  readonly prompt: string
  readonly negativePrompt: string
  readonly model: string | null
  readonly workflow: string | null
  readonly width: number
  readonly height: number
  readonly steps: number
  readonly cfg: number
  readonly seed: number | null
  readonly batchSize: number
  /** Existing ComfyUI image used as the initial latent, or null for text-to-image. */
  readonly sourceImage: ComfyImageReference | null
  /** Amount of change when sourceImage is set, from 0.05 to 1. */
  readonly denoise: number
}

/** Scene timing and ordered prompt segments for a Director render. */
export interface ComfyVideoSettings {
  readonly durationSeconds: number
  readonly frameRate: number
  /** Segment durations must total durationSeconds. No segments keeps the saved timeline. */
  readonly segments?: readonly { readonly seconds: number; readonly prompt: string }[] | undefined
}

/** Ordered output clips assembled into a new MP4; source files remain unchanged. */
export interface ComfyFilmRequest {
  readonly clips: readonly {
    readonly media: ComfyImageReference
    readonly startSeconds?: number | undefined
    readonly seconds?: number | undefined
    readonly caption?: string | undefined
  }[]
  readonly width: number
  readonly height: number
  readonly frameRate: number
  readonly fadeSeconds: number
}

/** A completed assembled film in the ordinary ComfyUI output library. */
export interface ComfyFilmResult {
  readonly media: ComfyImageReference
  readonly seconds: number
  readonly clips: number
}

/** The queued ComfyUI prompt. */
export interface ComfyGenerateReceipt {
  readonly promptId: string
  readonly seed: number
}

/** One image or video stored by ComfyUI. */
export interface ComfyImageReference {
  readonly filename: string
  readonly subfolder: string
  readonly type: string
}

/** One generation reconstructed from ComfyUI history. */
export interface ComfyGeneration {
  /** Source retained in ComfyUI metadata for continuing an edit. */
  readonly sourceImage?: ComfyImageReference | null
  /** Sampler change strength when the graph uses basic image-to-image sampling. */
  readonly denoise?: number
  readonly promptId: string
  readonly state: 'complete' | 'error'
  readonly workflow: string | null
  readonly workflowLabel: string
  readonly prompt: string
  readonly negativePrompt: string
  readonly model: string
  readonly modelLabel: string
  readonly width: number
  readonly height: number
  readonly steps: number
  readonly cfg: number
  readonly seed: number
  /** Image and video references returned by recognized ComfyUI history graphs. */
  readonly images: ComfyImageReference[]
}

/** Bounds one history read. */
export interface ComfyHistoryRequest {
  readonly limit: number
}

/** Asks for one ComfyUI output image. */
export interface ComfyImageRequest extends ComfyImageReference {}

/** Image or video bytes encoded for the JSON Remote boundary. */
export interface ComfyImageData {
  readonly contentType: string
  readonly base64: string
}

/** Identifies a queued or running prompt. */
export interface ComfyCancelRequest {
  readonly promptId: string
}

/** Identifies one completed generation to remove from ComfyUI history. */
export interface ComfyDeleteRequest {
  readonly promptId: string
}

/** A page of media retained in ComfyUI's output directory, including old runs absent from history. */
export interface ComfyLibraryPage {
  readonly images: readonly ComfyStoredImage[]
  readonly total: number
}

/** One image or video on disk under the configured ComfyUI output directory. */
export interface ComfyStoredImage {
  readonly image: ComfyImageReference
  readonly modifiedAt: number
  readonly bytes: number
}

/** Offset pagination keeps large local libraries cheap to browse. */
export interface ComfyLibraryRequest {
  readonly offset: number
  readonly limit: number
}

/** Images and videos to delete in one Host operation. */
export interface ComfyDeleteImagesRequest {
  readonly images: readonly ComfyImageReference[]
}

/** Batch deletion reports successes and failures independently. */
export interface ComfyDeleteImagesResult {
  readonly deleted: readonly ComfyImageReference[]
  readonly failed: readonly { readonly image: ComfyImageReference; readonly message: string }[]
}

/** Outcome of one ComfyUI server lifecycle action, as the Images panel shows it. */
export interface ComfyServerControlResult {
  /** Whether ComfyUI answers on its HTTP endpoint after the action. */
  readonly running: boolean
  /** One line the panel shows verbatim: what happened, or why nothing did. */
  readonly detail: string
}

/** Authenticated browser-relative route for streaming one local image or video. */
export const COMFY_MEDIA_ROUTE = 'api/comfyui-media'

/** Authenticated browser-relative route for a ZIP of selected local files. */
export const COMFY_ARCHIVE_ROUTE = 'api/comfyui-archive'
