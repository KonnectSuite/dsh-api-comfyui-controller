---
description: "The typed Remote boundary for local ComfyUI image generation, history, output images, and cancellation."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-comfyui-controller

English | [中文](README.zh.md)

## Summary

Generate and edit images from AryaAI through a local ComfyUI server. The Host discovers installed models and saved workflows and exposes their sampler, prompt, and canvas settings. With `outputDirectory` configured it reads recent history and lists retained images and videos. Authenticated routes stream local media with video byte ranges and export up to 100 files as a ZIP; a Remote operation reports per-file batch deletion results. A profile naming `serverPythonPath` and `serverDirectory` lets the Images panel start, stop, and restart that server, selecting only ComfyUI's own process.

## Table of Contents

- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="understand-the-implementation"></a>

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Recognized history graphs include image, GIF and video output groups, including native `SaveVideo` and `VHS_VideoCombine` graphs without `SaveImage`. Wan video latents supply canvas dimensions, and advanced samplers supply run metadata. Duplicate file references appear once; Recent runs can play video through the bounded media read, while the local library streams larger files with single byte ranges, including suffixes and open ends. Ranges beyond EOF are clipped; unsatisfiable ranges return 416 with the file length. HEAD ignores Range and returns full-file metadata. Unsupported units and multiple ranges return the complete file.

Saved image-to-video and reference-edit graphs retain their own model and conditioning connections. The selected source fills the graph's image loader; built-in Flux editing uses its dedicated graph. Wan canvas overrides preserve the saved frame count.

Qwen Image 2.1 saved graphs accept composer prompts through their combined positive/negative encoder and retain reference-image connections, cache settings, and explicit sigma schedules. Turbo graphs keep their saved eight-step schedule; the step control does not replace `ManualSigmas`. Recent runs identify Qwen and retain the edit reference.

LTX Director saved graphs accept the composer's global prompt and canvas dimensions while retaining timeline segments, reference guides, audio settings, frame count, and sigma schedules. Edit timeline tracks and reference media in ComfyUI before submitting the saved workflow from Arya; the composer does not edit Director's timeline. Recent runs retain the global prompt and video dimensions.

Generation requests may provide `videoSettings` with scene duration, frame rate and Director prompt segments. Supported LTX and Wan latents receive an aligned frame count; unsupported graphs reject timing overrides. Segment durations must total the scene duration. Director accepts an optional initial image through native LTX reference conditioning while retaining its saved reference tracks. `maxVideoSeconds` caps individual scenes (default 30 seconds).

The `assemble` operation uses a configured `ffmpegPath` and a local subprocess provider to combine retained output clips into a new MP4. It supports ordered trims, cuts or crossfades, scene audio, silence for silent clips and optional selectable caption tracks. It refuses external paths and preserves source files. Cancellation removes incomplete outputs after the encoder exits. `filmTimeoutMs` defaults to 600000 milliseconds. Assembly does not synthesize narration, replace soundtracks or burn captions into frames.

</details>

-----

<a id="model-experience"></a>

## Model Experience

None, as this package registers no tools or prompt content and the bundled ComfyUI MCP server owns agent-visible workflow operations.

#### KV Cache effect

None; this Host service never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Saved workflow compilation covers a listed node set** — reference editing, advanced Flux 2 sampling, LoRA, IPAdapter reference conditioning, upscaling, subgraph instances and video writers are submitted; ControlNet application nodes and other unlisted classes stay visible but unavailable in the Images page.
- **A graph the server cannot execute is unavailable** — ComfyUI frontend logic nodes such as `ComfySwitchNode` are evaluated in the browser and never reach the server, so a workflow using one reports that reason rather than a missing install.
- **A saved graph must state a prompt and a sampler** — one with no text encoder, such as a pure upscaler, or none at all, such as frame interpolation, is not a generation graph and stays unavailable.
- **History recognizes the controller's graph shape** — arbitrary native ComfyUI and MCP workflows stay in ComfyUI history but are not projected into the Images gallery.
- **Recent-run reads use base64** — the portable Remote payload costs more memory than streaming, and files larger than 50 MB are rejected. Local library media uses streaming routes instead.
- **History and local files are separate** — deleting a recent run removes its ComfyUI history record; deleting a local image removes only that output file. The latter requires a configured output directory.
- **One ComfyUI endpoint is configured per Host** — switching between multiple running ComfyUI servers requires changing `ARYAAI_COMFYUI_URL` and restarting AryaAI.

<a id="dev-note"></a>

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

No invariant companion is published because the controller owns one Remote namespace and has no independent projection that can diverge from it.
