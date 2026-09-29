import { randomInt, randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
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
/** Build the standard-node text-to-image graph shared by the controller and its tests. */
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
/** Build the official standard-node Z-Image Turbo text-to-image graph. */
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
	SaveImage: ["filename_prefix"]
};
function savedWorkflowOf(value) {
	if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.links)) return void 0;
	const nodes = [];
	for (const raw of value.nodes) {
		if (!isRecord(raw) || typeof raw.id !== "number" || typeof raw.type !== "string") return void 0;
		const inputs = Array.isArray(raw.inputs) ? raw.inputs.flatMap((input) => {
			if (!isRecord(input) || typeof input.name !== "string") return [];
			return [{
				name: input.name,
				link: typeof input.link === "number" ? input.link : null
			}];
		}) : [];
		nodes.push({
			id: raw.id,
			type: raw.type,
			mode: typeof raw.mode === "number" ? raw.mode : 0,
			inputs,
			widgetsValues: Array.isArray(raw.widgets_values) ? raw.widgets_values : []
		});
	}
	return {
		nodes,
		links: value.links.filter(Array.isArray)
	};
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
	const names = SAVED_NODE_WIDGET_INPUTS[node.type];
	if (names === void 0) throw new Error(`Unsupported workflow node: ${node.type}`);
	return Object.fromEntries(names.flatMap((name, index) => node.widgetsValues[index] === void 0 ? [] : [[name, node.widgetsValues[index]]]));
}
/** Convert one supported ComfyUI saved workflow into an API prompt graph. */
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
		} else if (node.type === "EmptyLatentImage" || node.type === "EmptySD3LatentImage") Object.assign(inputs, {
			width: request.width,
			height: request.height,
			batch_size: request.batchSize
		});
		else if (node.type === "KSampler") Object.assign(inputs, {
			seed,
			steps: request.steps,
			cfg: request.cfg
		});
		else if (node.type === "SaveImage") inputs.filename_prefix = prefix;
		graph[String(node.id)] = {
			class_type: node.type,
			inputs
		};
	}
	if (!promptAssigned || nodeOf(graph, "KSampler") === void 0 || nodeOf(graph, "SaveImage") === void 0) throw new Error("Workflow is not a supported text-to-image graph");
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
		if (!isRecord(output) || !Array.isArray(output.images)) continue;
		for (const image of output.images) {
			if (!isRecord(image) || typeof image.filename !== "string") continue;
			images.push({
				filename: image.filename,
				subfolder: typeof image.subfolder === "string" ? image.subfolder : "",
				type: typeof image.type === "string" ? image.type : "output"
			});
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
	const prefixes = Object.values(graph).flatMap((node) => node.class_type === "SaveImage" && typeof node.inputs.filename_prefix === "string" ? [node.inputs.filename_prefix] : []);
	const prefixMatch = identities.find((identity) => identity.outputPrefixes.some((prefix) => prefixes.includes(prefix)));
	const fingerprintMatches = identities.filter((identity) => identity.fingerprint === fingerprint);
	const matched = prefixMatch ?? (fingerprintMatches.length === 1 ? fingerprintMatches[0] : void 0);
	if (matched !== void 0) return {
		id: matched.id,
		label: matched.label
	};
	return nodeOf(graph, "UNETLoader") === void 0 ? {
		id: null,
		label: "Custom checkpoint workflow"
	} : {
		id: null,
		label: "Custom Z-Image workflow"
	};
}
function generationsOf(value, identities = []) {
	if (!isRecord(value)) return [];
	const generations = [];
	for (const [promptId, raw] of Object.entries(value).reverse()) {
		if (!isRecord(raw)) continue;
		const graph = workflowOf(raw.prompt);
		if (graph === void 0 || nodeOf(graph, "SaveImage") === void 0) continue;
		const status = isRecord(raw.status) ? raw.status : void 0;
		const checkpoint = nodeOf(graph, "CheckpointLoaderSimple");
		const diffusion = nodeOf(graph, "UNETLoader");
		const positive = nodeOf(graph, "CLIPTextEncode");
		const negative = Object.entries(graph).filter(([, node]) => node.class_type === "CLIPTextEncode")[1];
		const latent = nodeOf(graph, checkpoint === void 0 ? "EmptySD3LatentImage" : "EmptyLatentImage");
		const sampler = nodeOf(graph, "KSampler");
		if (positive === void 0 || latent === void 0 || sampler === void 0) continue;
		const model = checkpoint === void 0 ? `z-image-turbo:${encodeURIComponent(stringInput(graph, diffusion?.[0] ?? "", "unet_name"))}` : `checkpoint:${encodeURIComponent(stringInput(graph, checkpoint[0], "ckpt_name"))}`;
		const modelLabel = checkpoint === void 0 ? `Z-Image Turbo · ${stringInput(graph, diffusion?.[0] ?? "", "unet_name")}` : stringInput(graph, checkpoint[0], "ckpt_name");
		const workflow = workflowMetadataOf(raw.prompt) ?? inferredWorkflow(graph, identities);
		generations.push({
			promptId,
			state: status?.status_str === "error" ? "error" : "complete",
			workflow: "id" in workflow ? workflow.id : null,
			workflowLabel: workflow.label,
			prompt: stringInput(graph, positive[0], "text"),
			negativePrompt: negative === void 0 ? "" : stringInput(graph, negative[0], "text"),
			model,
			modelLabel,
			width: numberInput(graph, latent[0], "width"),
			height: numberInput(graph, latent[0], "height"),
			steps: numberInput(graph, sampler[0], "steps"),
			cfg: numberInput(graph, sampler[0], "cfg"),
			seed: numberInput(graph, sampler[0], "seed"),
			images: imagesOf(raw.outputs)
		});
	}
	return generations;
}
/** Remote controller used by the Images Cordis UI plugin. */
let ComfyImagesController = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _status_decorators;
	let _generate_decorators;
	let _history_decorators;
	let _image_decorators;
	let _deleteGeneration_decorators;
	let _cancel_decorators;
	return class ComfyImagesController extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_status_decorators = [Remote];
			_generate_decorators = [Remote];
			_history_decorators = [Remote];
			_image_decorators = [Remote];
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
			requestTimeoutMs: z.number().step(1).min(1e3).max(3e5).default(3e4)
		});
		config = __runInitializers(this, _instanceExtraInitializers);
		savedCatalogCache;
		constructor(ctx, config = {}) {
			super(ctx, "comfyImagesController", { namespace: "comfyImages" });
			this.config = {
				baseUrl: normalizedBaseUrl(config.baseUrl ?? "http://127.0.0.1:8188"),
				outputPrefix: config.outputPrefix ?? "AryaAI",
				requestTimeoutMs: config.requestTimeoutMs ?? 3e4
			};
		}
		async request(path, init = {}, signal) {
			const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
			const combined = signal === void 0 ? timeout : AbortSignal.any([signal, timeout]);
			return fetch(`${this.config.baseUrl}${path}`, {
				...init,
				signal: combined
			});
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
			return models;
		}
		graphModelAvailable(graph, models) {
			const checkpoint = nodeOf(graph, "CheckpointLoaderSimple");
			if (checkpoint !== void 0) {
				const name = stringInput(graph, checkpoint[0], "ckpt_name");
				return models.some((model) => model.kind === "checkpoint" && model.checkpoint === name);
			}
			const unet = nodeOf(graph, "UNETLoader");
			const clip = nodeOf(graph, "CLIPLoader");
			const vae = nodeOf(graph, "VAELoader");
			if (unet === void 0 || clip === void 0 || vae === void 0) return false;
			return models.some((model) => model.kind === "z-image-turbo" && model.diffusionModel === stringInput(graph, unet[0], "unet_name") && model.textEncoder === stringInput(graph, clip[0], "clip_name") && model.vae === stringInput(graph, vae[0], "vae_name"));
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
					batchSize: 1
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
			const primary = models[0];
			const builtIn = {
				id: "built-in:standard",
				label: primary?.kind === "z-image-turbo" ? "Z-Image Turbo · AryaAI standard" : "AryaAI standard",
				source: "built-in",
				available: primary !== void 0,
				unavailableReason: primary === void 0 ? "No compatible model is installed" : null,
				recommendedSteps: primary?.recommendedSteps ?? 24,
				recommendedCfg: primary?.recommendedCfg ?? 7,
				supportsNegativePrompt: primary?.kind !== "z-image-turbo"
			};
			try {
				const catalog = await this.savedCatalog();
				signal?.throwIfAborted();
				return [...catalog.map(({ name, workflow, error }) => {
					const id = `saved:${encodeURIComponent(name)}`;
					const label = name.replace(/\.json$/iu, "");
					try {
						if (workflow === void 0) throw new Error(error ?? `ComfyUI workflow ${name} is invalid`);
						const values = workflow.nodes.find((node) => node.type === "KSampler")?.widgetsValues ?? [];
						const example = {
							prompt: "compatibility probe",
							negativePrompt: "",
							model: null,
							workflow: id,
							width: 1024,
							height: 1024,
							steps: typeof values[2] === "number" ? values[2] : 24,
							cfg: typeof values[3] === "number" ? values[3] : 7,
							seed: 0,
							batchSize: 1
						};
						const graph = savedTextToImageWorkflow(workflow, example, 0, this.config.outputPrefix);
						const available = this.graphModelAvailable(graph, models);
						return {
							id,
							label,
							source: "saved",
							available,
							unavailableReason: available ? null : "Required model files are not installed",
							recommendedSteps: example.steps,
							recommendedCfg: example.cfg,
							supportsNegativePrompt: workflow.nodes.filter((node) => node.type === "CLIPTextEncode" && node.mode === 0).length > 1,
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
							supportsNegativePrompt: true
						};
					}
				}), builtIn];
			} catch {
				return [builtIn];
			}
		}
		/** Probe ComfyUI and list locally installed model configurations Arya can run. */
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
				const workflows = (await this.workflows(catalogModels, signal)).map(({ id, label, source, available, unavailableReason, recommendedSteps, recommendedCfg, supportsNegativePrompt }) => ({
					id,
					label,
					source,
					available,
					unavailableReason,
					recommendedSteps,
					recommendedCfg,
					supportsNegativePrompt
				}));
				return {
					reachable: true,
					baseUrl: this.config.baseUrl,
					models,
					workflows,
					error: null
				};
			} catch (error) {
				return {
					reachable: false,
					baseUrl: this.config.baseUrl,
					models: [],
					workflows: [],
					error: messageOf(error)
				};
			}
		}
		/** Queue one standard-node text-to-image workflow. */
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
			if (workflowChoice.source === "saved" && workflowChoice.saved !== void 0) workflow = savedTextToImageWorkflow(workflowChoice.saved, normalizedRequest, seed, this.config.outputPrefix);
			else {
				const model = request.model === null ? available[0] : available.find((item) => item.id === request.model);
				if (model === void 0) throw new Error("ComfyUI has no compatible image model available");
				workflow = model.kind === "checkpoint" ? basicTextToImageWorkflow(normalizedRequest, model.checkpoint, seed, this.config.outputPrefix) : zImageTurboWorkflow(normalizedRequest, {
					diffusionModel: model.diffusionModel,
					textEncoder: model.textEncoder,
					vae: model.vae
				}, seed, this.config.outputPrefix);
			}
			const response = await this.request("/prompt", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					prompt: workflow,
					client_id: `aryaai-${randomUUID()}`,
					extra_data: { aryaai: {
						workflowId: workflowChoice.id,
						workflowLabel: workflowChoice.label
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
		/** Read completed and failed generations from ComfyUI history. */
		async history(request, signal) {
			const limit = integer("limit", request.limit, 1, 100);
			const response = await this.request(`/history?max_items=${limit}`, {}, signal);
			if (!response.ok) throw new Error(`ComfyUI history returned HTTP ${response.status}`);
			const value = await response.json();
			const identities = this.historyWorkflowIdentities(await this.savedCatalog());
			signal.throwIfAborted();
			return generationsOf(value, identities).slice(0, limit);
		}
		/** Read one output image through the Host so browser CORS never reaches ComfyUI. */
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
		/** Remove one completed generation from ComfyUI history. */
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
		/** Remove a queued prompt and interrupt the current execution when it is running. */
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
export { ComfyImagesController, ComfyImagesController as default, basicTextToImageWorkflow, generationsOf, savedTextToImageWorkflow, zImageTurboWorkflow };
