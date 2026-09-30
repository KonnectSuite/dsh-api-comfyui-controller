---
description: "The typed Remote boundary for local ComfyUI image generation, history, output images, and cancellation."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-comfyui-controller

English | [中文](README.zh.md)

## Summary

This Cordis service owns the `comfyImages` Remote namespace used by the Images
client plugin. The Host probes the configured ComfyUI server, discovers local
checkpoint and Z-Image Turbo model configurations, submits the matching
standard-node text-to-image workflow, reads and removes history entries, reads
output bytes, and cancels queued or running work. Browser code never contacts
ComfyUI directly, so the same feature works in WebUI and Electron without CORS
configuration.

The controller also reads ComfyUI's saved `workflows` catalog. Supported
standard-node graphs are validated against the installed model files and
compiled into API prompt graphs while preserving their sampler, scheduler,
model-patching, and conditioning choices.

Saved workflow metadata includes its starter prompt and canvas settings. Image-to-image generation loads an existing ComfyUI output directly and replaces the empty latent with a VAE-encoded image while retaining the selected workflow's sampler. When `outputDirectory` is configured, the Host lists output files independently of ComfyUI history and can delete one selected file after confirmation in the Images page. The web-app bundle reads `ARYAAI_COMFYUI_OUTPUT_DIR` for this setting.

## Model Experience

None, as this package registers no tools or prompt content and the bundled ComfyUI MCP server owns agent-visible workflow operations.

#### KV Cache effect

None; this Host service never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Saved workflow compilation covers the supported text-to-image node set** — workflows using other split-model families, ControlNet, LoRA, video, custom nodes, and three-dimensional graphs remain visible but unavailable in the Images page.
- **History recognizes the controller's graph shape** — arbitrary native ComfyUI and MCP workflows stay in ComfyUI history but are not projected into the Images gallery.
- **Image reads are buffered as base64** — the portable Remote payload costs more memory than streaming, and files larger than 50 MB are rejected.
- **History and local files are separate** — deleting a recent run removes its ComfyUI history record; deleting a local image removes only that output file. The latter requires a configured output directory.
- **One ComfyUI endpoint is configured per Host** — switching between multiple running ComfyUI servers requires changing `ARYAAI_COMFYUI_URL` and restarting AryaAI.

No invariant companion is published because the controller owns one Remote
namespace and has no independent projection that can diverge from it.
