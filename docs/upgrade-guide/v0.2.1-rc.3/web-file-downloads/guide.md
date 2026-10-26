---
kind: upgrade-guide
description: "Custom file-action menus must offer save-as only on Desktop and browser downloads on Web."
---

# File downloads on Web

English | [中文](guide.zh.md)

## Change

The Web file-action service no longer offers save-as through a browser file picker. `canSaveAs` is always false on Web, and `save(source, 'saveAs')` rejects before reading the source. Built-in Web file and image menus offer Download and omit Save as. Desktop saving is unchanged.

## Migration

1. Custom Client menus should include Save as only when `ctx.fileActions.canSaveAs` is true.
2. On Web, call `ctx.fileActions.save(source, 'download')`. The browser handles the original content and suggested filename; a `requested` result means download started, not completed. Do not report a saved local path.
3. Verify that Web file and image menus expose Download without Save as, including browsers that support `showSaveFilePicker`. Verify that Desktop image menus retain both actions. See the [file-action reference](../../../../packages/client/ui-file-actions/README.md) for saved references and feedback ownership.
