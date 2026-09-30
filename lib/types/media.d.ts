import { type ComfyImageReference } from './types.ts';
/** Extensions this library can display or download. */
export declare const COMFY_MEDIA_EXTENSIONS: readonly string[];
/** Maximum selected files accepted by the ZIP and batch-delete operations. */
export declare const COMFY_BATCH_LIMIT = 100;
interface LocalMedia {
    readonly path: string;
    readonly name: string;
    readonly size: number;
    readonly type: string;
}
/** Resolve an untrusted media reference beneath the configured output folder.
 * @param root - Configured ComfyUI output folder.
 * @param image - Reference supplied by a browser request.
 * @returns Regular-file path and metadata suitable for streaming.
 */
export declare function localMedia(root: string, image: ComfyImageReference): Promise<LocalMedia>;
/** Stream one selected image or video with byte ranges for video seeking.
 * @param root - Configured ComfyUI output folder.
 * @param request - Authenticated HTTP request.
 * @returns A bounded-range media response or a client error.
 */
export declare function comfyMediaResponse(root: string, request: Request): Promise<Response>;
/** Stream one ZIP containing selected images and videos, preserving subfolders.
 * @param root - Configured ComfyUI output folder.
 * @param request - Authenticated GET or HEAD request with selected references.
 * @returns Download response after every entry has been validated.
 */
export declare function comfyArchiveResponse(root: string, request: Request): Promise<Response>;
/** Absolute authenticated routes registered by the Host service. */
export declare const COMFY_MEDIA_PATH = "/api/comfyui-media";
/** Absolute authenticated route for ZIP downloads. */
export declare const COMFY_ARCHIVE_PATH = "/api/comfyui-archive";
export {};
//# sourceMappingURL=media.d.ts.map