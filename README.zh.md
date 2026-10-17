---
description: "本地 ComfyUI 图像生成、历史记录、输出图像和取消操作的类型化 Remote 边界。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-comfyui-controller

[English](README.md) | 中文

## 概述

在 AryaAI 中，通过本地 ComfyUI 服务器生成和编辑图像。Host 发现已安装的模型和保存的工作流，并提供采样器、提示词和画布设置。配置 `outputDirectory` 后，它会读取最近历史记录并列出保留的图像和视频。经过身份验证的路由以流式方式传输本地媒体，支持视频字节范围请求，并将最多 100 个文件导出为 ZIP；Remote 操作分别报告批量删除结果。若 profile 通过 `serverPythonPath` 和 `serverDirectory` 指定了解释器与代码目录，Images 面板即可启动、停止和重启该服务器，且只选中 ComfyUI 自身的进程。

## 目录

- [了解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="understand-the-implementation"></a>

## 了解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

受识别的历史工作流包含图像、GIF 和视频输出组，包括没有 `SaveImage` 的原生 `SaveVideo` 和 `VHS_VideoCombine` 工作流。Wan 视频潜空间节点提供画布尺寸，高级采样器提供运行元数据。同一个文件引用只显示一次；最近生成可通过有大小限制的媒体读取播放视频，本地媒体库则使用单一字节范围流式传输播放更大的文件，包括后缀范围和开放结束位置。超出文件末尾的结束位置会被截断；无法满足的范围返回 416 和文件长度。HEAD 忽略 Range 并返回完整文件元数据。不受支持的单位和多个范围返回完整文件。

保存的图生视频和参考编辑工作流保留自身模型与条件连接。所选图片填充工作流的图像加载节点；内置 Flux 编辑使用专用工作流。Wan 的画布尺寸修改保留保存的帧数。

Qwen Image 2.1 保存的工作流通过合并的正向与负向编码节点接收输入提示词，并保留参考图片连接、缓存设置和显式 sigma 调度。Turbo 工作流保留保存的八步调度；步数控件不会替换 `ManualSigmas`。最近生成记录识别 Qwen 并保留编辑参考图片。

LTX Director 保存的工作流接收输入框的全局提示词与画布尺寸，并保留时间轴片段、参考引导、音频设置、帧数和 sigma 调度。在 Arya 中提交保存的工作流之前，请在 ComfyUI 中编辑时间轴轨道与参考媒体；输入框不会编辑 Director 时间轴。最近生成记录保留全局提示词与视频尺寸。

生成请求可通过 `videoSettings` 指定场景时长、帧率和 Director 提示词片段。受支持的 LTX 与 Wan 潜空间节点接收对齐后的帧数；不支持的工作流拒绝时间覆盖。片段时长之和必须等于场景时长。Director 通过原生 LTX 参考条件接收可选起始图片，同时保留保存的参考轨道。`maxVideoSeconds` 限制单个场景，默认 30 秒。

`assemble` 操作使用配置的 `ffmpegPath` 与本地子进程提供者，将保留的输出片段组合为新的 MP4。它支持顺序裁剪、硬切或交叉淡化、场景音频、无声片段的静音填充和可选字幕轨道。它拒绝外部路径并保留源文件。取消后，编码器退出才删除未完成输出。`filmTimeoutMs` 默认 600000 毫秒。组合不会合成旁白、替换配乐或将字幕烧录进画面。

</details>

-----

<a id="model-experience"></a>

## 模型体验

无，因为这个包不注册工具或提示内容，内置的 ComfyUI MCP 服务器负责代理可见的工作流操作。

#### KV Cache 影响

无；这个 Host 服务不会组装或发送提供商请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **保存工作流的编译覆盖一份已列出的节点集** — 参考编辑、Flux 2 高级采样、LoRA、IPAdapter 参考条件、放大、子图实例和视频写入节点都可以提交；ControlNet 应用节点和其他未列出的类仍会显示，但在 Images 页面中不可用。
- **服务器无法执行的图不可用** — ComfyUI 前端逻辑节点（例如 `ComfySwitchNode`）在浏览器中求值，从不发送到服务器，因此使用它们的工作流会报告这一原因，而不是“缺少安装”。
- **保存的图必须声明提示词和采样器** — 没有文本编码器的图（例如纯放大）或没有采样器的图（例如帧插值）不是生成图，仍不可用。
- **历史记录只识别控制器的图结构** — 任意原生 ComfyUI 和 MCP 工作流仍保留在 ComfyUI 历史记录中，但不会投影到 Images 图库。
- **最近生成记录的读取使用 base64** — 可移植的 Remote 载荷比流式传输占用更多内存，并拒绝大于 50 MB 的文件。本地媒体库则使用流式路由。
- **历史记录与本地文件相互独立** — 删除最近生成会移除 ComfyUI 历史记录；删除本地图像只移除对应的输出文件。后者需要配置输出目录。
- **每个 Host 配置一个 ComfyUI 端点** — 要在多个运行中的 ComfyUI 服务间切换，需要修改 `ARYAAI_COMFYUI_URL` 并重启 AryaAI。

<a id="dev-note"></a>

### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>

控制器只拥有一个 Remote 命名空间，不存在可以独立分叉的投影，因此不发布 invariant companion。
