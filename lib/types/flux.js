/** Build reference conditioning for both Flux guider inputs.
 * @param request - Validated prompt and sampler settings.
 * @param files - Installed diffusion, text encoder and VAE filenames.
 * @param filename - Annotated ComfyUI source image path.
 * @param seed - Resolved noise seed.
 * @param prefix - Output filename prefix.
 * @returns ComfyUI API graph preserving the source image aspect ratio.
 */
export function fluxReferenceWorkflow(request, files, filename, seed, prefix) {
    return {
        '1': { class_type: 'UNETLoader', inputs: { unet_name: files.diffusionModel, weight_dtype: 'default' } },
        '2': { class_type: 'CLIPLoader', inputs: { clip_name: files.textEncoder, type: 'flux2', device: 'default' } },
        '3': { class_type: 'VAELoader', inputs: { vae_name: files.vae } },
        '4': { class_type: 'LoadImage', inputs: { image: filename } },
        '5': { class_type: 'ImageScaleToTotalPixels', inputs: { image: ['4', 0], upscale_method: 'nearest-exact', megapixels: request.width * request.height / 1_000_000, resolution_steps: 1 } },
        '6': { class_type: 'GetImageSize', inputs: { image: ['5', 0] } },
        '7': { class_type: 'VAEEncode', inputs: { pixels: ['5', 0], vae: ['3', 0] } },
        '8': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: request.prompt } },
        '9': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['8', 0] } },
        '10': { class_type: 'ReferenceLatent', inputs: { conditioning: ['8', 0], latent: ['7', 0] } },
        '11': { class_type: 'ReferenceLatent', inputs: { conditioning: ['9', 0], latent: ['7', 0] } },
        '12': { class_type: 'EmptyFlux2LatentImage', inputs: { width: ['6', 0], height: ['6', 1], batch_size: 1 } },
        '13': { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
        '14': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
        '15': { class_type: 'Flux2Scheduler', inputs: { steps: request.steps, width: ['6', 0], height: ['6', 1] } },
        '16': { class_type: 'CFGGuider', inputs: { model: ['1', 0], positive: ['10', 0], negative: ['11', 0], cfg: request.cfg } },
        '17': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['13', 0], guider: ['16', 0], sampler: ['14', 0], sigmas: ['15', 0], latent_image: ['12', 0] } },
        '18': { class_type: 'VAEDecode', inputs: { samples: ['17', 0], vae: ['3', 0] } },
        '19': { class_type: 'SaveImage', inputs: { images: ['18', 0], filename_prefix: prefix } },
    };
}
//# sourceMappingURL=flux.js.map