import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import type { ComfyFilmRequest, ComfyFilmResult } from './types.ts';
/** Assemble validated local clips with trims, cuts or fades, native audio and optional captions.
 * @param runtime - Local subprocess provider managing cancellation and child cleanup.
 * @param executable - Deployment FFmpeg executable.
 * @param root - Configured ComfyUI output folder.
 * @param request - Ordered clips and output settings.
 * @param signal - Cancels probing and assembly.
 * @param encoding - Deployment limits and H.264 quality settings.
 * @returns New film reference after the encoder has completed.
 */
export declare function assembleFilm(runtime: SubprocessRuntime, executable: string, root: string, request: ComfyFilmRequest, signal: AbortSignal, encoding: {
    maxSeconds: number;
    crf: number;
    preset: string;
}): Promise<ComfyFilmResult>;
//# sourceMappingURL=film.d.ts.map