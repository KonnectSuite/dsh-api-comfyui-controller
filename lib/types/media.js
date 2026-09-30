/** Authenticated, streamed access to ComfyUI's local image and video outputs. */
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { Zip, ZipPassThrough } from 'fflate';
import { COMFY_ARCHIVE_ROUTE, COMFY_MEDIA_ROUTE } from "./types.js";
const MEDIA_TYPES = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm',
    '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
};
/** Extensions this library can display or download. */
export const COMFY_MEDIA_EXTENSIONS = Object.freeze(Object.keys(MEDIA_TYPES));
/** Maximum selected files accepted by the ZIP and batch-delete operations. */
export const COMFY_BATCH_LIMIT = 100;
function inside(root, path) {
    const suffix = relative(root, path);
    return suffix !== '' && suffix !== '..' && !suffix.startsWith('..\\') && !suffix.startsWith('../') && !isAbsolute(suffix);
}
/** Resolve an untrusted media reference beneath the configured output folder.
 * @param root - Configured ComfyUI output folder.
 * @param image - Reference supplied by a browser request.
 * @returns Regular-file path and metadata suitable for streaming.
 */
export async function localMedia(root, image) {
    if (image.type !== 'output' || image.filename !== basename(image.filename) || image.filename === '..') {
        throw new Error('Invalid output file');
    }
    const type = MEDIA_TYPES[extname(image.filename).toLowerCase()];
    if (type === undefined)
        throw new Error('Unsupported media type');
    const path = resolve(root, image.subfolder, image.filename);
    if (!inside(root, path))
        throw new Error('File is outside the output directory');
    const [actualRoot, actualPath, info] = await Promise.all([realpath(root), realpath(path), lstat(path)]);
    if (!inside(actualRoot, actualPath) || !info.isFile())
        throw new Error('File is outside the output directory');
    return { path, name: relative(root, path).replaceAll('\\', '/'), size: info.size, type };
}
function imageFromQuery(url) {
    return {
        filename: url.searchParams.get('filename') ?? '',
        subfolder: url.searchParams.get('subfolder') ?? '',
        type: 'output',
    };
}
function rangeOf(value, size) {
    if (value === null)
        return null;
    const match = /^bytes=(\d+)-(\d*)$/u.exec(value);
    if (match === null)
        throw new Error('Invalid media range');
    const start = Number(match[1]);
    const end = match[2] === '' ? size - 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= size) {
        throw new Error('Invalid media range');
    }
    return { start, end };
}
/** Stream one selected image or video with byte ranges for video seeking.
 * @param root - Configured ComfyUI output folder.
 * @param request - Authenticated HTTP request.
 * @returns A bounded-range media response or a client error.
 */
export async function comfyMediaResponse(root, request) {
    try {
        const file = await localMedia(root, imageFromQuery(new URL(request.url)));
        const range = rangeOf(request.headers.get('range'), file.size);
        const start = range?.start ?? 0;
        const end = range?.end ?? file.size - 1;
        const headers = new Headers({
            'content-type': file.type,
            'content-length': String(end - start + 1),
            'accept-ranges': 'bytes',
            'cache-control': 'private, no-store',
            'x-content-type-options': 'nosniff',
        });
        if (range !== null)
            headers.set('content-range', `bytes ${start}-${end}/${file.size}`);
        if (request.method === 'HEAD')
            return new Response(null, { status: range === null ? 200 : 206, headers });
        const stream = createReadStream(file.path, { start, end, signal: request.signal });
        return new Response(Readable.toWeb(stream), {
            status: range === null ? 200 : 206, headers,
        });
    }
    catch (error) {
        return new Response(error instanceof Error ? error.message : 'Unable to read media', { status: 400 });
    }
}
function archiveImages(url) {
    const raw = url.searchParams.get('files');
    if (raw === null)
        throw new Error('Choose files to download');
    const value = JSON.parse(raw);
    if (!Array.isArray(value) || value.length < 1 || value.length > COMFY_BATCH_LIMIT) {
        throw new Error(`Choose 1–${COMFY_BATCH_LIMIT} files`);
    }
    const images = [];
    for (const item of value) {
        if (typeof item !== 'object' || item === null || Array.isArray(item))
            throw new Error('Invalid output file');
        const fields = item;
        if (typeof fields.filename !== 'string' || typeof fields.subfolder !== 'string' || fields.type !== 'output') {
            throw new Error('Invalid output file');
        }
        images.push({ filename: fields.filename, subfolder: fields.subfolder, type: 'output' });
    }
    return images;
}
function streamArchive(files, signal) {
    const consumerAbort = new AbortController();
    const combined = AbortSignal.any([signal, consumerAbort.signal]);
    let zip;
    let resume;
    let terminated = false;
    const stop = () => { if (!terminated) {
        terminated = true;
        zip?.terminate();
    } };
    return new ReadableStream({
        start(controller) {
            const archive = new Zip((error, data, final) => {
                if (error) {
                    controller.error(error);
                    return;
                }
                if (data.byteLength > 0)
                    controller.enqueue(data);
                if (final)
                    controller.close();
            });
            zip = archive;
            void (async () => {
                try {
                    for (const file of files) {
                        combined.throwIfAborted();
                        const entry = new ZipPassThrough(file.name);
                        archive.add(entry);
                        for await (const chunk of createReadStream(file.path, { highWaterMark: 64 * 1024, signal: combined })) {
                            combined.throwIfAborted();
                            entry.push(chunk, false);
                            if (controller.desiredSize !== null && controller.desiredSize <= 0) {
                                await new Promise(resolveWait => {
                                    const release = () => {
                                        resume = undefined;
                                        combined.removeEventListener('abort', release);
                                        resolveWait();
                                    };
                                    resume = release;
                                    combined.addEventListener('abort', release, { once: true });
                                });
                                combined.throwIfAborted();
                            }
                        }
                        entry.push(new Uint8Array(), true);
                    }
                    archive.end();
                }
                catch (error) {
                    stop();
                    controller.error(error instanceof Error ? error : new Error('Media archive failed'));
                }
            })();
        },
        pull() { resume?.(); resume = undefined; },
        cancel(reason) {
            consumerAbort.abort(reason instanceof Error ? reason : new Error('Media archive cancelled'));
            resume?.();
            resume = undefined;
            stop();
        },
    }, { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength });
}
/** Stream one ZIP containing selected images and videos, preserving subfolders.
 * @param root - Configured ComfyUI output folder.
 * @param request - Authenticated GET or HEAD request with selected references.
 * @returns Download response after every entry has been validated.
 */
export async function comfyArchiveResponse(root, request) {
    try {
        const images = archiveImages(new URL(request.url));
        const files = await Promise.all(images.map(image => localMedia(root, image)));
        if (new Set(files.map(file => file.name)).size !== files.length)
            throw new Error('Duplicate output file');
        const headers = {
            'content-type': 'application/zip',
            'content-disposition': 'attachment; filename="aryaai-media.zip"',
            'cache-control': 'private, no-store',
            'x-content-type-options': 'nosniff',
        };
        if (request.method === 'HEAD')
            return new Response(null, { headers });
        return new Response(streamArchive(files, request.signal), { headers });
    }
    catch (error) {
        return new Response(error instanceof Error ? error.message : 'Unable to export media', { status: 400 });
    }
}
/** Absolute authenticated routes registered by the Host service. */
export const COMFY_MEDIA_PATH = `/${COMFY_MEDIA_ROUTE}`;
/** Absolute authenticated route for ZIP downloads. */
export const COMFY_ARCHIVE_PATH = `/${COMFY_ARCHIVE_ROUTE}`;
//# sourceMappingURL=media.js.map