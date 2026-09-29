import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { ComfyCancelRequest, ComfyDeleteRequest, ComfyGenerateReceipt, ComfyGenerateRequest, ComfyGeneration, ComfyHistoryRequest, ComfyImageData, ComfyImageRequest, ComfyImagesStatus } from './types.ts';
export type * from './types.ts';
interface Config {
    readonly baseUrl?: string;
    readonly outputPrefix?: string;
    readonly requestTimeoutMs?: number;
}
interface ResolvedConfig {
    readonly baseUrl: string;
    readonly outputPrefix: string;
    readonly requestTimeoutMs: number;
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
/** Build the standard-node text-to-image graph shared by the controller and its tests. */
export declare function basicTextToImageWorkflow(request: ComfyGenerateRequest, checkpoint: string, seed: number, prefix: string): Workflow;
/** Build the official standard-node Z-Image Turbo text-to-image graph. */
export declare function zImageTurboWorkflow(request: ComfyGenerateRequest, files: {
    readonly diffusionModel: string;
    readonly textEncoder: string;
    readonly vae: string;
}, seed: number, prefix: string): Workflow;
/** Convert one supported ComfyUI saved workflow into an API prompt graph. */
export declare function savedTextToImageWorkflow(saved: SavedWorkflow, request: ComfyGenerateRequest, seed: number, prefix: string): Workflow;
export declare function generationsOf(value: unknown, identities?: readonly HistoryWorkflowIdentity[]): ComfyGeneration[];
/** Remote controller used by the Images Cordis UI plugin. */
export declare class ComfyImagesController extends TypertRemoteService {
    static Config: z<Config, ResolvedConfig>;
    private readonly config;
    private savedCatalogCache;
    constructor(ctx: Context, config?: Config);
    private request;
    private nodeChoices;
    private models;
    private graphModelAvailable;
    private savedWorkflow;
    private savedCatalog;
    private historyWorkflowIdentities;
    private workflows;
    /** Probe ComfyUI and list locally installed model configurations Arya can run. */
    status(signal: AbortSignal): Promise<ComfyImagesStatus>;
    /** Queue one standard-node text-to-image workflow. */
    generate(request: ComfyGenerateRequest, signal: AbortSignal): Promise<ComfyGenerateReceipt>;
    /** Read completed and failed generations from ComfyUI history. */
    history(request: ComfyHistoryRequest, signal: AbortSignal): Promise<readonly ComfyGeneration[]>;
    /** Read one output image through the Host so browser CORS never reaches ComfyUI. */
    image(request: ComfyImageRequest, signal: AbortSignal): Promise<ComfyImageData>;
    /** Remove one completed generation from ComfyUI history. */
    deleteGeneration(request: ComfyDeleteRequest, signal: AbortSignal): Promise<void>;
    /** Remove a queued prompt and interrupt the current execution when it is running. */
    cancel(request: ComfyCancelRequest, signal: AbortSignal): Promise<void>;
}
export default ComfyImagesController;
//# sourceMappingURL=index.d.ts.map