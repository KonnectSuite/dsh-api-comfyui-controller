import { lstat, mkdtemp, readdir, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { randomInt, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { Zip, ZipPassThrough } from "fflate";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import z from "@deepseek-ai/schemastery";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
//#region lib/types/flux.js
/** Build reference conditioning for both Flux guider inputs.
* @param request - Validated prompt and sampler settings.
* @param files - Installed diffusion, text encoder and VAE filenames.
* @param filename - Annotated ComfyUI source image path.
* @param seed - Resolved noise seed.
* @param prefix - Output filename prefix.
* @returns ComfyUI API graph preserving the source image aspect ratio.
*/
function fluxReferenceWorkflow(request, files, filename, seed, prefix) {
	return {
		"1": {
			class_type: "UNETLoader",
			inputs: {
				unet_name: files.diffusionModel,
				weight_dtype: "default"
			}
		},
		"2": {
			class_type: "CLIPLoader",
			inputs: {
				clip_name: files.textEncoder,
				type: "flux2",
				device: "default"
			}
		},
		"3": {
			class_type: "VAELoader",
			inputs: { vae_name: files.vae }
		},
		"4": {
			class_type: "LoadImage",
			inputs: { image: filename }
		},
		"5": {
			class_type: "ImageScaleToTotalPixels",
			inputs: {
				image: ["4", 0],
				upscale_method: "nearest-exact",
				megapixels: request.width * request.height / 1e6,
				resolution_steps: 1
			}
		},
		"6": {
			class_type: "GetImageSize",
			inputs: { image: ["5", 0] }
		},
		"7": {
			class_type: "VAEEncode",
			inputs: {
				pixels: ["5", 0],
				vae: ["3", 0]
			}
		},
		"8": {
			class_type: "CLIPTextEncode",
			inputs: {
				clip: ["2", 0],
				text: request.prompt
			}
		},
		"9": {
			class_type: "ConditioningZeroOut",
			inputs: { conditioning: ["8", 0] }
		},
		"10": {
			class_type: "ReferenceLatent",
			inputs: {
				conditioning: ["8", 0],
				latent: ["7", 0]
			}
		},
		"11": {
			class_type: "ReferenceLatent",
			inputs: {
				conditioning: ["9", 0],
				latent: ["7", 0]
			}
		},
		"12": {
			class_type: "EmptyFlux2LatentImage",
			inputs: {
				width: ["6", 0],
				height: ["6", 1],
				batch_size: 1
			}
		},
		"13": {
			class_type: "RandomNoise",
			inputs: { noise_seed: seed }
		},
		"14": {
			class_type: "KSamplerSelect",
			inputs: { sampler_name: "euler" }
		},
		"15": {
			class_type: "Flux2Scheduler",
			inputs: {
				steps: request.steps,
				width: ["6", 0],
				height: ["6", 1]
			}
		},
		"16": {
			class_type: "CFGGuider",
			inputs: {
				model: ["1", 0],
				positive: ["10", 0],
				negative: ["11", 0],
				cfg: request.cfg
			}
		},
		"17": {
			class_type: "SamplerCustomAdvanced",
			inputs: {
				noise: ["13", 0],
				guider: ["16", 0],
				sampler: ["14", 0],
				sigmas: ["15", 0],
				latent_image: ["12", 0]
			}
		},
		"18": {
			class_type: "VAEDecode",
			inputs: {
				samples: ["17", 0],
				vae: ["3", 0]
			}
		},
		"19": {
			class_type: "SaveImage",
			inputs: {
				images: ["18", 0],
				filename_prefix: prefix
			}
		}
	};
}
//#endregion
//#region lib/types/subgraph.js
/**
* Flatten ComfyUI subgraph instances into the nodes and links they contain.
*
* A frontend workflow may hold a node whose `type` is a subgraph UUID instead of a class
* name, with the real graph in the document's `definitions.subgraphs`. Nothing that reads
* a saved workflow by class name can use such a file, which is why a workflow that runs
* perfectly well in ComfyUI can be unusable elsewhere.
*
* The definition states the mapping it needs: each promoted slot carries the ids of the
* interior links it stands for, and the instance's slots are matched to those by name. A
* slot the instance supplies a value for sets the interior primitive that feeds it; a slot
* the instance receives a link for is wired to the outside source instead.
*
* Every field is required. The document parser validates the file and fills these before
* calling, so a missing field here is a defect in that parser, not a case to absorb.
*/
/** Slot types that hold a value on the node rather than a connection. */
const VALUE_TYPES = new Set([
	"INT",
	"FLOAT",
	"STRING",
	"BOOLEAN",
	"COMBO"
]);
/** Whether a slot type carries a widget value. */
function isValueType(type) {
	return VALUE_TYPES.has(type.toUpperCase());
}
/**
* Expand every subgraph instance into its definition's nodes and links.
*
* An instance whose definition declares no nodes is reported unresolved and left in place,
* so a caller names the class it cannot expand rather than silently dropping part of a
* graph. A link into an instance is consumed by the expansion; a link out of one is
* re-pointed at the interior node that produces it.
* @param nodes - Outer document nodes, in document order.
* @param links - Outer document links, as `[id, originId, originSlot, targetId, targetSlot]`;
* entries that are not five numbers are ignored.
* @param definitions - The document's `definitions.subgraphs`.
* @returns flat nodes and links, and the instance types that could not expand.
*/
function expandSubgraphs(nodes, links, definitions) {
	const byId = new Map(definitions.map((definition) => [definition.id, definition]));
	const instances = new Set(nodes.filter((node) => byId.has(node.type)).map((node) => node.id));
	const unresolved = [];
	const flat = [];
	const flatLinks = [];
	let nextNodeId = Math.max(0, ...nodes.map((node) => node.id), ...definitions.flatMap((definition) => definition.nodes.map((node) => node.id))) + 1;
	let nextLinkId = Math.max(0, ...links.flatMap((link) => typeof link[0] === "number" ? [link[0]] : []), ...definitions.flatMap((definition) => definition.links.map((link) => link.id))) + 1;
	const flatLinkOf = (link) => link.length >= 5 && link.slice(0, 5).every((value) => typeof value === "number") ? [
		link[0],
		link[1],
		link[2],
		link[3],
		link[4]
	] : void 0;
	for (const link of links) {
		const flatLink = flatLinkOf(link);
		if (flatLink === void 0) continue;
		if (instances.has(flatLink[3])) continue;
		flatLinks.push(flatLink);
	}
	for (const node of nodes) {
		const definition = byId.get(node.type);
		if (definition === void 0) {
			flat.push({
				id: node.id,
				type: node.type,
				mode: node.mode,
				inputs: node.inputs.map((input) => ({
					name: input.name,
					link: input.link
				})),
				outputs: node.outputs.map((output) => ({
					name: output.name,
					type: output.type
				})),
				widgetsValues: node.widgets_values
			});
			continue;
		}
		if (definition.nodes.length === 0) {
			unresolved.push(node.type);
			flat.push({
				id: node.id,
				type: node.type,
				mode: node.mode,
				inputs: [],
				outputs: [],
				widgetsValues: []
			});
			continue;
		}
		const nodeIds = /* @__PURE__ */ new Map();
		const pushed = /* @__PURE__ */ new Map();
		const mappedLinks = definition.links.map((link) => ({
			link,
			id: nextLinkId++
		}));
		const idsOfLinks = new Map(mappedLinks.map(({ link, id }) => [link.id, id]));
		for (const inner of definition.nodes) {
			const id = nextNodeId++;
			nodeIds.set(inner.id, id);
			const expanded = {
				id,
				type: inner.type,
				mode: node.mode === 0 ? inner.mode : node.mode,
				inputs: inner.inputs.map((input) => ({
					name: input.name,
					link: typeof input.link === "number" ? idsOfLinks.get(input.link) ?? null : null
				})),
				outputs: inner.outputs.map((output) => ({
					name: output.name,
					type: output.type
				})),
				widgetsValues: inner.widgets_values
			};
			pushed.set(inner.id, expanded);
			flat.push(expanded);
		}
		for (const { link, id } of mappedLinks) {
			const origin = nodeIds.get(link.origin_id);
			const target = nodeIds.get(link.target_id);
			if (origin === void 0 || target === void 0) continue;
			flatLinks.push([
				id,
				origin,
				link.origin_slot,
				target,
				link.target_slot
			]);
		}
		for (const input of node.inputs) {
			if (input.link === null) continue;
			const outer = links.map(flatLinkOf).find((link) => link !== void 0 && link[0] === input.link);
			const declared = definition.inputs.find((slot) => slot.name === input.name);
			if (outer === void 0 || declared === void 0) continue;
			for (const interiorId of declared.linkIds) {
				const mapped = idsOfLinks.get(interiorId);
				if (mapped === void 0) continue;
				const index = flatLinks.findIndex((link) => link[0] === mapped);
				const existing = flatLinks[index];
				if (existing !== void 0) {
					flatLinks[index] = [
						mapped,
						outer[1],
						outer[2],
						existing[3],
						existing[4]
					];
					continue;
				}
				const interior = definition.links.find((link) => link.id === interiorId);
				if (interior === void 0) continue;
				const targetNode = pushed.get(interior.target_id);
				if (targetNode === void 0) continue;
				nextLinkId += 1;
				flatLinks.push([
					nextLinkId,
					outer[1],
					outer[2],
					targetNode.id,
					interior.target_slot
				]);
				const slot = targetNode.inputs[interior.target_slot];
				if (slot !== void 0) slot.link = nextLinkId;
			}
		}
		let valueIndex = 0;
		for (const declared of definition.inputs) {
			if (!isValueType(declared.type)) continue;
			const value = node.widgets_values[valueIndex];
			valueIndex += 1;
			if (value === void 0) continue;
			if (node.inputs.some((input) => input.name === declared.name && input.link !== null)) continue;
			const interior = definition.links.find((link) => declared.linkIds.includes(link.id));
			const targetNode = interior === void 0 ? void 0 : pushed.get(interior.target_id);
			if (targetNode === void 0) continue;
			targetNode.widgetsValues = [value, ...targetNode.widgetsValues.slice(1)];
		}
		for (const [slot, declared] of definition.outputs.entries()) {
			const interior = definition.links.find((link) => declared.linkIds.includes(link.id));
			const producer = interior === void 0 ? void 0 : nodeIds.get(interior.origin_id);
			if (interior === void 0 || producer === void 0) continue;
			for (const [index, link] of flatLinks.entries()) {
				if (link[1] !== node.id || link[2] !== slot) continue;
				flatLinks[index] = [
					link[0],
					producer,
					interior.origin_slot,
					link[3],
					link[4]
				];
			}
		}
	}
	const resolved = flatLinks.filter((link) => !instances.has(link[1]) && !instances.has(link[3]));
	const present = new Set(resolved.map((link) => link[0]));
	for (const node of flat) for (const input of node.inputs) if (input.link !== null && !present.has(input.link)) input.link = null;
	return {
		nodes: flat,
		links: resolved,
		unresolved
	};
}
//#endregion
//#region lib/types/video-settings.js
/** Apply scene timing without replacing model, sampling or reference connections.
* @param graph - Converted ComfyUI graph.
* @param settings - Validated at this request entry.
* @param maxSeconds - Deployment ceiling for a single scene.
*/
function applyVideoSettings(graph, settings, maxSeconds) {
	const { durationSeconds, frameRate, segments } = settings;
	if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > maxSeconds) throw new Error(`Scene duration must be greater than zero and at most ${maxSeconds} seconds`);
	if (!Number.isSafeInteger(frameRate) || frameRate < 1 || frameRate > 60) throw new Error("Frame rate must be a whole number from 1 to 60");
	const nodes = Object.values(graph);
	const director = nodes.find((node) => node.class_type === "LTXDirector");
	const latents = nodes.filter((node) => [
		"EmptyLTXVLatentVideo",
		"LTXVImgToVideo",
		"WanImageToVideo",
		"Wan22ImageToVideoLatent"
	].includes(node.class_type));
	if (latents.length === 0) throw new Error("This workflow does not expose supported scene timing");
	if (segments !== void 0) {
		if (director === void 0) throw new Error("Timed prompt segments require an LTX Director workflow");
		if (segments.length < 1 || segments.length > 32 || segments.some((segment) => !Number.isFinite(segment.seconds) || segment.seconds <= 0 || !segment.prompt.trim() || segment.prompt.length > 8e3 || segment.prompt.includes("|"))) throw new Error("Provide 1 to 32 positive-length segments with nonempty prompts without pipe characters");
		if (Math.abs(segments.reduce((sum, segment) => sum + segment.seconds, 0) - durationSeconds) > .001) throw new Error("Segment durations must total the scene duration");
	}
	const frames = Math.ceil(durationSeconds * frameRate / 8) * 8 + 1;
	for (const latent of latents) latent.inputs.length = frames;
	for (const node of nodes) {
		if (node.class_type === "LTXVEmptyLatentAudio") Object.assign(node.inputs, {
			frames_number: frames,
			frame_rate: frameRate
		});
		if (node.class_type === "LTXVConditioning") node.inputs.frame_rate = frameRate;
		if (node.class_type === "CreateVideo") node.inputs.fps = frameRate;
	}
	if (director !== void 0) {
		Object.assign(director.inputs, {
			start_second: 0,
			end_second: durationSeconds,
			duration_seconds: durationSeconds,
			start_frame: 0,
			end_frame: frames - 1,
			duration_frames: frames - 1,
			frame_rate: frameRate
		});
		if (segments !== void 0) {
			director.inputs.local_prompts = segments.map((segment) => segment.prompt).join("|");
			const lengths = segments.map((segment) => Math.round(segment.seconds * frameRate));
			const last = lengths.length - 1;
			lengths[last] = (lengths[last] ?? 0) + frames - 1 - lengths.reduce((sum, length) => sum + length, 0);
			if (lengths.some((length) => length < 1)) throw new Error("Every prompt segment must cover at least one frame");
			director.inputs.segment_lengths = lengths.join(",");
		}
	}
}
//#endregion
//#region lib/types/types.js
/** Authenticated browser-relative route for streaming one local image or video. */
const COMFY_MEDIA_ROUTE = "api/comfyui-media";
/** Authenticated browser-relative route for a ZIP of selected local files. */
const COMFY_ARCHIVE_ROUTE = "api/comfyui-archive";
//#endregion
//#region lib/types/media.js
/** Authenticated, streamed access to ComfyUI's local image and video outputs. */
const MEDIA_TYPES = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".mkv": "video/x-matroska"
};
/** Extensions this library can display or download. */
const COMFY_MEDIA_EXTENSIONS = Object.freeze(Object.keys(MEDIA_TYPES));
function inside(root, path) {
	const suffix = relative(root, path);
	return suffix !== "" && suffix !== ".." && !suffix.startsWith("..\\") && !suffix.startsWith("../") && !isAbsolute(suffix);
}
/** Resolve an untrusted media reference beneath the configured output folder.
* @param root - Configured ComfyUI output folder.
* @param image - Reference supplied by a browser request.
* @returns Regular-file path and metadata suitable for streaming.
*/
async function localMedia(root, image) {
	if (image.type !== "output" || image.filename !== basename(image.filename) || image.filename === "..") throw new Error("Invalid output file");
	const type = MEDIA_TYPES[extname(image.filename).toLowerCase()];
	if (type === void 0) throw new Error("Unsupported media type");
	const path = resolve(root, image.subfolder, image.filename);
	if (!inside(root, path)) throw new Error("File is outside the output directory");
	const [actualRoot, actualPath, info] = await Promise.all([
		realpath(root),
		realpath(path),
		lstat(path)
	]);
	if (!inside(actualRoot, actualPath) || !info.isFile()) throw new Error("File is outside the output directory");
	return {
		path,
		name: relative(root, path).replaceAll("\\", "/"),
		size: info.size,
		type
	};
}
function imageFromQuery(url) {
	return {
		filename: url.searchParams.get("filename") ?? "",
		subfolder: url.searchParams.get("subfolder") ?? "",
		type: "output"
	};
}
function rangeOf(value, size) {
	if (value === null) return null;
	if (!value.startsWith("bytes=") || value.includes(",")) return null;
	const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
	if (match === null) throw new Error("Invalid media range");
	const [, first = "", last = ""] = match;
	if (first === "" && last === "") throw new Error("Invalid media range");
	const length = BigInt(size);
	if (first === "") {
		const suffix = BigInt(last);
		if (suffix === 0n || size === 0) return "unsatisfiable";
		return {
			start: suffix >= length ? 0 : Number(length - suffix),
			end: size - 1
		};
	}
	const start = BigInt(first);
	const end = last === "" ? length - 1n : BigInt(last);
	if (last !== "" && start > end) throw new Error("Invalid media range");
	if (start >= length) return "unsatisfiable";
	return {
		start: Number(start),
		end: end >= length ? size - 1 : Number(end)
	};
}
/** Stream one selected image or video with byte ranges for video seeking.
* @param root - Configured ComfyUI output folder.
* @param request - Authenticated HTTP request.
* @returns Full or single-range media, 416 for an unsatisfiable range, or a client error.
*/
async function comfyMediaResponse(root, request) {
	try {
		const file = await localMedia(root, imageFromQuery(new URL(request.url)));
		const range = rangeOf(request.method === "GET" ? request.headers.get("range") : null, file.size);
		if (range === "unsatisfiable") return new Response(null, {
			status: 416,
			headers: {
				"content-range": `bytes */${file.size}`,
				"accept-ranges": "bytes"
			}
		});
		const start = range?.start ?? 0;
		const end = range?.end ?? file.size - 1;
		const headers = new Headers({
			"content-type": file.type,
			"content-length": String(end - start + 1),
			"accept-ranges": "bytes",
			"cache-control": "private, no-store",
			"x-content-type-options": "nosniff"
		});
		if (range !== null) headers.set("content-range", `bytes ${start}-${end}/${file.size}`);
		if (request.method === "HEAD" || file.size === 0) return new Response(null, {
			status: 200,
			headers
		});
		const stream = createReadStream(file.path, {
			start,
			end,
			signal: request.signal
		});
		return new Response(Readable.toWeb(stream), {
			status: range === null ? 200 : 206,
			headers
		});
	} catch (error) {
		return new Response(error instanceof Error ? error.message : "Unable to read media", { status: 400 });
	}
}
function archiveImages(url) {
	const raw = url.searchParams.get("files");
	if (raw === null) throw new Error("Choose files to download");
	const value = JSON.parse(raw);
	if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new Error(`Choose 1–100 files`);
	const images = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error("Invalid output file");
		const fields = item;
		if (typeof fields.filename !== "string" || typeof fields.subfolder !== "string" || fields.type !== "output") throw new Error("Invalid output file");
		images.push({
			filename: fields.filename,
			subfolder: fields.subfolder,
			type: "output"
		});
	}
	return images;
}
function streamArchive(files, signal) {
	const consumerAbort = new AbortController();
	const combined = AbortSignal.any([signal, consumerAbort.signal]);
	let zip;
	let resume;
	let terminated = false;
	const stop = () => {
		if (!terminated) {
			terminated = true;
			zip?.terminate();
		}
	};
	return new ReadableStream({
		start(controller) {
			const archive = new Zip((error, data, final) => {
				if (error) {
					controller.error(error);
					return;
				}
				if (data.byteLength > 0) controller.enqueue(data);
				if (final) controller.close();
			});
			zip = archive;
			(async () => {
				try {
					for (const file of files) {
						combined.throwIfAborted();
						const entry = new ZipPassThrough(file.name);
						archive.add(entry);
						for await (const chunk of file.read(combined)) {
							combined.throwIfAborted();
							entry.push(chunk, false);
							if (controller.desiredSize !== null && controller.desiredSize <= 0) {
								await new Promise((resolveWait) => {
									const release = () => {
										resume = void 0;
										combined.removeEventListener("abort", release);
										resolveWait();
									};
									resume = release;
									combined.addEventListener("abort", release, { once: true });
								});
								combined.throwIfAborted();
							}
						}
						entry.push(new Uint8Array(), true);
					}
					archive.end();
				} catch (error) {
					stop();
					controller.error(error instanceof Error ? error : /* @__PURE__ */ new Error("Media archive failed"));
				}
			})();
		},
		pull() {
			resume?.();
			resume = void 0;
		},
		cancel(reason) {
			consumerAbort.abort(reason instanceof Error ? reason : /* @__PURE__ */ new Error("Media archive cancelled"));
			resume?.();
			resume = void 0;
			stop();
		}
	}, {
		highWaterMark: 64 * 1024,
		size: (chunk) => chunk.byteLength
	});
}
/** Stream one ZIP containing selected images and videos, preserving subfolders.
* @param root - Configured ComfyUI output folder.
* @param request - Authenticated GET or HEAD request with selected references.
* @returns Download response after every entry has been validated.
*/
async function comfyArchiveResponse(root, request) {
	try {
		const images = archiveImages(new URL(request.url));
		const files = await Promise.all(images.map((image) => localMedia(root, image)));
		if (new Set(files.map((file) => file.name)).size !== files.length) throw new Error("Duplicate output file");
		const headers = {
			"content-type": "application/zip",
			"content-disposition": "attachment; filename=\"aryaai-media.zip\"",
			"cache-control": "private, no-store",
			"x-content-type-options": "nosniff"
		};
		if (request.method === "HEAD") return new Response(null, { headers });
		return new Response(streamArchive(files.map((file) => ({
			name: file.name,
			read: (signal) => createReadStream(file.path, {
				highWaterMark: 64 * 1024,
				signal
			})
		})), request.signal), { headers });
	} catch (error) {
		return new Response(error instanceof Error ? error.message : "Unable to export media", { status: 400 });
	}
}
/** Download selected ComfyUI outputs without requiring a mounted output directory.
* @param request - Authenticated GET or HEAD request with selected references.
* @param fetchMedia - Fetch one output from the configured server with cancellation.
* @returns a streamed ZIP after validating names and checking every remote output.
*/
async function comfyRemoteArchiveResponse(request, fetchMedia) {
	try {
		const images = archiveImages(new URL(request.url));
		const outputs = images.map((image) => {
			const name = [image.subfolder, image.filename].filter(Boolean).join("/").replaceAll("\\", "/");
			if (image.filename !== basename(image.filename) || isAbsolute(name) || name.split("/").some((part) => part === ".." || part === "." || part === "") || MEDIA_TYPES[extname(image.filename).toLowerCase()] === void 0) throw new Error("Invalid output file");
			return {
				image,
				name
			};
		});
		if (new Set(outputs.map((output) => output.name)).size !== outputs.length) throw new Error("Duplicate output file");
		for (const image of images) {
			const response = await fetchMedia(image, "HEAD", request.signal);
			if (!response.ok) throw new Error(`ComfyUI output returned HTTP ${response.status}`);
		}
		const headers = {
			"content-type": "application/zip",
			"content-disposition": "attachment; filename=\"aryaai-media.zip\"",
			"cache-control": "private, no-store",
			"x-content-type-options": "nosniff"
		};
		if (request.method === "HEAD") return new Response(null, { headers });
		const files = outputs.map(({ image, name }) => ({
			name,
			read: async function* (signal) {
				const response = await fetchMedia(image, "GET", signal);
				if (!response.ok || response.body === null) throw new Error(`ComfyUI output returned HTTP ${response.status}`);
				const reader = response.body.getReader();
				try {
					for (;;) {
						signal.throwIfAborted();
						const chunk = await reader.read();
						if (chunk.done) break;
						yield chunk.value;
					}
				} finally {
					await reader.cancel();
					reader.releaseLock();
				}
			}
		}));
		return new Response(streamArchive(files, request.signal), { headers });
	} catch (error) {
		return new Response(error instanceof Error ? error.message : "Unable to export media", { status: 400 });
	}
}
/** Absolute authenticated routes registered by the Host service. */
const COMFY_MEDIA_PATH = `/${COMFY_MEDIA_ROUTE}`;
/** Absolute authenticated route for ZIP downloads. */
const COMFY_ARCHIVE_PATH = `/${COMFY_ARCHIVE_ROUTE}`;
//#endregion
//#region lib/types/film.js
/** CPU assembly of retained ComfyUI clips into a new MP4. */
async function command(runtime, executable, args, cwd, signal, probe = false) {
	const process = runtime.spawn({
		argv: [executable, ...args],
		cwd,
		signal,
		graceMs: 2e3,
		stdio: {
			stdin: "ignore",
			stdout: { maxBytes: 65536 },
			stderr: { maxBytes: 65536 }
		}
	});
	try {
		const outcome = await process.done;
		signal.throwIfAborted();
		const text = process.collected.stderr?.readFrom(0).text ?? "";
		if (!probe && outcome.exitCode !== 0) throw new Error(`Video assembly failed: ${text.slice(-4e3)}`);
		return text;
	} finally {
		process.terminate();
		await process.waitForExit();
	}
}
function timestamp(seconds) {
	const ms = Math.round(seconds * 1e3);
	return `${Math.floor(ms / 36e5).toString().padStart(2, "0")}:${Math.floor(ms / 6e4 % 60).toString().padStart(2, "0")}:${Math.floor(ms / 1e3 % 60).toString().padStart(2, "0")},${(ms % 1e3).toString().padStart(3, "0")}`;
}
/** Assemble validated local clips with trims, cuts or fades, native audio and optional captions.
* @param runtime - Local subprocess provider managing cancellation and child cleanup.
* @param executable - Deployment FFmpeg executable.
* @param root - Configured ComfyUI output folder.
* @param request - Ordered clips and output settings.
* @param signal - Cancels probing and assembly.
* @param encoding - Deployment limits and H.264 quality settings.
* @returns New film reference after the encoder has completed.
*/
async function assembleFilm(runtime, executable, root, request, signal, encoding) {
	const { width, height, frameRate: fps, fadeSeconds: fade } = request;
	if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 64 || height < 64 || width > 4096 || height > 4096 || width % 2 || height % 2) throw new Error("Film dimensions must be even integers from 64 to 4096");
	if (!Number.isFinite(fps) || fps < 1 || fps > 60 || !Number.isFinite(fade) || fade < 0 || fade > 2) throw new Error("Invalid film frame rate or transition length");
	if (request.clips.length < 1 || request.clips.length > 100) throw new Error("Choose 1 to 100 clips");
	const clips = [];
	for (const clip of request.clips) {
		const media = await localMedia(root, clip.media);
		if (![
			".mp4",
			".mov",
			".webm",
			".mkv"
		].includes(extname(media.path).toLowerCase())) throw new Error("Film inputs must be video clips");
		const text = await command(runtime, executable, [
			"-hide_banner",
			"-nostdin",
			"-i",
			media.path
		], root, signal, true);
		const match = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/u.exec(text);
		if (match === null || !/Video:/u.test(text)) throw new Error("Could not read the clip duration");
		const duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
		const start = clip.startSeconds ?? 0;
		const seconds = clip.seconds ?? duration - start;
		if (!Number.isFinite(start) || start < 0 || !Number.isFinite(seconds) || seconds <= fade || start + seconds > duration + .05) throw new Error("Clip trim is outside its duration or shorter than its transition");
		if (clip.caption !== void 0 && (clip.caption.length > 1e3 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(clip.caption))) throw new Error("Invalid clip caption");
		clips.push({
			...clip,
			path: media.path,
			start,
			seconds,
			audio: /Audio:/u.test(text)
		});
	}
	const seconds = clips.reduce((sum, clip) => sum + clip.seconds, 0) - fade * (clips.length - 1);
	if (seconds > encoding.maxSeconds) throw new Error(`Assembled film exceeds ${encoding.maxSeconds} seconds`);
	const temporary = await mkdtemp(join(root, ".arya-film-"));
	const filename = `AryaFilm-${randomUUID()}.mp4`;
	const output = join(root, filename);
	let committed = false;
	try {
		const args = [
			"-hide_banner",
			"-nostdin",
			"-n"
		];
		for (const clip of clips) args.push("-i", clip.path);
		const filters = [];
		const captions = [];
		let offset = 0;
		for (const [index, clip] of clips.entries()) {
			filters.push(`[${index}:v]trim=start=${clip.start}:duration=${clip.seconds},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p,settb=AVTB[v${index}]`);
			filters.push(clip.audio ? `[${index}:a]atrim=start=${clip.start}:duration=${clip.seconds},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${clip.seconds}[a${index}]` : `anullsrc=r=48000:cl=stereo,atrim=duration=${clip.seconds}[a${index}]`);
			if (clip.caption?.trim()) captions.push(`${captions.length + 1}\n${timestamp(offset)} --> ${timestamp(offset + clip.seconds - (index < clips.length - 1 ? fade : 0))}\n${clip.caption.trim()}\n`);
			offset += clip.seconds - (index < clips.length - 1 ? fade : 0);
		}
		let video = "v0";
		let audio = "a0";
		let elapsed = clips[0]?.seconds ?? 0;
		if (fade > 0 && clips.length > 1) for (let index = 1; index < clips.length; index++) {
			filters.push(`[${video}][v${index}]xfade=transition=fade:duration=${fade}:offset=${elapsed - fade}[vx${index}]`);
			filters.push(`[${audio}][a${index}]acrossfade=d=${fade}[ax${index}]`);
			video = `vx${index}`;
			audio = `ax${index}`;
			elapsed += (clips[index]?.seconds ?? 0) - fade;
		}
		else {
			filters.push(clips.map((_clip, index) => `[v${index}][a${index}]`).join("") + `concat=n=${clips.length}:v=1:a=1[vout][aout]`);
			video = "vout";
			audio = "aout";
		}
		if (captions.length > 0) {
			const captionFile = join(temporary, "captions.srt");
			await writeFile(captionFile, captions.join("\n"), { mode: 384 });
			args.push("-i", captionFile);
		}
		args.push("-filter_complex", filters.join(";"), "-map", `[${video}]`, "-map", `[${audio}]`);
		if (captions.length > 0) args.push("-map", `${clips.length}:0`, "-c:s", "mov_text");
		args.push("-t", String(seconds), "-c:v", "libx264", "-preset", encoding.preset, "-crf", String(encoding.crf), "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", output);
		await command(runtime, executable, args, root, signal);
		if ((await stat(output)).size === 0) throw new Error("Video assembly produced an empty file");
		committed = true;
		return {
			media: {
				filename,
				subfolder: "",
				type: "output"
			},
			seconds,
			clips: clips.length
		};
	} finally {
		await rm(temporary, {
			recursive: true,
			force: true
		});
		if (!committed) await rm(output, { force: true });
	}
}
//#endregion
//#region lib/types/index.js
/** The `comfyImages` Remote namespace over one configured local ComfyUI host. */
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
function normalizedBaseUrl(value) {
	return value.replace(/\/+$/u, "");
}
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
function integer(name, value, min, max) {
	if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
	return value;
}
/** Build the standard-node text-to-image graph shared by the controller and its tests.
* @param request - Validated generation settings.
* @param checkpoint - Installed checkpoint filename.
* @param seed - Resolved sampler seed.
* @param prefix - Output image filename prefix.
* @returns ComfyUI prompt graph.
*/
function basicTextToImageWorkflow(request, checkpoint, seed, prefix) {
	return {
		"1": {
			class_type: "CheckpointLoaderSimple",
			inputs: { ckpt_name: checkpoint }
		},
		"2": {
			class_type: "CLIPTextEncode",
			inputs: {
				text: request.prompt,
				clip: ["1", 1]
			}
		},
		"3": {
			class_type: "CLIPTextEncode",
			inputs: {
				text: request.negativePrompt,
				clip: ["1", 1]
			}
		},
		"4": {
			class_type: "EmptyLatentImage",
			inputs: {
				width: request.width,
				height: request.height,
				batch_size: request.batchSize
			}
		},
		"5": {
			class_type: "KSampler",
			inputs: {
				seed,
				steps: request.steps,
				cfg: request.cfg,
				sampler_name: "euler",
				scheduler: "normal",
				denoise: 1,
				model: ["1", 0],
				positive: ["2", 0],
				negative: ["3", 0],
				latent_image: ["4", 0]
			}
		},
		"6": {
			class_type: "VAEDecode",
			inputs: {
				samples: ["5", 0],
				vae: ["1", 2]
			}
		},
		"7": {
			class_type: "SaveImage",
			inputs: {
				filename_prefix: prefix,
				images: ["6", 0]
			}
		}
	};
}
/** Build the official standard-node Z-Image Turbo text-to-image graph.
* @param request - Validated generation settings.
* @param files - Installed model, encoder, and VAE filenames.
* @param seed - Resolved sampler seed.
* @param prefix - Output image filename prefix.
* @returns ComfyUI prompt graph.
*/
function zImageTurboWorkflow(request, files, seed, prefix) {
	return {
		"1": {
			class_type: "UNETLoader",
			inputs: {
				unet_name: files.diffusionModel,
				weight_dtype: "default"
			}
		},
		"2": {
			class_type: "CLIPLoader",
			inputs: {
				clip_name: files.textEncoder,
				type: "lumina2",
				device: "default"
			}
		},
		"3": {
			class_type: "VAELoader",
			inputs: { vae_name: files.vae }
		},
		"4": {
			class_type: "CLIPTextEncode",
			inputs: {
				text: request.prompt,
				clip: ["2", 0]
			}
		},
		"5": {
			class_type: "CLIPTextEncode",
			inputs: {
				text: request.negativePrompt,
				clip: ["2", 0]
			}
		},
		"6": {
			class_type: "EmptySD3LatentImage",
			inputs: {
				width: request.width,
				height: request.height,
				batch_size: request.batchSize
			}
		},
		"7": {
			class_type: "KSampler",
			inputs: {
				seed,
				steps: request.steps,
				cfg: request.cfg,
				sampler_name: "euler",
				scheduler: "simple",
				denoise: 1,
				model: ["1", 0],
				positive: ["4", 0],
				negative: ["5", 0],
				latent_image: ["6", 0]
			}
		},
		"8": {
			class_type: "VAEDecode",
			inputs: {
				samples: ["7", 0],
				vae: ["3", 0]
			}
		},
		"9": {
			class_type: "SaveImage",
			inputs: {
				filename_prefix: prefix,
				images: ["8", 0]
			}
		}
	};
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
const SAVED_NODE_WIDGET_INPUTS = {
	CheckpointLoaderSimple: ["ckpt_name"],
	UNETLoader: ["unet_name", "weight_dtype"],
	ModelSamplingAuraFlow: ["shift", "sampling"],
	CLIPLoader: [
		"clip_name",
		"type",
		"device"
	],
	CLIPTextEncode: ["text"],
	TextEncodeQwenImage21: [
		"prompt",
		"negative_prompt",
		"resolution"
	],
	QwenImage21Cache: ["device", "dtype"],
	LTXDirector: [
		"start_second",
		"end_second",
		"duration_seconds",
		"start_frame",
		"end_frame",
		"duration_frames",
		"timeline_data",
		"local_prompts",
		"segment_lengths",
		"epsilon",
		"guide_strength",
		"use_custom_audio",
		"use_custom_motion",
		"inpaint_audio",
		"frame_rate",
		"display_mode",
		"custom_width",
		"custom_height",
		"resize_method",
		"divisible_by",
		"img_compression",
		"override_audio"
	],
	LTXDirectorGuide: [
		"ic_lora_name",
		"ic_lora_strength",
		"scale_by",
		"upscale_method",
		"image_attention_strength",
		"crop",
		"auto_snap_ic_grid",
		"use_tiled_encode",
		"tile_size",
		"tile_overlap",
		"retake_mode"
	],
	LTXDirectorCropGuides: [],
	LTXAVTextEncoderLoader: [
		"text_encoder",
		"ckpt_name",
		"device"
	],
	LTXVAudioVAELoader: ["ckpt_name"],
	EmptyLTXVLatentVideo: [
		"width",
		"height",
		"length",
		"batch_size"
	],
	LTXVImgToVideo: [
		"width",
		"height",
		"length",
		"batch_size",
		"strength"
	],
	LTXVEmptyLatentAudio: [
		"frames_number",
		"frame_rate",
		"batch_size"
	],
	LTXVConcatAVLatent: [],
	LTXVSeparateAVLatent: [],
	LTXVAudioVAEDecode: [],
	LTXVConditioning: ["frame_rate"],
	VAEDecodeTiled: [
		"tile_size",
		"overlap",
		"temporal_size",
		"temporal_overlap"
	],
	SamplerEulerAncestral: ["eta", "s_noise"],
	ManualSigmas: ["sigmas"],
	ConditioningZeroOut: [],
	EmptyLatentImage: [
		"width",
		"height",
		"batch_size"
	],
	EmptySD3LatentImage: [
		"width",
		"height",
		"batch_size"
	],
	VAELoader: ["vae_name"],
	VAEDecode: [],
	SaveImage: ["filename_prefix"],
	LoadImage: ["image"],
	ImageScaleToTotalPixels: [
		"upscale_method",
		"megapixels",
		"resolution_steps"
	],
	GetImageSize: [],
	VAEEncode: [],
	ReferenceLatent: [],
	EmptyFlux2LatentImage: [
		"width",
		"height",
		"batch_size"
	],
	RandomNoise: ["noise_seed"],
	KSamplerSelect: ["sampler_name"],
	Flux2Scheduler: [
		"steps",
		"width",
		"height"
	],
	CFGGuider: ["cfg"],
	SamplerCustomAdvanced: [],
	LoraLoader: [
		"lora_name",
		"strength_model",
		"strength_clip"
	],
	UpscaleModelLoader: ["model_name"],
	ImageUpscaleWithModel: [],
	IPAdapterModelLoader: ["ipadapter_file"],
	IPAdapterUnifiedLoader: ["preset"],
	IPAdapterAdvanced: [
		"weight",
		"weight_type",
		"combine_embeds",
		"start_at",
		"end_at",
		"embeds_scaling"
	],
	CLIPVisionLoader: ["clip_name"],
	PrimitiveStringMultiline: ["value"],
	SaveVideo: [
		"filename_prefix",
		"format",
		"codec"
	],
	LoadVideo: ["file"],
	CreateVideo: [
		"fps",
		"bit_depth",
		"color_space",
		"codec"
	],
	GetVideoComponents: [],
	"RIFE VFI": [
		"ckpt_name",
		"clear_cache_after_n_frames",
		"multiplier",
		"fast_mode",
		"ensemble",
		"scale_factor",
		"dtype",
		"torch_compile",
		"batch_size"
	],
	PrimitiveInt: ["value"],
	PrimitiveFloat: ["value"],
	PrimitiveBoolean: ["value"],
	PrimitiveString: ["value"],
	WanImageToVideo: [
		"width",
		"height",
		"length",
		"batch_size"
	],
	Wan22ImageToVideoLatent: [
		"width",
		"height",
		"length",
		"batch_size"
	],
	EmptyHunyuanLatentVideo: [
		"width",
		"height",
		"length",
		"batch_size"
	],
	ModelSamplingSD3: ["shift"],
	LoraLoaderModelOnly: ["lora_name", "strength_model"],
	ImageScale: [
		"upscale_method",
		"width",
		"height",
		"crop"
	],
	ImageFromBatch: ["batch_index", "length"],
	LatentUpscale: [
		"upscale_method",
		"width",
		"height",
		"crop"
	]
};
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
function resolveSwitches(nodes, links) {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const rewired = links.map((link) => [...link]);
	const linkAt = (link) => rewired.find((candidate) => candidate[0] === link);
	const resolved = /* @__PURE__ */ new Set();
	for (const node of nodes) {
		if (node.type !== "ComfySwitchNode") continue;
		const control = node.inputs.find((input) => input.name === "switch");
		const controlLink = control === void 0 || control.link === null ? void 0 : linkAt(control.link);
		const source = controlLink === void 0 ? void 0 : byId.get(controlLink[1]);
		if (source === void 0 || !/^Primitive/u.test(source.type)) continue;
		const branch = node.inputs.find((input) => input.name === (source.widgetsValues[0] === true ? "on_true" : "on_false"));
		const chosen = branch === void 0 || branch.link === null ? void 0 : linkAt(branch.link);
		if (chosen === void 0) continue;
		for (const consumer of nodes) for (const input of consumer.inputs) {
			if (input.link === null) continue;
			const found = linkAt(input.link);
			if (found === void 0 || found[1] !== node.id) continue;
			found[1] = chosen[1];
			found[2] = chosen[2];
		}
		resolved.add(node.id);
	}
	return {
		nodes: nodes.filter((node) => !resolved.has(node.id)),
		links: rewired
	};
}
/**
* Read one ComfyUI saved-workflow document into the graph the converter consumes.
*
* Subgraph instances are expanded here, so a document that stores part of its graph in
* `definitions.subgraphs` converts to the same flat nodes and links a hand-built one does.
* @param value - Untrusted workflow document, as ComfyUI serves it from `/userdata`.
* @returns the parsed graph, or undefined when the document is not a workflow.
*/
function savedWorkflowOf(value) {
	if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.links)) return void 0;
	const rawNodes = value.nodes.filter(isRecord).flatMap((raw) => typeof raw.id === "number" && typeof raw.type === "string" ? [{
		id: raw.id,
		type: raw.type,
		mode: typeof raw.mode === "number" ? raw.mode : 0,
		inputs: namedLinks(raw.inputs),
		outputs: typedOutputs(raw.outputs),
		widgets_values: Array.isArray(raw.widgets_values) ? raw.widgets_values : []
	}] : []);
	const definitions = subgraphDefinitions(value.definitions);
	const expanded = expandSubgraphs(rawNodes, value.links.filter(Array.isArray), definitions);
	const resolved = resolveSwitches(expanded.nodes.map((node) => ({
		id: node.id,
		type: node.type,
		mode: node.mode,
		inputs: node.inputs.map((input) => ({
			name: input.name,
			link: input.link
		})),
		widgetsValues: node.widgetsValues
	})), expanded.links);
	return {
		nodes: resolved.nodes,
		links: resolved.links
	};
}
/** Read a node's declared inputs, keeping only those that name their own link. */
function namedLinks(value) {
	if (!Array.isArray(value)) return [];
	return value.filter(isRecord).flatMap((input) => typeof input.name === "string" ? [{
		name: input.name,
		link: typeof input.link === "number" ? input.link : null
	}] : []);
}
/** Read a node's declared outputs. */
function typedOutputs(value) {
	if (!Array.isArray(value)) return [];
	return value.filter(isRecord).flatMap((output) => typeof output.name === "string" && typeof output.type === "string" ? [{
		name: output.name,
		type: output.type
	}] : []);
}
/** Read the document's subgraph definitions, which a subgraph instance expands from. */
function subgraphDefinitions(value) {
	if (!isRecord(value) || !Array.isArray(value.subgraphs)) return [];
	return value.subgraphs.filter(isRecord).flatMap((definition) => typeof definition.id !== "string" ? [] : [{
		id: definition.id,
		inputs: subgraphSlots(definition.inputs),
		outputs: subgraphSlots(definition.outputs),
		nodes: Array.isArray(definition.nodes) ? definition.nodes.filter(isRecord).flatMap((node) => typeof node.id === "number" && typeof node.type === "string" ? [{
			id: node.id,
			type: node.type,
			mode: typeof node.mode === "number" ? node.mode : 0,
			inputs: namedLinks(node.inputs),
			outputs: typedOutputs(node.outputs),
			widgets_values: Array.isArray(node.widgets_values) ? node.widgets_values : []
		}] : []) : [],
		links: Array.isArray(definition.links) ? definition.links.filter(isRecord).flatMap((link) => typeof link.id === "number" && typeof link.origin_id === "number" && typeof link.target_id === "number" ? [{
			id: link.id,
			origin_id: link.origin_id,
			origin_slot: typeof link.origin_slot === "number" ? link.origin_slot : 0,
			target_id: link.target_id,
			target_slot: typeof link.target_slot === "number" ? link.target_slot : 0
		}] : []) : []
	}]);
}
/** Read the promoted inputs or outputs of one subgraph definition. */
function subgraphSlots(value) {
	if (!Array.isArray(value)) return [];
	return value.filter(isRecord).flatMap((slot) => typeof slot.name === "string" && typeof slot.type === "string" ? [{
		name: slot.name,
		type: slot.type,
		linkIds: Array.isArray(slot.linkIds) ? slot.linkIds.filter((id) => typeof id === "number") : []
	}] : []);
}
function savedWidgetInputs(node) {
	if (node.type === "KSampler") {
		const values = node.widgetsValues;
		return {
			seed: values[0],
			steps: values[2],
			cfg: values[3],
			sampler_name: values[4],
			scheduler: values[5],
			denoise: values[6]
		};
	}
	if (node.type === "KSamplerAdvanced") {
		const values = node.widgetsValues;
		return {
			add_noise: values[0],
			noise_seed: values[1],
			steps: values[3],
			cfg: values[4],
			sampler_name: values[5],
			scheduler: values[6],
			start_at_step: values[7],
			end_at_step: values[8],
			return_with_leftover_noise: values[9]
		};
	}
	const names = SAVED_NODE_WIDGET_INPUTS[node.type];
	if (names === void 0) throw new Error(unsupportedNodeReason(node.type));
	return Object.fromEntries(names.flatMap((name, index) => node.widgetsValues[index] === void 0 ? [] : [[name, node.widgetsValues[index]]]));
}
/** A type that is a subgraph instance rather than a node class. */
const SUBGRAPH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** A type the ComfyUI frontend defines and the server never executes. */
const FRONTEND_NODE = /^Comfy[A-Za-z]+Node$/u;
/**
* Explain a node class this deployment cannot submit.
*
* The two interesting cases are not missing node packs: a subgraph instance whose definition
* the document does not carry, and a node the ComfyUI frontend evaluates itself so it never
* reaches the server. Naming which one it is saves the reader installing a pack that would
* not help.
* @param type - The node's declared class.
* @returns the reason to report.
*/
function unsupportedNodeReason(type) {
	if (SUBGRAPH_ID.test(type)) return `Subgraph ${type} has no definition in this workflow`;
	if (FRONTEND_NODE.test(type)) return `Workflow needs the ComfyUI frontend node ${type}, which the server cannot execute`;
	return `Unsupported workflow node: ${type}`;
}
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
function savedSamplerSettings(nodes) {
	const valuesOf = (type) => nodes.find((node) => node.type === type)?.widgetsValues ?? [];
	const sampler = valuesOf("KSampler");
	const advanced = valuesOf("KSamplerAdvanced");
	const sigmas = valuesOf("ManualSigmas")[0];
	const sigmaSteps = typeof sigmas === "string" ? Math.max(0, sigmas.split(",").filter((part) => part.trim() !== "").length - 1) : void 0;
	const steps = [
		sampler[2],
		advanced[3],
		valuesOf("Flux2Scheduler")[0],
		sigmaSteps
	].find((value) => typeof value === "number");
	const cfg = [
		sampler[3],
		advanced[4],
		valuesOf("CFGGuider")[0]
	].find((value) => typeof value === "number");
	return {
		steps: typeof steps === "number" ? steps : 24,
		cfg: typeof cfg === "number" ? cfg : 7
	};
}
/** Follow conditioning links back to the text encoder that produced them. */
function encoderFeeding(graph, startId, inputName) {
	const seen = /* @__PURE__ */ new Set();
	let current = startId;
	let input = inputName;
	while (!seen.has(current)) {
		seen.add(current);
		const node = graph[current];
		if (node === void 0) return void 0;
		if (node.class_type === "CLIPTextEncode") return current;
		const link = node.inputs[input] ?? node.inputs.conditioning;
		if (!Array.isArray(link) || typeof link[0] !== "string") return void 0;
		current = link[0];
		input = "conditioning";
	}
}
/** Find the encoders feeding the sampling node's positive and negative conditioning. */
function guidanceEncoders(graph) {
	const sampling = nodeOf(graph, "CFGGuider") ?? nodeOf(graph, "KSampler") ?? nodeOf(graph, "KSamplerAdvanced");
	if (sampling === void 0) return {};
	const [id] = sampling;
	return {
		positive: encoderFeeding(graph, id, "positive"),
		negative: encoderFeeding(graph, id, "negative")
	};
}
/**
* Convert one supported ComfyUI saved workflow into an API prompt graph.
* @param saved - Saved workflow graph.
* @param request - Validated generation settings.
* @param seed - Resolved sampler seed.
* @param prefix - Output image filename prefix.
* @returns ComfyUI prompt graph.
*/
function savedTextToImageWorkflow(saved, request, seed, prefix) {
	const graph = {};
	const links = /* @__PURE__ */ new Map();
	for (const link of saved.links) if (typeof link[0] === "number") links.set(link[0], link);
	let promptAssigned = false;
	for (const node of saved.nodes) {
		if (node.mode !== 0 || node.type === "Note" || node.type === "MarkdownNote") continue;
		const inputs = savedWidgetInputs(node);
		for (const input of node.inputs) {
			if (input.link === null) continue;
			const link = links.get(input.link);
			if (link === void 0 || typeof link[1] !== "number" || typeof link[2] !== "number") throw new Error(`Workflow link ${input.link} is invalid`);
			inputs[input.name] = [String(link[1]), link[2]];
		}
		if (node.type === "CLIPTextEncode") {
			inputs.text = promptAssigned ? request.negativePrompt : request.prompt;
			promptAssigned = true;
		} else if (node.type === "TextEncodeQwenImage21") Object.assign(inputs, {
			prompt: request.prompt,
			negative_prompt: request.negativePrompt
		});
		else if (node.type === "LTXDirector") Object.assign(inputs, {
			global_prompt: request.prompt,
			custom_width: request.width,
			custom_height: request.height
		});
		else if (node.type === "EmptyLatentImage" || node.type === "EmptySD3LatentImage" || node.type === "Wan22ImageToVideoLatent" || node.type === "WanImageToVideo" || node.type === "EmptyLTXVLatentVideo" || node.type === "LTXVImgToVideo") Object.assign(inputs, {
			width: request.width,
			height: request.height,
			batch_size: request.batchSize
		});
		else if (node.type === "KSampler") Object.assign(inputs, {
			seed,
			steps: request.steps,
			cfg: request.cfg
		});
		else if (node.type === "RandomNoise") {
			if (!Array.isArray(inputs.noise_seed)) inputs.noise_seed = seed;
		} else if (node.type === "Flux2Scheduler") {
			if (!Array.isArray(inputs.steps)) inputs.steps = request.steps;
		} else if (node.type === "CFGGuider") {
			if (!Array.isArray(inputs.cfg)) inputs.cfg = request.cfg;
		} else if (node.type === "EmptyFlux2LatentImage") {
			if (inputs.batch_size === void 0) inputs.batch_size = request.batchSize;
		} else if (node.type === "SaveImage" || node.type === "SaveVideo") inputs.filename_prefix = prefix;
		graph[String(node.id)] = {
			class_type: node.type,
			inputs
		};
	}
	for (const node of Object.values(graph)) for (const [name, value] of Object.entries(node.inputs)) if (Array.isArray(value) && typeof value[0] === "string" && graph[value[0]] === void 0) Reflect.deleteProperty(node.inputs, name);
	const { positive, negative } = guidanceEncoders(graph);
	if (positive !== void 0) {
		const encoder = graph[positive];
		encoder.inputs.text = request.prompt;
		if (negative !== void 0 && negative !== positive) {
			const opposing = graph[negative];
			opposing.inputs.text = request.negativePrompt;
		}
	}
	if ((nodeOf(graph, "SaveImage") ?? nodeOf(graph, "SaveVideo")) === void 0) throw new Error("Workflow is not a supported generation graph");
	return graph;
}
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
function injectSourceImage(graph, filename) {
	const director = nodeOf(graph, "LTXDirector");
	const guide = nodeOf(graph, "LTXDirectorGuide");
	const latent = nodeOf(graph, "EmptyLTXVLatentVideo");
	if (director !== void 0 && guide !== void 0 && latent !== void 0) {
		const next = Math.max(0, ...Object.keys(graph).map(Number).filter(Number.isFinite)) + 1;
		const imageId = String(next);
		const latentId = String(next + 1);
		graph[imageId] = {
			class_type: "LoadImage",
			inputs: { image: filename }
		};
		graph[latentId] = {
			class_type: "LTXVImgToVideo",
			inputs: {
				...latent[1].inputs,
				image: [imageId, 0],
				vae: guide[1].inputs.vae,
				positive: guide[1].inputs.positive,
				negative: guide[1].inputs.negative,
				strength: guide[1].inputs.image_attention_strength
			}
		};
		Object.assign(guide[1].inputs, {
			positive: [latentId, 0],
			negative: [latentId, 1],
			latent: [latentId, 2]
		});
		return true;
	}
	const loader = nodeOf(graph, "LoadImage");
	if (loader === void 0) return false;
	loader[1].inputs.image = filename;
	return true;
}
/** Replace an empty latent in-place with an image encoded through the graph's VAE.
* @param graph - Saved or built-in text-to-image graph to modify.
* @param filename - ComfyUI annotated image path, including its directory type.
* @param denoise - Sampler change strength from 0.05 to 1.
* @returns The same graph with its sampler connected to the encoded image.
*/
function imageToImageWorkflow(graph, filename, denoise) {
	const sampler = nodeOf(graph, "KSampler");
	const vae = nodeOf(graph, "VAELoader") ?? nodeOf(graph, "CheckpointLoaderSimple");
	if (sampler === void 0 || vae === void 0) throw new Error("Workflow cannot use an input image");
	const vaeOutput = vae[1].class_type === "CheckpointLoaderSimple" ? 2 : 0;
	const nextId = Math.max(0, ...Object.keys(graph).map(Number).filter(Number.isFinite)) + 1;
	const loadId = String(nextId);
	const encodeId = String(nextId + 1);
	const priorLatent = sampler[1].inputs.latent_image;
	if (Array.isArray(priorLatent) && typeof priorLatent[0] === "string") {
		const node = graph[priorLatent[0]];
		if (node?.class_type === "EmptyLatentImage" || node?.class_type === "EmptySD3LatentImage") Reflect.deleteProperty(graph, priorLatent[0]);
	}
	graph[loadId] = {
		class_type: "LoadImage",
		inputs: { image: filename }
	};
	graph[encodeId] = {
		class_type: "VAEEncode",
		inputs: {
			pixels: [loadId, 0],
			vae: [vae[0], vaeOutput]
		}
	};
	sampler[1].inputs.latent_image = [encodeId, 0];
	sampler[1].inputs.denoise = denoise;
	return graph;
}
function isWorkflow(value) {
	return isRecord(value) && Object.values(value).some((node) => isRecord(node) && typeof node.class_type === "string" && isRecord(node.inputs));
}
function workflowOf(value) {
	if (isWorkflow(value)) return value;
	if (!Array.isArray(value)) return void 0;
	return value.find(isWorkflow);
}
function stringInput(graph, node, key) {
	const value = graph[node]?.inputs[key];
	return typeof value === "string" ? value : "";
}
function numberInput(graph, node, key) {
	const value = graph[node]?.inputs[key];
	return typeof value === "number" ? value : 0;
}
function nodeOf(graph, classType) {
	return Object.entries(graph).find(([, node]) => node.class_type === classType);
}
function imagesOf(value) {
	if (!isRecord(value)) return [];
	const images = [];
	for (const output of Object.values(value)) {
		if (!isRecord(output)) continue;
		const files = [];
		for (const items of [
			output.images,
			output.gifs,
			output.videos
		]) if (Array.isArray(items)) for (const item of items) files.push(item);
		for (const image of files) {
			if (!isRecord(image) || typeof image.filename !== "string") continue;
			const reference = {
				filename: image.filename,
				subfolder: typeof image.subfolder === "string" ? image.subfolder : "",
				type: typeof image.type === "string" ? image.type : "output"
			};
			if (!images.some((item) => item.filename === reference.filename && item.subfolder === reference.subfolder && item.type === reference.type)) images.push(reference);
		}
	}
	return images;
}
function workflowFingerprint(graph) {
	const dynamicInputs = {
		CLIPTextEncode: ["text"],
		EmptyLatentImage: [
			"width",
			"height",
			"batch_size"
		],
		EmptySD3LatentImage: [
			"width",
			"height",
			"batch_size"
		],
		KSampler: [
			"seed",
			"steps",
			"cfg"
		],
		SaveImage: ["filename_prefix"]
	};
	return JSON.stringify(Object.fromEntries(Object.entries(graph).sort(([left], [right]) => left.localeCompare(right)).map(([id, node]) => {
		const omitted = new Set(dynamicInputs[node.class_type] ?? []);
		return [id, {
			class_type: node.class_type,
			inputs: Object.fromEntries(Object.entries(node.inputs).filter(([name]) => !omitted.has(name)).sort(([left], [right]) => left.localeCompare(right)))
		}];
	})));
}
function workflowMetadataOf(value) {
	if (!Array.isArray(value)) return void 0;
	for (const part of value) {
		if (!isRecord(part) || !isRecord(part.aryaai)) continue;
		const { workflowId, workflowLabel } = part.aryaai;
		if (typeof workflowId === "string" && typeof workflowLabel === "string") return {
			id: workflowId,
			label: workflowLabel
		};
	}
}
function inferredWorkflow(graph, identities) {
	const fingerprint = workflowFingerprint(graph);
	const prefixes = Object.values(graph).flatMap((node) => [
		"SaveImage",
		"SaveVideo",
		"VHS_VideoCombine"
	].includes(node.class_type) && typeof node.inputs.filename_prefix === "string" ? [node.inputs.filename_prefix] : []);
	const prefixMatch = identities.find((identity) => identity.outputPrefixes.some((prefix) => prefixes.includes(prefix)));
	const fingerprintMatches = identities.filter((identity) => identity.fingerprint === fingerprint);
	const matched = prefixMatch ?? (fingerprintMatches.length === 1 ? fingerprintMatches[0] : void 0);
	if (matched !== void 0) return {
		id: matched.id,
		label: matched.label
	};
	if (nodeOf(graph, "SaveVideo") !== void 0 || nodeOf(graph, "VHS_VideoCombine") !== void 0) return {
		id: null,
		label: "Custom video workflow"
	};
	if (nodeOf(graph, "TextEncodeQwenImage21") !== void 0) return {
		id: null,
		label: "Custom Qwen Image 2.1 workflow"
	};
	return nodeOf(graph, "UNETLoader") === void 0 ? {
		id: null,
		label: "Custom checkpoint workflow"
	} : {
		id: null,
		label: "Custom Z-Image workflow"
	};
}
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
function savedWorkflowTakesPrompt(nodes) {
	return nodes.some((node) => (node.type === "CLIPTextEncode" || node.type === "TextEncodeQwenImage21" || node.type === "LTXDirector") && (node.mode ?? 0) === 0) ? void 0 : false;
}
/**
* Read whether a saved graph needs a source image, from an active image loader.
*
* A caller that cannot supply one — the generation tool, or a first request in the panel — needs
* this to tell a create workflow from one that would run against whatever file the graph names.
* A bypassed loader does not count, because that graph runs on its own.
* @param nodes - The saved graph's nodes.
* @returns `edit` when a source image is required, otherwise `undefined`.
*/
function savedWorkflowTask(nodes) {
	return nodes.some((node) => node.type === "LoadImage" && (node.mode ?? 0) === 0) ? "edit" : void 0;
}
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
function absentCheckpoint(graph, models) {
	const checkpoint = nodeOf(graph, "CheckpointLoaderSimple");
	if (checkpoint === void 0) return false;
	const name = stringInput(graph, checkpoint[0], "ckpt_name");
	if (name === "") return false;
	return !models.some((model) => model.kind === "checkpoint" && model.checkpoint === name);
}
/**
* Read whether a saved graph writes a still or a video, from the node that writes it.
*
* The writer node decides, not the model or the graph's title, so a video workflow is never
* presented as a still one.
* @param nodes - The saved graph's nodes.
* @returns `video` when the graph writes one, otherwise `image`.
*/
function savedWorkflowOutput(nodes) {
	return nodes.some((node) => node.type === "SaveVideo" || node.type === "VHS_VideoCombine") ? "video" : "image";
}
/** Reconstruct generations from ComfyUI history entries.
* @param value - Untrusted ComfyUI history JSON.
* @param identities - Saved workflow identities available at read time.
* @returns Generations with image references and resolved workflow labels.
*/ function generationsOf(value, identities = []) {
	if (!isRecord(value)) return [];
	const generations = [];
	for (const [promptId, raw] of Object.entries(value).reverse()) {
		if (!isRecord(raw)) continue;
		const graph = workflowOf(raw.prompt);
		if (graph === void 0) continue;
		const video = nodeOf(graph, "SaveVideo") !== void 0 || nodeOf(graph, "VHS_VideoCombine") !== void 0;
		if (!video && nodeOf(graph, "SaveImage") === void 0) continue;
		const status = isRecord(raw.status) ? raw.status : void 0;
		const checkpoint = nodeOf(graph, "CheckpointLoaderSimple");
		const diffusion = nodeOf(graph, "UNETLoader");
		const qwen = nodeOf(graph, "TextEncodeQwenImage21");
		const director = nodeOf(graph, "LTXDirector");
		const positive = director ?? qwen ?? nodeOf(graph, "CLIPTextEncode");
		const negative = Object.entries(graph).filter(([, node]) => node.class_type === "CLIPTextEncode")[1];
		const latent = nodeOf(graph, "EmptyLTXVLatentVideo") ?? nodeOf(graph, "EmptyFlux2LatentImage") ?? nodeOf(graph, "Wan22ImageToVideoLatent") ?? nodeOf(graph, "WanImageToVideo") ?? nodeOf(graph, qwen !== void 0 || checkpoint !== void 0 ? "EmptyLatentImage" : "EmptySD3LatentImage");
		const sampler = nodeOf(graph, "KSampler") ?? nodeOf(graph, "KSamplerAdvanced") ?? nodeOf(graph, "SamplerCustomAdvanced");
		if (positive === void 0 || sampler === void 0) continue;
		const flux = nodeOf(graph, "Flux2Scheduler") !== void 0;
		const scheduler = nodeOf(graph, "Flux2Scheduler");
		const guider = nodeOf(graph, "CFGGuider");
		const noise = nodeOf(graph, "RandomNoise");
		const manualSigmas = nodeOf(graph, "ManualSigmas");
		const metadataPart = (Array.isArray(raw.prompt) ? raw.prompt : []).find((part) => isRecord(part) && isRecord(part.aryaai));
		const runSettings = isRecord(metadataPart) && isRecord(metadataPart.aryaai) ? metadataPart.aryaai : void 0;
		let sourceNode = nodeOf(graph, "VAEEncode")?.[1] ?? nodeOf(graph, "LTXVImgToVideo")?.[1];
		const reference = qwen?.[1].inputs["images.image_1"];
		if (Array.isArray(reference) && typeof reference[0] === "string") sourceNode = graph[reference[0]];
		const visited = /* @__PURE__ */ new Set();
		while (sourceNode !== void 0 && sourceNode.class_type !== "LoadImage") {
			const link = sourceNode.inputs.pixels ?? sourceNode.inputs.image;
			if (!Array.isArray(link) || typeof link[0] !== "string" || visited.has(link[0])) {
				sourceNode = void 0;
				break;
			}
			visited.add(link[0]);
			sourceNode = graph[link[0]];
		}
		const annotated = typeof sourceNode?.inputs.image === "string" ? sourceNode.inputs.image : "";
		const match = /^(.*?)(?: \[(input|output|temp)\])?$/u.exec(annotated);
		const sourcePath = match?.[1] ?? "";
		const slash = sourcePath.lastIndexOf("/");
		const sourceImage = sourcePath === "" ? null : {
			filename: sourcePath.slice(slash + 1),
			subfolder: slash < 0 ? "" : sourcePath.slice(0, slash),
			type: match?.[2] ?? "input"
		};
		const model = checkpoint === void 0 ? `${video ? "diffusion" : qwen !== void 0 ? "qwen-image-2.1" : flux ? "flux2-klein" : "z-image-turbo"}:${encodeURIComponent(stringInput(graph, diffusion?.[0] ?? "", "unet_name"))}` : `checkpoint:${encodeURIComponent(stringInput(graph, checkpoint[0], "ckpt_name"))}`;
		const modelLabel = checkpoint === void 0 ? video ? stringInput(graph, diffusion?.[0] ?? "", "unet_name") : `${qwen !== void 0 ? "Qwen Image 2.1" : flux ? "Flux 2 Klein" : "Z-Image Turbo"} · ${stringInput(graph, diffusion?.[0] ?? "", "unet_name")}` : stringInput(graph, checkpoint[0], "ckpt_name");
		const workflow = workflowMetadataOf(raw.prompt) ?? inferredWorkflow(graph, identities);
		generations.push({
			promptId,
			state: status?.status_str === "error" ? "error" : "complete",
			workflow: "id" in workflow ? workflow.id : null,
			workflowLabel: workflow.label,
			prompt: stringInput(graph, positive[0], director !== void 0 ? "global_prompt" : qwen === void 0 ? "text" : "prompt"),
			negativePrompt: qwen === void 0 ? negative === void 0 ? "" : stringInput(graph, negative[0], "text") : stringInput(graph, qwen[0], "negative_prompt"),
			model,
			modelLabel,
			width: typeof runSettings?.width === "number" ? runSettings.width : numberInput(graph, latent?.[0] ?? "", "width"),
			height: typeof runSettings?.height === "number" ? runSettings.height : numberInput(graph, latent?.[0] ?? "", "height"),
			steps: manualSigmas === void 0 ? numberInput(graph, scheduler?.[0] ?? sampler[0], "steps") : Math.max(0, stringInput(graph, manualSigmas[0], "sigmas").split(",").filter((part) => part.trim() !== "").length - 1),
			cfg: numberInput(graph, guider?.[0] ?? sampler[0], "cfg"),
			seed: noise === void 0 ? numberInput(graph, sampler[0], "seed") : numberInput(graph, noise[0], "noise_seed"),
			sourceImage,
			denoise: numberInput(graph, sampler[0], "denoise"),
			images: imagesOf(raw.outputs)
		});
	}
	return generations;
}
/** `execFile` returns a stream unless it is given a callback; this is the promise form. */
const execFileAsync = promisify(execFile);
/** Remote controller used by the Images Cordis UI plugin. */
let ComfyImagesController = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _status_decorators;
	let _startServer_decorators;
	let _stopServer_decorators;
	let _restartServer_decorators;
	let _generate_decorators;
	let _assemble_decorators;
	let _history_decorators;
	let _image_decorators;
	let _library_decorators;
	let _deleteImage_decorators;
	let _deleteImages_decorators;
	let _deleteGeneration_decorators;
	let _cancel_decorators;
	return class ComfyImagesController extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_status_decorators = [Remote];
			_startServer_decorators = [Remote];
			_stopServer_decorators = [Remote];
			_restartServer_decorators = [Remote];
			_generate_decorators = [Remote];
			_assemble_decorators = [Remote];
			_history_decorators = [Remote];
			_image_decorators = [Remote];
			_library_decorators = [Remote];
			_deleteImage_decorators = [Remote];
			_deleteImages_decorators = [Remote];
			_deleteGeneration_decorators = [Remote];
			_cancel_decorators = [Remote];
			__esDecorate(this, null, _status_decorators, {
				kind: "method",
				name: "status",
				static: false,
				private: false,
				access: {
					has: (obj) => "status" in obj,
					get: (obj) => obj.status
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _startServer_decorators, {
				kind: "method",
				name: "startServer",
				static: false,
				private: false,
				access: {
					has: (obj) => "startServer" in obj,
					get: (obj) => obj.startServer
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _stopServer_decorators, {
				kind: "method",
				name: "stopServer",
				static: false,
				private: false,
				access: {
					has: (obj) => "stopServer" in obj,
					get: (obj) => obj.stopServer
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _restartServer_decorators, {
				kind: "method",
				name: "restartServer",
				static: false,
				private: false,
				access: {
					has: (obj) => "restartServer" in obj,
					get: (obj) => obj.restartServer
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _generate_decorators, {
				kind: "method",
				name: "generate",
				static: false,
				private: false,
				access: {
					has: (obj) => "generate" in obj,
					get: (obj) => obj.generate
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _assemble_decorators, {
				kind: "method",
				name: "assemble",
				static: false,
				private: false,
				access: {
					has: (obj) => "assemble" in obj,
					get: (obj) => obj.assemble
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _history_decorators, {
				kind: "method",
				name: "history",
				static: false,
				private: false,
				access: {
					has: (obj) => "history" in obj,
					get: (obj) => obj.history
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _image_decorators, {
				kind: "method",
				name: "image",
				static: false,
				private: false,
				access: {
					has: (obj) => "image" in obj,
					get: (obj) => obj.image
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _library_decorators, {
				kind: "method",
				name: "library",
				static: false,
				private: false,
				access: {
					has: (obj) => "library" in obj,
					get: (obj) => obj.library
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _deleteImage_decorators, {
				kind: "method",
				name: "deleteImage",
				static: false,
				private: false,
				access: {
					has: (obj) => "deleteImage" in obj,
					get: (obj) => obj.deleteImage
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _deleteImages_decorators, {
				kind: "method",
				name: "deleteImages",
				static: false,
				private: false,
				access: {
					has: (obj) => "deleteImages" in obj,
					get: (obj) => obj.deleteImages
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _deleteGeneration_decorators, {
				kind: "method",
				name: "deleteGeneration",
				static: false,
				private: false,
				access: {
					has: (obj) => "deleteGeneration" in obj,
					get: (obj) => obj.deleteGeneration
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _cancel_decorators, {
				kind: "method",
				name: "cancel",
				static: false,
				private: false,
				access: {
					has: (obj) => "cancel" in obj,
					get: (obj) => obj.cancel
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static Config = z.object({
			baseUrl: z.string().min(1).default("http://127.0.0.1:8188"),
			outputPrefix: z.string().min(1).default("AryaAI"),
			requestTimeoutMs: z.number().step(1).min(1e3).max(3e5).default(3e4),
			outputDirectory: z.string().default(""),
			serverPythonPath: z.string().default(""),
			serverDirectory: z.string().default(""),
			serverStartTimeoutMs: z.number().step(1).min(1e3).max(6e5).default(12e4),
			maxVideoSeconds: z.number().min(1).max(120).default(30),
			ffmpegPath: z.string().default(""),
			filmTimeoutMs: z.number().step(1).min(1e3).max(36e5).default(6e5),
			maxFilmSeconds: z.number().min(1).max(86400).default(1800),
			filmCrf: z.number().step(1).min(0).max(51).default(20),
			filmEncoderPreset: z.union([
				"ultrafast",
				"fast",
				"medium",
				"slow"
			]).default("medium")
		});
		config = __runInitializers(this, _instanceExtraInitializers);
		savedCatalogCache;
		constructor(ctx, config = {}) {
			super(ctx, "comfyImagesController", { namespace: "comfyImages" });
			this.config = {
				baseUrl: normalizedBaseUrl(config.baseUrl ?? "http://127.0.0.1:8188"),
				outputPrefix: config.outputPrefix ?? "AryaAI",
				requestTimeoutMs: config.requestTimeoutMs ?? 3e4,
				outputDirectory: config.outputDirectory?.trim() ? resolve(config.outputDirectory) : null,
				serverPythonPath: config.serverPythonPath?.trim() ? resolve(config.serverPythonPath) : null,
				serverDirectory: config.serverDirectory?.trim() ? resolve(config.serverDirectory) : null,
				serverStartTimeoutMs: config.serverStartTimeoutMs ?? 12e4,
				maxVideoSeconds: config.maxVideoSeconds ?? 30,
				ffmpegPath: config.ffmpegPath?.trim() || null,
				filmTimeoutMs: config.filmTimeoutMs ?? 6e5,
				maxFilmSeconds: config.maxFilmSeconds ?? 1800,
				filmCrf: config.filmCrf ?? 20,
				filmEncoderPreset: config.filmEncoderPreset ?? "medium"
			};
			ctx.inject(["connection"], (connected) => {
				connected.effect(() => connected.connection.fetch.register({
					path: COMFY_MEDIA_PATH,
					methods: ["GET", "HEAD"],
					requestBody: "buffered",
					fetch: (request) => this.config.outputDirectory === null ? Promise.resolve(new Response("Local media is unavailable", { status: 404 })) : comfyMediaResponse(this.config.outputDirectory, request)
				}), "comfyui-controller: media route");
				connected.effect(() => connected.connection.fetch.register({
					path: COMFY_ARCHIVE_PATH,
					methods: ["GET", "HEAD"],
					requestBody: "buffered",
					fetch: (request) => this.config.outputDirectory === null ? comfyRemoteArchiveResponse(request, (image, method, signal) => {
						const query = new URLSearchParams({
							filename: image.filename,
							subfolder: image.subfolder,
							type: image.type
						});
						return this.request(`/view?${query}`, { method }, signal);
					}) : comfyArchiveResponse(this.config.outputDirectory, request)
				}), "comfyui-controller: archive route");
			});
		}
		async request(path, init = {}, signal) {
			const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
			const combined = signal === void 0 ? timeout : AbortSignal.any([signal, timeout]);
			return fetch(`${this.config.baseUrl}${path}`, {
				...init,
				signal: combined
			});
		}
		annotatedSourceImage(image) {
			if (![
				"input",
				"output",
				"temp"
			].includes(image.type) || image.filename !== basename(image.filename)) throw new Error("Invalid ComfyUI source image");
			const segments = image.subfolder.split(/[\\/]/u).filter(Boolean);
			if (segments.some((segment) => segment === ".." || segment === "." || segment.includes(":"))) throw new Error("Invalid ComfyUI source image folder");
			return `${[...segments, image.filename].join("/")} [${image.type}]`;
		}
		async nodeChoices(node, input, signal) {
			const response = await this.request(`/object_info/${node}`, {}, signal);
			if (!response.ok) return [];
			const body = await response.json();
			if (!isRecord(body)) return [];
			const loader = body[node];
			if (!isRecord(loader) || !isRecord(loader.input) || !isRecord(loader.input.required)) return [];
			const choices = loader.input.required[input];
			if (!Array.isArray(choices) || !Array.isArray(choices[0])) return [];
			return choices[0].filter((item) => typeof item === "string");
		}
		async models(signal) {
			const [checkpoints, diffusionModels, textEncoders, vaes] = await Promise.all([
				this.nodeChoices("CheckpointLoaderSimple", "ckpt_name", signal),
				this.nodeChoices("UNETLoader", "unet_name", signal),
				this.nodeChoices("CLIPLoader", "clip_name", signal),
				this.nodeChoices("VAELoader", "vae_name", signal)
			]);
			const models = checkpoints.map((checkpoint) => ({
				id: `checkpoint:${encodeURIComponent(checkpoint)}`,
				label: checkpoint,
				kind: "checkpoint",
				recommendedSteps: 24,
				recommendedCfg: 7,
				checkpoint
			}));
			const diffusionModel = diffusionModels.find((name) => /z[_-]image.*turbo/iu.test(name));
			const textEncoder = textEncoders.find((name) => /qwen[_-]3[_-]4b/iu.test(name));
			const vae = vaes.find((name) => /^ae(?:\.|_)/iu.test(name));
			if (diffusionModel !== void 0 && textEncoder !== void 0 && vae !== void 0) models.unshift({
				id: `z-image-turbo:${encodeURIComponent(diffusionModel)}`,
				label: "Z-Image Turbo",
				kind: "z-image-turbo",
				recommendedSteps: 9,
				recommendedCfg: 1,
				diffusionModel,
				textEncoder,
				vae
			});
			const flux = diffusionModels.find((name) => /flux[-_]2[-_]klein[-_]4b/iu.test(name) && !/base/iu.test(name));
			const fluxVae = vaes.find((name) => /flux2[-_]vae/iu.test(name));
			if (flux !== void 0 && textEncoder !== void 0 && fluxVae !== void 0) models.push({
				id: "flux2-klein:" + encodeURIComponent(flux),
				label: "Flux 2 Klein",
				kind: "flux2-klein",
				recommendedSteps: 4,
				recommendedCfg: 1,
				diffusionModel: flux,
				textEncoder,
				vae: fluxVae
			});
			const baseFlux = diffusionModels.find((name) => /flux[-_]2[-_]klein[-_]?base[-_]4b/iu.test(name));
			if (baseFlux !== void 0 && textEncoder !== void 0 && fluxVae !== void 0) models.push({
				id: "flux2-klein:" + encodeURIComponent(baseFlux),
				label: "Flux 2 Klein (base)",
				kind: "flux2-klein",
				recommendedSteps: 20,
				recommendedCfg: 5,
				diffusionModel: baseFlux,
				textEncoder,
				vae: fluxVae
			});
			return models;
		}
		graphModel(graph, models) {
			const checkpoint = nodeOf(graph, "CheckpointLoaderSimple");
			if (checkpoint !== void 0) {
				const name = stringInput(graph, checkpoint[0], "ckpt_name");
				return models.find((model) => model.kind === "checkpoint" && model.checkpoint === name);
			}
			const unet = nodeOf(graph, "UNETLoader");
			const clip = nodeOf(graph, "CLIPLoader");
			const vae = nodeOf(graph, "VAELoader");
			if (unet === void 0 || clip === void 0 || vae === void 0) return void 0;
			return models.find((model) => model.kind !== "checkpoint" && model.diffusionModel === stringInput(graph, unet[0], "unet_name") && model.textEncoder === stringInput(graph, clip[0], "clip_name") && model.vae === stringInput(graph, vae[0], "vae_name"));
		}
		async savedWorkflow(name, signal) {
			const response = await this.request(`/userdata/${encodeURIComponent(`workflows/${name}`)}`, {}, signal);
			if (!response.ok) throw new Error(`ComfyUI workflow ${name} returned HTTP ${response.status}`);
			const workflow = savedWorkflowOf(await response.json());
			if (workflow === void 0) throw new Error(`ComfyUI workflow ${name} is invalid`);
			return workflow;
		}
		savedCatalog() {
			const now = Date.now();
			if (this.savedCatalogCache !== void 0 && this.savedCatalogCache.expiresAt > now) return this.savedCatalogCache.value;
			const value = (async () => {
				const response = await this.request("/userdata?dir=workflows&recurse=true&split=false");
				if (!response.ok) return [];
				const raw = await response.json();
				if (!Array.isArray(raw)) return [];
				const names = raw.filter((item) => typeof item === "string" && item.toLowerCase().endsWith(".json")).slice(0, 100);
				return Promise.all(names.map(async (name) => {
					try {
						return {
							name,
							workflow: await this.savedWorkflow(name)
						};
					} catch (error) {
						return {
							name,
							error: messageOf(error)
						};
					}
				}));
			})();
			this.savedCatalogCache = {
				expiresAt: now + 5e3,
				value
			};
			value.catch(() => {
				if (this.savedCatalogCache?.value === value) this.savedCatalogCache = void 0;
			});
			return value;
		}
		historyWorkflowIdentities(saved) {
			return saved.flatMap(({ name, workflow }) => {
				if (workflow === void 0) return [];
				const id = `saved:${encodeURIComponent(name)}`;
				const label = name.replace(/\.json$/iu, "");
				const values = workflow.nodes.find((node) => node.type === "KSampler")?.widgetsValues ?? [];
				const example = {
					prompt: "history identity",
					negativePrompt: "",
					model: null,
					workflow: id,
					width: 1024,
					height: 1024,
					steps: typeof values[2] === "number" ? values[2] : 24,
					cfg: typeof values[3] === "number" ? values[3] : 7,
					seed: 0,
					batchSize: 1,
					sourceImage: null,
					denoise: 1
				};
				try {
					const graph = savedTextToImageWorkflow(workflow, example, 0, this.config.outputPrefix);
					return [{
						id,
						label,
						outputPrefixes: workflow.nodes.flatMap((node) => node.type === "SaveImage" && typeof node.widgetsValues[0] === "string" ? [node.widgetsValues[0]] : []),
						fingerprint: workflowFingerprint(graph)
					}];
				} catch {
					return [];
				}
			});
		}
		async workflows(models, signal) {
			const primary = models.find((model) => model.kind !== "flux2-klein");
			const editModel = models.find((model) => model.kind === "flux2-klein");
			const edit = {
				id: "built-in:flux-reference-edit",
				label: "Flux 2 Klein · Edit image",
				source: "built-in",
				task: "edit",
				available: editModel !== void 0,
				unavailableReason: editModel === void 0 ? "Flux 2 Klein 4B, Qwen 3 4B and Flux 2 VAE are required" : null,
				recommendedSteps: 4,
				recommendedCfg: 1,
				supportsNegativePrompt: false,
				modelId: editModel?.id ?? null,
				starterPrompt: "",
				width: 1024,
				height: 1024,
				batchSize: 1,
				output: "image"
			};
			const builtIn = {
				id: "built-in:standard",
				label: primary?.kind === "z-image-turbo" ? "Z-Image Turbo · AryaAI standard" : "AryaAI standard",
				source: "built-in",
				available: primary !== void 0,
				unavailableReason: primary === void 0 ? "No compatible model is installed" : null,
				recommendedSteps: primary?.recommendedSteps ?? 24,
				recommendedCfg: primary?.recommendedCfg ?? 7,
				supportsNegativePrompt: primary?.kind !== "z-image-turbo",
				modelId: primary?.id ?? null,
				starterPrompt: "",
				width: 1024,
				height: 1024,
				batchSize: 1,
				output: "image"
			};
			try {
				const catalog = await this.savedCatalog();
				signal?.throwIfAborted();
				return [
					...catalog.map(({ name, workflow, error }) => {
						const id = `saved:${encodeURIComponent(name)}`;
						const label = name.replace(/\.json$/iu, "");
						try {
							if (workflow === void 0) throw new Error(error ?? `ComfyUI workflow ${name} is invalid`);
							const output = savedWorkflowOutput(workflow.nodes);
							const settings = savedSamplerSettings(workflow.nodes);
							const example = {
								prompt: "compatibility probe",
								negativePrompt: "",
								model: null,
								workflow: id,
								width: 1024,
								height: 1024,
								steps: settings.steps,
								cfg: settings.cfg,
								seed: 0,
								batchSize: 1,
								sourceImage: null,
								denoise: 1
							};
							const graph = savedTextToImageWorkflow(workflow, example, 0, this.config.outputPrefix);
							const matchedModel = this.graphModel(graph, models);
							const available = !absentCheckpoint(graph, models);
							const starter = workflow.nodes.find((node) => (node.type === "CLIPTextEncode" || node.type === "TextEncodeQwenImage21") && node.mode === 0);
							const latentValues = workflow.nodes.find((node) => (node.type === "EmptyLatentImage" || node.type === "EmptySD3LatentImage" || node.type === "Wan22ImageToVideoLatent" || node.type === "WanImageToVideo" || node.type === "EmptyLTXVLatentVideo") && node.mode === 0)?.widgetsValues ?? [];
							return {
								id,
								label,
								source: "saved",
								available,
								...workflow.nodes.some((node) => node.type === "LTXDirector") && workflow.nodes.some((node) => node.type === "LTXDirectorGuide") ? { acceptsReference: true } : {},
								unavailableReason: available ? null : "Required model files are not installed",
								task: savedWorkflowTask(workflow.nodes),
								recommendedSteps: example.steps,
								recommendedCfg: example.cfg,
								supportsNegativePrompt: workflow.nodes.some((node) => node.type === "TextEncodeQwenImage21" && node.mode === 0) || workflow.nodes.filter((node) => node.type === "CLIPTextEncode" && node.mode === 0).length > 1,
								takesPrompt: savedWorkflowTakesPrompt(workflow.nodes),
								modelId: matchedModel?.id ?? null,
								starterPrompt: typeof starter?.widgetsValues[0] === "string" ? starter.widgetsValues[0] : "",
								width: typeof latentValues[0] === "number" ? latentValues[0] : 1024,
								height: typeof latentValues[1] === "number" ? latentValues[1] : 1024,
								batchSize: typeof latentValues[2] === "number" ? latentValues[2] : 1,
								output,
								saved: workflow
							};
						} catch (error) {
							return {
								id,
								label,
								source: "saved",
								available: false,
								unavailableReason: messageOf(error),
								recommendedSteps: 24,
								recommendedCfg: 7,
								supportsNegativePrompt: true,
								modelId: null,
								starterPrompt: "",
								width: 1024,
								height: 1024,
								batchSize: 1,
								output: "image"
							};
						}
					}),
					builtIn,
					edit
				];
			} catch {
				return [builtIn, edit];
			}
		}
		/** Probe ComfyUI and list locally installed model configurations Arya can run.
		* @param signal - Cancellation signal for the Remote call.
		* @returns Connection state, models, and saved workflows.
		*/
		async status(signal) {
			try {
				const response = await this.request("/system_stats", {}, signal);
				if (!response.ok) throw new Error(`ComfyUI returned HTTP ${response.status}`);
				const catalogModels = await this.models(signal);
				const models = catalogModels.map(({ id, label, kind, recommendedSteps, recommendedCfg }) => ({
					id,
					label,
					kind,
					recommendedSteps,
					recommendedCfg
				}));
				const workflows = (await this.workflows(catalogModels, signal)).map(({ id, label, source, available, unavailableReason, recommendedSteps, recommendedCfg, supportsNegativePrompt, modelId, starterPrompt, width, height, batchSize, task, output }) => ({
					id,
					label,
					source,
					available,
					unavailableReason,
					recommendedSteps,
					recommendedCfg,
					supportsNegativePrompt,
					modelId,
					starterPrompt,
					width,
					height,
					batchSize,
					task,
					output
				}));
				return {
					reachable: true,
					baseUrl: this.config.baseUrl,
					models,
					workflows,
					libraryAvailable: this.config.outputDirectory !== null,
					error: null
				};
			} catch (error) {
				return {
					reachable: false,
					baseUrl: this.config.baseUrl,
					models: [],
					workflows: [],
					libraryAvailable: this.config.outputDirectory !== null,
					error: messageOf(error)
				};
			}
		}
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
		async comfyServerPids() {
			if (process.platform !== "win32") return [];
			const { stdout } = await execFileAsync("powershell.exe", [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -match 'main\\.py' -and $_.CommandLine -match '${new URL(this.config.baseUrl).port}' } | Select-Object -ExpandProperty ProcessId | ConvertTo-Json -Compress`
			], { timeout: 2e4 });
			const trimmed = stdout.trim();
			if (trimmed.length === 0) return [];
			const parsed = JSON.parse(trimmed);
			return (Array.isArray(parsed) ? parsed : [parsed]).filter((id) => typeof id === "number");
		}
		/**
		* Whether ComfyUI answers on its HTTP endpoint.
		* @param signal - caller cancellation for the probe.
		* @returns true when `/system_stats` answers.
		*/
		async serverAnswers(signal) {
			try {
				return (await fetch(`${this.config.baseUrl}/system_stats`, { signal: signal ?? AbortSignal.timeout(5e3) })).ok;
			} catch {
				return false;
			}
		}
		/**
		* Validate the configured start paths.
		* @returns the interpreter and working directory, or why they are unusable.
		*/
		async serverPaths() {
			const python = this.config.serverPythonPath;
			const cwd = this.config.serverDirectory;
			if (python === null || cwd === null) return { error: "Set the ComfyUI interpreter and server directory to control the server from this panel." };
			try {
				await stat(python);
			} catch {
				return { error: `ComfyUI interpreter not found: ${python}` };
			}
			try {
				await stat(join(cwd, "main.py"));
			} catch {
				return { error: `main.py not found under ${cwd}` };
			}
			return {
				python,
				cwd
			};
		}
		/**
		* Start ComfyUI, detached from this process so it outlives the application.
		* @param signal - caller cancellation for the readiness probe.
		* @returns whether it answered, and what happened.
		*/
		async startServer(signal) {
			if (await this.serverAnswers(signal)) return {
				running: true,
				detail: "ComfyUI was already running."
			};
			const paths = await this.serverPaths();
			if ("error" in paths) return {
				running: false,
				detail: paths.error
			};
			const port = new URL(this.config.baseUrl).port;
			spawn(paths.python, [
				"main.py",
				"--port",
				port,
				"--listen",
				"127.0.0.1",
				"--disable-auto-launch"
			], {
				cwd: paths.cwd,
				detached: true,
				stdio: "ignore",
				windowsHide: true
			}).unref();
			const deadline = Date.now() + this.config.serverStartTimeoutMs;
			while (Date.now() < deadline) {
				if (await this.serverAnswers(signal)) return {
					running: true,
					detail: "ComfyUI started."
				};
				await new Promise((done) => setTimeout(done, 1e3));
			}
			const seconds = Math.round(this.config.serverStartTimeoutMs / 1e3);
			return {
				running: false,
				detail: `ComfyUI did not answer within ${String(seconds)}s.`
			};
		}
		/**
		* Stop ComfyUI.
		* @param signal - caller cancellation for the final state probe.
		* @returns whether it still answers, and what happened.
		*/
		async stopServer(signal) {
			const pids = await this.comfyServerPids();
			if (pids.length === 0) return {
				running: await this.serverAnswers(signal),
				detail: "No ComfyUI process was running."
			};
			for (const pid of pids) process.kill(pid);
			for (let waited = 0; waited < 3e4; waited += 500) {
				if ((await this.comfyServerPids()).length === 0) break;
				await new Promise((done) => setTimeout(done, 500));
			}
			const running = await this.serverAnswers(signal);
			const count = `${String(pids.length)} process${pids.length === 1 ? "" : "es"}`;
			return {
				running,
				detail: running ? "ComfyUI did not stop." : `Stopped ComfyUI (${count}).`
			};
		}
		/**
		* Restart ComfyUI: stop, then start again.
		* @param signal - caller cancellation for the readiness probe.
		* @returns whether it answered, and what happened.
		*/
		async restartServer(signal) {
			const stopped = await this.stopServer(signal);
			if (stopped.running) return stopped;
			return await this.startServer(signal);
		}
		/** Submit a validated catalog workflow to the configured ComfyUI server.
		* @param request - Prompt, workflow, model, and generation settings.
		* @param signal - Cancels discovery and submission requests.
		* @returns The submitted prompt identifier and resolved seed.
		*/
		async generate(request, signal) {
			const prompt = request.prompt.trim();
			if (prompt.length === 0) throw new Error("Describe the image before generating it");
			if (prompt.length > 8e3 || request.negativePrompt.length > 8e3) throw new Error("Prompt text is too long");
			integer("width", request.width, 64, 4096);
			integer("height", request.height, 64, 4096);
			if (request.width % 8 !== 0 || request.height % 8 !== 0) throw new Error("width and height must be multiples of 8");
			integer("steps", request.steps, 1, 150);
			integer("batchSize", request.batchSize, 1, 8);
			if (!Number.isFinite(request.cfg) || request.cfg < 0 || request.cfg > 30) throw new Error("cfg must be from 0 to 30");
			if (!Number.isFinite(request.denoise) || request.denoise < .05 || request.denoise > 1) throw new Error("Image change strength must be from 0.05 to 1");
			const available = await this.models(signal);
			const workflows = await this.workflows(available, signal);
			const workflowChoice = request.workflow === null ? workflows.find((item) => item.available) : workflows.find((item) => item.id === request.workflow && item.available);
			if (workflowChoice === void 0) throw new Error("ComfyUI has no compatible image workflow available");
			const seed = request.seed ?? randomInt(0, 2147483647);
			integer("seed", seed, 0, Number.MAX_SAFE_INTEGER);
			const normalizedRequest = {
				...request,
				prompt
			};
			let workflow;
			if (workflowChoice.task === "edit" && request.sourceImage === null) throw new Error("Select a source image for this workflow");
			if (workflowChoice.task === "edit" && workflowChoice.source === "built-in") {
				const model = available.find((item) => item.id === workflowChoice.modelId);
				if (model?.kind !== "flux2-klein" || request.sourceImage === null) throw new Error("Select a source image for Flux reference editing");
				workflow = fluxReferenceWorkflow(normalizedRequest, model, this.annotatedSourceImage(request.sourceImage), seed, this.config.outputPrefix);
			} else if (workflowChoice.source === "saved" && workflowChoice.saved !== void 0) workflow = savedTextToImageWorkflow(workflowChoice.saved, normalizedRequest, seed, this.config.outputPrefix);
			else {
				const model = request.model === null ? available[0] : available.find((item) => item.id === request.model);
				if (model === void 0 || model.kind === "flux2-klein") throw new Error("Select a text-to-image model for this workflow");
				workflow = model.kind === "checkpoint" ? basicTextToImageWorkflow(normalizedRequest, model.checkpoint, seed, this.config.outputPrefix) : zImageTurboWorkflow(normalizedRequest, {
					diffusionModel: model.diffusionModel,
					textEncoder: model.textEncoder,
					vae: model.vae
				}, seed, this.config.outputPrefix);
			}
			if (request.sourceImage !== null && !(workflowChoice.task === "edit" && workflowChoice.source === "built-in")) {
				const filename = this.annotatedSourceImage(request.sourceImage);
				if (workflowChoice.source !== "saved" || !injectSourceImage(workflow, filename)) imageToImageWorkflow(workflow, filename, request.denoise);
			}
			if (request.videoSettings !== void 0) applyVideoSettings(workflow, request.videoSettings, this.config.maxVideoSeconds);
			const response = await this.request("/prompt", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					prompt: workflow,
					client_id: `aryaai-${randomUUID()}`,
					extra_data: { aryaai: {
						workflowId: workflowChoice.id,
						workflowLabel: workflowChoice.label,
						sourceImage: request.sourceImage,
						width: request.width,
						height: request.height
					} }
				})
			}, signal);
			if (!response.ok) throw new Error(`ComfyUI rejected the workflow with HTTP ${response.status}: ${await response.text()}`);
			const body = await response.json();
			if (!isRecord(body) || typeof body.prompt_id !== "string") throw new Error("ComfyUI returned no prompt id");
			return {
				promptId: body.prompt_id,
				seed
			};
		}
		/** Assemble retained output clips into a new film without altering the originals.
		* @param request - Ordered local clips, trims, transitions and optional captions.
		* @param signal - Cancels probing and encoding.
		* @returns Completed film reference in the local media library.
		*/
		async assemble(request, signal) {
			const runtime = this.ctx.get("subprocess");
			if (runtime === void 0 || this.config.ffmpegPath === null || this.config.outputDirectory === null) throw new Error("Film assembly requires a local subprocess provider, ffmpegPath and outputDirectory");
			const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(this.config.filmTimeoutMs)]);
			return assembleFilm(runtime, this.config.ffmpegPath, this.config.outputDirectory, request, boundedSignal, {
				maxSeconds: this.config.maxFilmSeconds,
				crf: this.config.filmCrf,
				preset: this.config.filmEncoderPreset
			});
		}
		/** Read completed and failed generations from ComfyUI history.
		* @param request - Maximum number of history entries.
		* @param signal - Cancellation signal for the Remote call.
		* @returns Recent completed and failed generations.
		*/
		async history(request, signal) {
			const limit = integer("limit", request.limit, 1, 100);
			const response = await this.request(`/history?max_items=${limit}`, {}, signal);
			if (!response.ok) throw new Error(`ComfyUI history returned HTTP ${response.status}`);
			const value = await response.json();
			const identities = this.historyWorkflowIdentities(await this.savedCatalog());
			signal.throwIfAborted();
			return generationsOf(value, identities).slice(0, limit);
		}
		/** Read an output image or video through the Host so browser CORS never reaches ComfyUI.
		* @param request - ComfyUI image reference.
		* @param signal - Cancellation signal for the Remote call.
		* @returns Media MIME type and base64 bytes, bounded to 50 MB.
		*/
		async image(request, signal) {
			if (![
				"input",
				"output",
				"temp"
			].includes(request.type)) throw new Error("Unsupported ComfyUI image type");
			const query = new URLSearchParams({
				filename: request.filename,
				subfolder: request.subfolder,
				type: request.type
			});
			const response = await this.request(`/view?${query}`, {}, signal);
			if (!response.ok) throw new Error(`ComfyUI image returned HTTP ${response.status}`);
			const bytes = Buffer.from(await response.arrayBuffer());
			if (bytes.byteLength > 50 * 1024 * 1024) throw new Error("ComfyUI image is larger than 50 MB");
			return {
				contentType: response.headers.get("content-type") ?? "image/png",
				base64: bytes.toString("base64")
			};
		}
		/** Browse files retained on disk even when ComfyUI has pruned their history.
		* @param request - Page offset and size.
		* @param signal - Cancellation signal for the Remote call.
		* @returns Newest output files and total file count.
		*/
		async library(request, signal) {
			const root = this.config.outputDirectory;
			if (root === null) throw new Error("Configure outputDirectory to browse local ComfyUI images");
			const offset = integer("offset", request.offset, 0, Number.MAX_SAFE_INTEGER);
			const limit = integer("limit", request.limit, 1, 100);
			const images = [];
			const directories = [""];
			for (let subfolder = directories.pop(); subfolder !== void 0; subfolder = directories.pop()) {
				signal.throwIfAborted();
				for (const entry of await readdir(join(root, subfolder), { withFileTypes: true })) {
					if (entry.isSymbolicLink()) continue;
					const child = join(subfolder, entry.name);
					if (entry.isDirectory()) directories.push(child);
					else if (entry.isFile() && COMFY_MEDIA_EXTENSIONS.includes(extname(entry.name).toLowerCase())) {
						const info = await stat(join(root, child));
						images.push({
							image: {
								filename: entry.name,
								subfolder,
								type: "output"
							},
							modifiedAt: info.mtimeMs,
							bytes: info.size
						});
					}
				}
			}
			images.sort((left, right) => right.modifiedAt - left.modifiedAt);
			return {
				images: images.slice(offset, offset + limit),
				total: images.length
			};
		}
		/** Delete one local output file without deleting other images from its generation.
		* @param request - Output image under the configured directory.
		* @param signal - Cancellation signal for the Remote call.
		*/
		async deleteImage(request, signal) {
			signal.throwIfAborted();
			const root = this.config.outputDirectory;
			if (root === null) throw new Error("Configure outputDirectory to browse local ComfyUI images");
			const file = await localMedia(root, request);
			signal.throwIfAborted();
			await unlink(file.path);
		}
		/** Delete selected local images and videos, reporting each failure independently.
		* @param request - One to 100 local output references.
		* @param signal - Cancellation signal for the Remote call.
		* @returns References deleted and references that failed.
		*/
		async deleteImages(request, signal) {
			if (request.images.length < 1 || request.images.length > 100) throw new Error("Invalid media selection");
			const root = this.config.outputDirectory;
			if (root === null) throw new Error("Configure outputDirectory to delete local ComfyUI files");
			const unique = /* @__PURE__ */ new Map();
			for (const image of request.images) unique.set(`${image.subfolder}\0${image.filename}`, image);
			const deleted = [];
			const failed = [];
			for (const image of unique.values()) {
				signal.throwIfAborted();
				try {
					await unlink((await localMedia(root, image)).path);
					deleted.push(image);
				} catch (error) {
					failed.push({
						image,
						message: messageOf(error)
					});
				}
			}
			return {
				deleted,
				failed
			};
		}
		/** Remove one completed generation from ComfyUI history.
		* @param request - Prompt identifier to remove.
		* @param signal - Cancellation signal for the Remote call.
		*/
		async deleteGeneration(request, signal) {
			const promptId = request.promptId.trim();
			if (promptId.length === 0 || promptId.length > 200) throw new Error("Invalid ComfyUI prompt id");
			const response = await this.request("/history", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ delete: [promptId] })
			}, signal);
			if (!response.ok) throw new Error(`ComfyUI history returned HTTP ${response.status}`);
		}
		/** Remove a queued prompt and interrupt the current execution when it is running.
		* @param request - Prompt identifier to cancel.
		* @param signal - Cancellation signal for the Remote call.
		*/
		async cancel(request, signal) {
			const queue = await this.request("/queue", {}, signal);
			if (!queue.ok) throw new Error(`ComfyUI queue returned HTTP ${queue.status}`);
			const snapshot = await queue.json();
			const running = isRecord(snapshot) && Array.isArray(snapshot.queue_running) ? snapshot.queue_running.some((item) => Array.isArray(item) && item[1] === request.promptId) : false;
			const queued = await this.request("/queue", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ delete: [request.promptId] })
			}, signal);
			if (!queued.ok) throw new Error(`ComfyUI queue returned HTTP ${queued.status}`);
			if (running) {
				const interrupted = await this.request("/interrupt", { method: "POST" }, signal);
				if (!interrupted.ok) throw new Error(`ComfyUI interrupt returned HTTP ${interrupted.status}`);
			}
		}
	};
})();
//#endregion
export { ComfyImagesController, ComfyImagesController as default, absentCheckpoint, basicTextToImageWorkflow, generationsOf, imageToImageWorkflow, injectSourceImage, resolveSwitches, savedSamplerSettings, savedTextToImageWorkflow, savedWorkflowOf, savedWorkflowOutput, savedWorkflowTakesPrompt, savedWorkflowTask, zImageTurboWorkflow };
