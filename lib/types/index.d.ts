import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { ComfyCancelRequest, ComfyDeleteRequest, ComfyDeleteImagesRequest, ComfyDeleteImagesResult, ComfyGenerateReceipt, ComfyGenerateRequest, ComfyGeneration, ComfyHistoryRequest, ComfyImageData, ComfyImageModel, ComfyImageRequest, ComfyImagesStatus, ComfyLibraryPage, ComfyLibraryRequest, ComfyServerControlResult, ComfyFilmRequest, ComfyFilmResult } from './types.ts';
export type * from './types.ts';
interface Config {
    /** Local ComfyUI HTTP endpoint. */
    readonly baseUrl?: string;
    /** Prefix for generated output filenames. */
    readonly outputPrefix?: string;
    /** Deadline for ComfyUI HTTP requests. */
    readonly requestTimeoutMs?: number;
    /** Local ComfyUI output folder used for library browsing and file deletion. */
    readonly outputDirectory?: string;
    /**
     * Interpreter that runs ComfyUI, so the panel can start the server itself.
     * Empty leaves start unavailable and only the HTTP controls usable.
     */
    readonly serverPythonPath?: string;
    /** Checkout holding `main.py`; the working directory a start runs in. */
    readonly serverDirectory?: string;
    /** How long a start may take before the panel reports it as not running. */
    readonly serverStartTimeoutMs?: number;
    /** Maximum duration of one generated scene; longer films use ordered scenes. */
    readonly maxVideoSeconds?: number;
    /** Local FFmpeg executable; empty disables film assembly. */
    readonly ffmpegPath?: string;
    /** Maximum time allowed for one CPU film assembly. */
    readonly filmTimeoutMs?: number;
    /** Maximum assembled film duration. */
    readonly maxFilmSeconds?: number;
    /** H.264 quality factor; lower values retain more detail. */
    readonly filmCrf?: number;
    /** FFmpeg H.264 speed preset. */
    readonly filmEncoderPreset?: 'ultrafast' | 'fast' | 'medium' | 'slow';
}
interface ResolvedConfig {
    readonly baseUrl: string;
    readonly outputPrefix: string;
    readonly requestTimeoutMs: number;
    readonly outputDirectory: string | null;
    readonly serverPythonPath: string | null;
    readonly serverDirectory: string | null;
    readonly serverStartTimeoutMs: number;
    readonly maxVideoSeconds: number;
    readonly ffmpegPath: string | null;
    readonly filmTimeoutMs: number;
    readonly maxFilmSeconds: number;
    readonly filmCrf: number;
    readonly filmEncoderPreset: string;
}
interface WorkflowNode {
    readonly class_type: string;
    readonly inputs: Record<string, unknown>;
}
/** A validated ComfyUI API graph keyed by node identity. */
export type Workflow = Record<string, WorkflowNode>;
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
type CatalogModel = ComfyImageModel & {
    readonly kind: 'checkpoint';
    readonly checkpoint: string;
} | ComfyImageModel & {
    readonly kind: 'z-image-turbo' | 'flux2-klein';
    readonly diffusionModel: string;
    readonly textEncoder: string;
    readonly vae: string;
};
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
export declare function resolveSwitches(nodes: readonly SavedWorkflowNode[], links: readonly (readonly unknown[])[]): {
    nodes: SavedWorkflowNode[];
    links: readonly (readonly unknown[])[];
};
/**
 * Read one ComfyUI saved-workflow document into the graph the converter consumes.
 *
 * Subgraph instances are expanded here, so a document that stores part of its graph in
 * `definitions.subgraphs` converts to the same flat nodes and links a hand-built one does.
 * @param value - Untrusted workflow document, as ComfyUI serves it from `/userdata`.
 * @returns the parsed graph, or undefined when the document is not a workflow.
 */
export declare function savedWorkflowOf(value: unknown): SavedWorkflow | undefined;
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
export declare function savedSamplerSettings(nodes: readonly SavedWorkflowNode[]): {
    steps: number;
    cfg: number;
};
/**
 * Convert one supported ComfyUI saved workflow into an API prompt graph.
 * @param saved - Saved workflow graph.
 * @param request - Validated generation settings.
 * @param seed - Resolved sampler seed.
 * @param prefix - Output image filename prefix.
 * @returns ComfyUI prompt graph.
 */
export declare function savedTextToImageWorkflow(saved: SavedWorkflow, request: ComfyGenerateRequest, seed: number, prefix: string): Workflow;
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
export declare function injectSourceImage(graph: Workflow, filename: string): boolean;
/** Replace an empty latent in-place with an image encoded through the graph's VAE.
 * @param graph - Saved or built-in text-to-image graph to modify.
 * @param filename - ComfyUI annotated image path, including its directory type.
 * @param denoise - Sampler change strength from 0.05 to 1.
 * @returns The same graph with its sampler connected to the encoded image.
 */
export declare function imageToImageWorkflow(graph: Workflow, filename: string, denoise: number): Workflow;
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
export declare function savedWorkflowTakesPrompt(nodes: readonly {
    readonly type: string;
    readonly mode?: number | undefined;
}[]): false | undefined;
/**
 * Read whether a saved graph needs a source image, from an active image loader.
 *
 * A caller that cannot supply one — the generation tool, or a first request in the panel — needs
 * this to tell a create workflow from one that would run against whatever file the graph names.
 * A bypassed loader does not count, because that graph runs on its own.
 * @param nodes - The saved graph's nodes.
 * @returns `edit` when a source image is required, otherwise `undefined`.
 */
export declare function savedWorkflowTask(nodes: readonly {
    readonly type: string;
    readonly mode?: number | undefined;
}[]): 'edit' | undefined;
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
export declare function absentCheckpoint(graph: Workflow, models: readonly CatalogModel[]): boolean;
/**
 * Read whether a saved graph writes a still or a video, from the node that writes it.
 *
 * The writer node decides, not the model or the graph's title, so a video workflow is never
 * presented as a still one.
 * @param nodes - The saved graph's nodes.
 * @returns `video` when the graph writes one, otherwise `image`.
 */
export declare function savedWorkflowOutput(nodes: readonly {
    readonly type: string;
}[]): 'image' | 'video';
/** Reconstruct generations from ComfyUI history entries.
 * @param value - Untrusted ComfyUI history JSON.
 * @param identities - Saved workflow identities available at read time.
 * @returns Generations with image references and resolved workflow labels.
 */ export declare function generationsOf(value: unknown, identities?: readonly HistoryWorkflowIdentity[]): ComfyGeneration[];
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
    /**
     * ComfyUI's own processes on this machine, matched by the command line that
     * runs `main.py` on the configured port.
     *
     * Identity comes from the command line rather than from the listening port,
     * because this machine's Tailscale daemon also listens on the ComfyUI port
     * to forward it onto the tailnet. A port match would kill the tunnel.
     * @returns the matching process ids; empty when none run.
     */
    private comfyServerPids;
    /**
     * Whether ComfyUI answers on its HTTP endpoint.
     * @param signal - caller cancellation for the probe.
     * @returns true when `/system_stats` answers.
     */
    private serverAnswers;
    /**
     * Validate the configured start paths.
     * @returns the interpreter and working directory, or why they are unusable.
     */
    private serverPaths;
    /**
     * Start ComfyUI, detached from this process so it outlives the application.
     * @param signal - caller cancellation for the readiness probe.
     * @returns whether it answered, and what happened.
     */
    startServer(signal: AbortSignal): Promise<ComfyServerControlResult>;
    /**
     * Stop ComfyUI.
     * @param signal - caller cancellation for the final state probe.
     * @returns whether it still answers, and what happened.
     */
    stopServer(signal: AbortSignal): Promise<ComfyServerControlResult>;
    /**
     * Restart ComfyUI: stop, then start again.
     * @param signal - caller cancellation for the readiness probe.
     * @returns whether it answered, and what happened.
     */
    restartServer(signal: AbortSignal): Promise<ComfyServerControlResult>;
    /** Submit a validated catalog workflow to the configured ComfyUI server.
     * @param request - Prompt, workflow, model, and generation settings.
     * @param signal - Cancels discovery and submission requests.
     * @returns The submitted prompt identifier and resolved seed.
     */
    generate(request: ComfyGenerateRequest, signal: AbortSignal): Promise<ComfyGenerateReceipt>;
    /** Assemble retained output clips into a new film without altering the originals.
     * @param request - Ordered local clips, trims, transitions and optional captions.
     * @param signal - Cancels probing and encoding.
     * @returns Completed film reference in the local media library.
     */
    assemble(request: ComfyFilmRequest, signal: AbortSignal): Promise<ComfyFilmResult>;
    /** Read completed and failed generations from ComfyUI history.
     * @param request - Maximum number of history entries.
     * @param signal - Cancellation signal for the Remote call.
     * @returns Recent completed and failed generations.
     */
    history(request: ComfyHistoryRequest, signal: AbortSignal): Promise<readonly ComfyGeneration[]>;
    /** Read an output image or video through the Host so browser CORS never reaches ComfyUI.
     * @param request - ComfyUI image reference.
     * @param signal - Cancellation signal for the Remote call.
     * @returns Media MIME type and base64 bytes, bounded to 50 MB.
     */
    image(request: ComfyImageRequest, signal: AbortSignal): Promise<ComfyImageData>;
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
    /** Delete selected local images and videos, reporting each failure independently.
     * @param request - One to 100 local output references.
     * @param signal - Cancellation signal for the Remote call.
     * @returns References deleted and references that failed.
     */
    deleteImages(request: ComfyDeleteImagesRequest, signal: AbortSignal): Promise<ComfyDeleteImagesResult>;
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