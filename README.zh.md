---
description: "本地 ComfyUI 图像生成、历史记录、输出图像和取消操作的类型化 Remote 边界。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-comfyui-controller

[English](README.md) | 中文

## 概述

这个 Cordis 服务拥有 Images 客户端插件使用的 `comfyImages` Remote 命名空间。Host 探测配置的 ComfyUI 服务，发现本地检查点与 Z-Image Turbo 模型配置，提交相应的标准节点文生图工作流，读取和删除历史记录，读取输出字节，并取消排队或运行中的任务。浏览器代码不会直接连接 ComfyUI，因此 WebUI 和 Electron 使用同一功能且不需要 CORS 配置。

控制器还会读取 ComfyUI 保存的 `workflows` 目录。受支持的标准节点图会根据已安装模型文件进行验证并编译为 API 提示图，同时保留采样器、调度器、模型修补和条件控制选择。

## 模型体验

无，因为这个包不注册工具或提示内容，内置的 ComfyUI MCP 服务器负责代理可见的工作流操作。

#### KV Cache 影响

无；这个 Host 服务不会组装或发送提供商请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **保存工作流的编译覆盖受支持的文生图节点集** — 使用其他拆分模型系列、ControlNet、LoRA、视频、自定义节点和三维图的工作流仍会显示，但在 Images 页面中不可用。
- **历史记录只识别控制器的图结构** — 任意原生 ComfyUI 和 MCP 工作流仍保留在 ComfyUI 历史记录中，但不会投影到 Images 图库。
- **图像读取以 base64 缓冲** — 可移植的 Remote 载荷比流式传输占用更多内存，并拒绝大于 50 MB 的文件。
- **删除图库条目会删除 ComfyUI 历史记录** — ComfyUI 没有提供可移植的输出文件删除端点，因此生成文件仍保留在 ComfyUI 配置的输出文件夹中。
- **每个 Host 配置一个 ComfyUI 端点** — 要在多个运行中的 ComfyUI 服务间切换，需要修改 `ARYAAI_COMFYUI_URL` 并重启 AryaAI。

控制器只拥有一个 Remote 命名空间，不存在可以独立分叉的投影，因此不发布 invariant companion。
