---
description: "本地 ComfyUI 图像生成、历史记录、输出图像和取消操作的类型化 Remote 边界。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-comfyui-controller

[English](README.md) | 中文

## 概述

在 AryaAI WebUI 或桌面版中，通过本地 ComfyUI 服务器生成和编辑图像。Host 发现已安装的模型和保存的工作流，保留受支持工作流的采样器设置，并向 Images 页面提供起始提示词和画布设置。它读取输出图像及最近历史记录、取消任务；配置 `outputDirectory` 后还可列出或删除保留的文件。Web 应用包通过 `ARYAAI_COMFYUI_OUTPUT_DIR` 读取该目录。浏览器代码经由 Host 访问 ComfyUI，无需配置浏览器 CORS。

## 模型体验

无，因为这个包不注册工具或提示内容，内置的 ComfyUI MCP 服务器负责代理可见的工作流操作。

#### KV Cache 影响

无；这个 Host 服务不会组装或发送提供商请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **保存工作流的编译覆盖受支持的文生图节点集** — 使用其他拆分模型系列、ControlNet、LoRA、视频、自定义节点和三维图的工作流仍会显示，但在 Images 页面中不可用。
- **历史记录只识别控制器的图结构** — 任意原生 ComfyUI 和 MCP 工作流仍保留在 ComfyUI 历史记录中，但不会投影到 Images 图库。
- **图像读取以 base64 缓冲** — 可移植的 Remote 载荷比流式传输占用更多内存，并拒绝大于 50 MB 的文件。
- **历史记录与本地文件相互独立** — 删除最近生成会移除 ComfyUI 历史记录；删除本地图像只移除对应的输出文件。后者需要配置输出目录。
- **每个 Host 配置一个 ComfyUI 端点** — 要在多个运行中的 ComfyUI 服务间切换，需要修改 `ARYAAI_COMFYUI_URL` 并重启 AryaAI。

控制器只拥有一个 Remote 命名空间，不存在可以独立分叉的投影，因此不发布 invariant companion。
