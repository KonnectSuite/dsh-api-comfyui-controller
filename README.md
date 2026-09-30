---
description: "The typed Remote boundary for local ComfyUI image generation, history, output images, and cancellation."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-comfyui-controller

English | [中文](README.zh.md)

## Summary

Generate and edit images from AryaAI through a local ComfyUI server in WebUI or Desktop. The Host discovers installed models and saved workflows, retains each supported workflow's sampler choices, and exposes starter prompts and canvas settings to the Images page. It reads output images and recent history, cancels jobs, and lists or deletes retained files when `outputDirectory` is configured. The web-app bundle reads `ARYAAI_COMFYUI_OUTPUT_DIR` for that directory. Browser code reaches ComfyUI through the Host, avoiding browser CORS configuration.

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
