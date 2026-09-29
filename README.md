---
description: "The typed Remote boundary for local ComfyUI image generation, history, output images, and cancellation."
kind: "package-reference"
---
<!-- MIRROR NOTICE - added by the mirror, not part of the package. -->

> ### This repository is a mirror, not a standalone build
>
> `@deepseek-ai/dsh-api-comfyui-controller` is a plugin for **AryaAI**, a DeepSeek Harness fork. Its source
> depends on `@deepseek-ai/dsh-*` core packages at workspace version `0.1.7-rc.2`
> through `workspace:*`, and those versions are not published. The releases on npm
> are older (`0.0.1-rc.1`), so `pnpm install` and a build **will not work** in a
> fresh clone of this repository.
>
> To work on it, place this package into an AryaAI checkout at `packages/api/comfyui-controller`.
> This mirror exists so the source and its built output are versioned and reviewable
> in one place.
>
> The built output under `lib/` is committed for reference. It was produced inside
> the AryaAI workspace at `0.1.7-rc.2`.

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

## Model Experience

None, as this package registers no tools or prompt content and the bundled ComfyUI MCP server owns agent-visible workflow operations.

#### KV Cache effect

None; this Host service never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Saved workflow compilation covers the supported text-to-image node set** — workflows using other split-model families, ControlNet, LoRA, video, custom nodes, and three-dimensional graphs remain visible but unavailable in the Images page.
- **History recognizes the controller's graph shape** — arbitrary native ComfyUI and MCP workflows stay in ComfyUI history but are not projected into the Images gallery.
- **Image reads are buffered as base64** — the portable Remote payload costs more memory than streaming, and files larger than 50 MB are rejected.
- **Deleting a gallery entry removes ComfyUI history** — ComfyUI does not expose a portable output-file deletion endpoint, so the generated file remains in ComfyUI's configured output folder.
- **One ComfyUI endpoint is configured per Host** — switching between multiple running ComfyUI servers requires changing `ARYAAI_COMFYUI_URL` and restarting AryaAI.

No invariant companion is published because the controller owns one Remote
namespace and has no independent projection that can diverge from it.
