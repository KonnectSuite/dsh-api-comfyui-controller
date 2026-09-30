import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { ComfyCancelRequest, ComfyDeleteRequest, ComfyGenerateReceipt, ComfyGenerateRequest, ComfyGeneration, ComfyHistoryRequest, ComfyImageData, ComfyImageRequest, ComfyImagesStatus, ComfyLibraryPage, ComfyLibraryRequest } from './types.ts';
export type * from './types.ts';
interface Config {
    readonly baseUrl?: string;
    readonly outputPrefix?: string;
    readonly requestTimeoutMs?: number;
    readonly outputDirectory?: string;
}
interface ResolvedConfig {
    readonly baseUrl: string;
    readonly outputPrefix: string;
    readonly requestTimeoutMs: number;
    readonly outputDirectory: string | null;
}
interface WorkflowNode {
    readonly class_type: string;
    readonly inputs: Record<string, unknown>;
}
type Workflow = Record<string, WorkflowNode>;
interface SavedWorkflowNode {
    readonly id: number;
    readonly type: string;
    readonly mode: number;
    readonly inputs: readonly {
        readonly name: string;
        readonly link: number | null;
    }[];
    readonly widgetsValues: readonly unknown[];
}
interface SavedWorkflow {
    readonly nodes: readonly SavedWorkflowNode[];
    readonly links: readonly (readonly unknown[])[];
}
/** Saved workflow identity used when reconstructing ComfyUI history. */
export interface HistoryWorkflowIdentity {
    readonly id: string;
    readonly label: string;
    readonly outputPrefixes: readonly string[];
    readonly fingerprint?: string;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Host owner of the `comfyImages` Remote namespace. */
        comfyImagesController: ComfyImagesController;
    }
}
/** Build the standard-node text-to-image graph shared by the controller and its tests.
 * @param request - Validated generation settings.
 * @param checkpoint - Installed checkpoint filename.
 * @param seed - Resolved sampler seed.
 * @param prefix - Output image filename prefix.
 * @returns ComfyUI prompt graph.
 */
export declare function basicTextToImageWorkflow(request: ComfyGenerateRequest, checkpoint: string, seed: number, prefix: string): Workflow;
/** Build the official standard-node Z-Image Turbo text-to-image graph.
 * @param request - Validated generation settings.
 * @param files - Installed model, encoder, and VAE filenames.
 * @param seed - Resolved sampler seed.
 * @param prefix - Output image filename prefix.
 * @returns ComfyUI prompt graph.
 */
export declare function zImageTurboWorkflow(request: ComfyGenerateRequest, files: {
    readonly diffusionModel: string;
    readonly textEncoder: string;
    readonly vae: string;
}, seed: number, prefix: string): Workflow;
/** Convert one supported ComfyUI saved workflow into an API prompt graph.
 * @param saved - Saved workflow graph.
 * @param request - Validated generation settings.
 * @param seed - Resolved sampler seed.
 * @param prefix - Output image filename prefix.
 * @returns ComfyUI prompt graph.
 */
export declare function savedTextToImageWorkflow(saved: SavedWorkflow, request: ComfyGenerateRequest, seed: number, prefix: string): Workflow;
/** Replace an empty latent in-place with an image encoded through the graph's VAE.
 * @param graph - Saved or built-in text-to-image graph to modify.
 * @param filename - ComfyUI annotated image path, including its directory type.
 * @param denoise - Sampler change strength from 0.05 to 1.
 * @returns The same graph with its sampler connected to the encoded image.
 */
export declare function imageToImageWorkflow(graph: Workflow, filename: string, denoise: number): Workflow;
/** Reconstruct generations from ComfyUI history entries.
 * @param value - Untrusted ComfyUI history JSON.
 * @param identities - Saved workflow identities available at read time.
 * @returns Generations with image references and resolved workflow labels.
 */
export declare function generationsOf(value: unknown, identities?: readonly HistoryWorkflowIdentity[]): ComfyGeneration[];
/** Remote controller used by the Images Cordis UI plugin. */
export declare class ComfyImagesController extends TypertRemoteService {
    static Config: z<Config, ResolvedConfig>;
    private readonly config;
    private savedCatalogCache;
    constructor(ctx: Context, config?: Config);
    private request;
    private annotatedSourceImage;
    private nodeChoices;
    private models;
    private graphModel;
    private savedWorkflow;
    private savedCatalog;
    private historyWorkflowIdentities;
    private workflows;
    /** Probe ComfyUI and list locally installed model configurations Arya can run.
     * @param signal - Cancellation signal for the Remote call.
     * @returns Connection state, models, and saved workflows.
     */
    status(signal: AbortSignal): Promise<ComfyImagesStatus>;
    /** Queue one supported ComfyUI workflow.
     * @param request - Generation settings and optional source image.
     * @param signal - Cancellation signal for the Remote call.
     * @returns Queued prompt identifier and resolved seed.
     */
    generate(request: ComfyGenerateRequest, signal: AbortSignal): Promise<ComfyGenerateReceipt>;
    /** Read completed and failed generations from ComfyUI history.
     * @param request - Maximum number of history entries.
     * @param signal - Cancellation signal for the Remote call.
     * @returns Recent completed and failed generations.
     */
    history(request: ComfyHistoryRequest, signal: AbortSignal): Promise<readonly ComfyGeneration[]>;
    /** Read one output image through the Host so browser CORS never reaches ComfyUI.
     * @param request - ComfyUI image reference.
     * @param signal - Cancellation signal for the Remote call.
     * @returns Image MIME type and base64 bytes.
     */
    image(request: ComfyImageRequest, signal: AbortSignal): Promise<ComfyImageData>;
    private outputPath;
    /** Browse files retained on disk even when ComfyUI has pruned their history.
     * @param request - Page offset and size.
     * @param signal - Cancellation signal for the Remote call.
     * @returns Newest output files and total file count.
     */
    library(request: ComfyLibraryRequest, signal: AbortSignal): Promise<ComfyLibraryPage>;
    /** Delete one local output file without deleting other images from its generation.
     * @param request - Output image under the configured directory.
     * @param signal - Cancellation signal for the Remote call.
     */
    deleteImage(request: ComfyImageRequest, signal: AbortSignal): Promise<void>;
    /** Remove one completed generation from ComfyUI history.
     * @param request - Prompt identifier to remove.
     * @param signal - Cancellation signal for the Remote call.
     */
    deleteGeneration(request: ComfyDeleteRequest, signal: AbortSignal): Promise<void>;
    /** Remove a queued prompt and interrupt the current execution when it is running.
     * @param request - Prompt identifier to cancel.
     * @param signal - Cancellation signal for the Remote call.
     */
    cancel(request: ComfyCancelRequest, signal: AbortSignal): Promise<void>;
}
export default ComfyImagesController;
//# sourceMappingURL=index.d.ts.map