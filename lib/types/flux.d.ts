/** Flux reference-image editing with the installed split-model files. */
import type { Workflow } from './index.ts';
import type { ComfyGenerateRequest } from './types.ts';
/** Build reference conditioning for both Flux guider inputs.
 * @param request - Validated prompt and sampler settings.
 * @param files - Installed diffusion, text encoder and VAE filenames.
 * @param filename - Annotated ComfyUI source image path.
 * @param seed - Resolved noise seed.
 * @param prefix - Output filename prefix.
 * @returns ComfyUI API graph preserving the source image aspect ratio.
 */
export declare function fluxReferenceWorkflow(request: ComfyGenerateRequest, files: {
    diffusionModel: string;
    textEncoder: string;
    vae: string;
}, filename: string, seed: number, prefix: string): Workflow;
//# sourceMappingURL=flux.d.ts.map