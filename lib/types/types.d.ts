/** Health and model catalog reported by the configured ComfyUI host. */
export interface ComfyImagesStatus {
    readonly reachable: boolean;
    readonly baseUrl: string;
    readonly models: ComfyImageModel[];
    readonly workflows: ComfyImageWorkflow[];
    /** Whether the Host can browse ComfyUI's configured output directory. */
    readonly libraryAvailable: boolean;
    readonly error: string | null;
}
/** One built-in or saved ComfyUI workflow exposed in the Images composer. */
export interface ComfyImageWorkflow {
    readonly id: string;
    readonly label: string;
    readonly source: 'built-in' | 'saved';
    readonly available: boolean;
    readonly unavailableReason: string | null;
    readonly recommendedSteps: number;
    readonly recommendedCfg: number;
    readonly supportsNegativePrompt: boolean;
    /** Installed model wired into this saved graph; null when unavailable. */
    readonly modelId: string | null;
    /** Editable starting values taken from the saved graph. */
    readonly starterPrompt: string;
    readonly width: number;
    readonly height: number;
    readonly batchSize: number;
}
/** One locally installed model configuration Arya can run through ComfyUI. */
export interface ComfyImageModel {
    readonly id: string;
    readonly label: string;
    readonly kind: 'checkpoint' | 'z-image-turbo';
    readonly recommendedSteps: number;
    readonly recommendedCfg: number;
}
/** A basic text-to-image request. */
export interface ComfyGenerateRequest {
    readonly prompt: string;
    readonly negativePrompt: string;
    readonly model: string | null;
    readonly workflow: string | null;
    readonly width: number;
    readonly height: number;
    readonly steps: number;
    readonly cfg: number;
    readonly seed: number | null;
    readonly batchSize: number;
    /** Existing ComfyUI image used as the initial latent, or null for text-to-image. */
    readonly sourceImage: ComfyImageReference | null;
    /** Amount of change when sourceImage is set, from 0.05 to 1. */
    readonly denoise: number;
}
/** The queued ComfyUI prompt. */
export interface ComfyGenerateReceipt {
    readonly promptId: string;
    readonly seed: number;
}
/** One image stored by ComfyUI. */
export interface ComfyImageReference {
    readonly filename: string;
    readonly subfolder: string;
    readonly type: string;
}
/** One generation reconstructed from ComfyUI history. */
export interface ComfyGeneration {
    readonly promptId: string;
    readonly state: 'complete' | 'error';
    readonly workflow: string | null;
    readonly workflowLabel: string;
    readonly prompt: string;
    readonly negativePrompt: string;
    readonly model: string;
    readonly modelLabel: string;
    readonly width: number;
    readonly height: number;
    readonly steps: number;
    readonly cfg: number;
    readonly seed: number;
    readonly images: ComfyImageReference[];
}
/** Bounds one history read. */
export interface ComfyHistoryRequest {
    readonly limit: number;
}
/** Asks for one ComfyUI output image. */
export interface ComfyImageRequest extends ComfyImageReference {
}
/** Image bytes encoded for the JSON Remote boundary. */
export interface ComfyImageData {
    readonly contentType: string;
    readonly base64: string;
}
/** Identifies a queued or running prompt. */
export interface ComfyCancelRequest {
    readonly promptId: string;
}
/** Identifies one completed generation to remove from ComfyUI history. */
export interface ComfyDeleteRequest {
    readonly promptId: string;
}
/** A page of images retained in ComfyUI's output directory, including old runs absent from history. */
export interface ComfyLibraryPage {
    readonly images: readonly ComfyStoredImage[];
    readonly total: number;
}
/** One image on disk under the configured ComfyUI output directory. */
export interface ComfyStoredImage {
    readonly image: ComfyImageReference;
    readonly modifiedAt: number;
    readonly bytes: number;
}
/** Offset pagination keeps large local libraries cheap to browse. */
export interface ComfyLibraryRequest {
    readonly offset: number;
    readonly limit: number;
}
//# sourceMappingURL=types.d.ts.map