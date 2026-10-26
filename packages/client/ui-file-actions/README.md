---
description: "Download and save original files without changing their encoding"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-file-actions

English | [中文](README.zh.md)

## Summary

Download and save original files without changing their encoding. Copy images as pasteable PNG content while retaining the original format for saves. Desktop can reveal a successfully saved file; a browser download never claims to know its local destination.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Web application bundle mounts this Client plugin without configuration fields. Consumers import `/client` types and inject `fileActions`. Desktop supplies an optional trusted-frame adapter for Chromium downloads and cross-origin clipboard reads. Both Desktop and Web write PNG images through the browser Clipboard API.

### Original content

Pass an original URL, optional filename and MIME, or an authorized `read(signal)` callback for Session-owned files. Saves preserve bytes. MIME determines the suffix when it conflicts with the supplied name; compatible and unknown suffixes remain. Suggested names exclude platform-reserved characters and device names and fit a 255-byte filename.

`save(source, mode)` returns `cancelled`, `requested` for a browser download, or `saved` after a native or browser-picker write completes. Browser save-as requires the browser file picker and is disabled when unavailable. A regular browser download reports only that the download was requested. It returns no local reference. Native saves return an opaque ID, which `savedFile(url)` remembers for reveal. IDs are scoped to the originating window and expire on reload or close.

Filename and MIME normalization reuse the file-drag utility, so saving and dragging retain the same original format and filename policy.

Response MIME takes precedence over a suggested filename or media type when naming downloaded originals. Image copying decodes the captured original into PNG for clipboard interoperability. `copyImageAt` addresses the current pixels at a coordinate, provides no completion result, and cannot bind the image captured by a card or keyboard menu. Copying therefore reads the captured source even when an image moves, changes, or is covered by the menu. Downloads and save-as never use that conversion. The plugin contributes file and image copy, download, save-as, saved-file reveal, and localized feedback through `ctx.menus`, independently of `ui-open-in-app`. Other service callers own their feedback. Rejected reads do not start writes. Desktop downloads use `webContents.downloadURL` and `DownloadItem`: direct originals remain URLs; authorized Session reads become temporary Blob URLs retained until completion. Response MIME names the original file, downloads reserve distinct paths, and save-as uses Chromium’s save dialog and replacement behavior. Only the completed event returns a saved reference; cancellation is silent and interruption reports failure. Navigation or window closure cancels pending downloads. Plugin disposal aborts browser reads, discards references, and releases object URLs.

Desktop downloads follow Chromium’s session and network policy. Only clipboard fallback reads use the bounded credential-free HTTP(S) reader, rejecting the application Host at every redirect. Other destinations use the machine’s network policy. Ordinary Web reads require the remote server to allow browser CORS; a denied response produces failure feedback without starting a save.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client selects browser or native operations once per plugin lifetime. [Client implementation](src/client/files.ts) owns MIME normalization and clipboard conversion. [Desktop adapter](../../../apps/desktop/src/file-actions.ts) validates IPC inputs, keeps file paths in the main process, and revalidates the trusted window after asynchronous work.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Context menus](../ui-context-menu/README.md) — contributed actions.
- [Workspace files](../../api/workspace-files/README.md) — authorized Session reads.
- [Desktop](../../../apps/desktop/README.md) — native operation settings.

-----

<a id="model-experience"></a>
## Model Experience

None, as explicit user file and clipboard operations do not construct model input.

#### KV Cache effect

None; saving and copying do not change model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Web save-as depends on browser picker support; clipboard operations depend on browser permission and image decoding support.
- Native downloads have a configurable startup deadline; once Chromium accepts the download, its completion or cancellation ends the operation; HTTP(S) clipboard reads omit credentials and stop on window navigation, close, timeout, or the configured byte limit.
- Browser downloads have no reveal action unless a separate, actual Host file is known.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
