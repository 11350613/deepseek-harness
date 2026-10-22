---
description: "下载和另存原始文件时保持编码不变"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-file-actions

[English](README.md) | 中文

## 概述

下载和另存原始文件时保持编码不变。图片复制为可粘贴的 PNG 内容，保存则保留原始格式。Desktop 可以显示成功保存的文件位置；浏览器下载不会声称知道其本机目标路径。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Web 应用 bundle 无配置字段地挂载此客户端插件。使用方导入 `/client` 类型并注入 `fileActions`。Desktop 提供可选的可信页面适配器；普通 Web 使用浏览器剪贴板和下载 API。

### 原始内容

传入原始 URL、可选文件名和 MIME；会话文件也可提供经授权的 `read(signal)` 回调。保存保持字节不变。MIME 与文件名冲突时修正后缀；兼容和未知后缀保持不变。建议名称去除平台保留字符和设备名称，并限制在 255 字节以内。

`save(source, mode)` 区分取消与已完成的保存请求。浏览器另存为依赖文件选择器，不支持时禁用。普通浏览器下载仅表示已请求下载，不返回本机引用。原生保存返回不透明 ID，`savedFile(url)` 保存该引用以供定位。ID 仅属于发起窗口，刷新或关闭后失效。

文件名与 MIME 规范化复用文件拖动工具，因此保存与拖动采用相同的原始格式和文件名规则。

图片复制会将原始内容解码为 PNG，保证剪贴板互通。下载与另存为不使用该转换。调用方负责本地化成功与失败提示。读取失败不会开始写入；原生下载独占创建唯一文件名，写入失败时删除残留文件。显式替换先写入同目录临时文件，再重命名。插件释放时取消浏览器读取、清除引用并释放对象 URL。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

客户端在插件生命周期开始时选择浏览器或原生操作。[客户端实现](src/client/files.ts) 管理 MIME 归一化与剪贴板转换。[Desktop 适配器](../../../apps/desktop/src/file-actions.ts) 验证 IPC 输入，在主进程保留文件路径，并在异步操作后重新验证可信窗口。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [右键菜单](../ui-context-menu/README.zh.md) — 操作贡献。
- [工作区文件](../../api/workspace-files/README.zh.md) — 授权会话读取。
- [Desktop](../../../apps/desktop/README.zh.md) — 原生操作设置。

-----

<a id="model-experience"></a>
## 模型体验

无，因为用户主动的文件和剪贴板操作不会构造模型输入。

#### KV 缓存影响

无；保存与复制不改变模型请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- Web 另存为依赖浏览器文件选择器；剪贴板操作依赖浏览器权限和图像解码支持。
- 原生 HTTP(S) 图片读取不携带凭据，窗口导航、关闭、超时或达到配置字节上限时停止。
- 浏览器下载不提供文件定位，除非另有已知、实际存在的 Host 文件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
