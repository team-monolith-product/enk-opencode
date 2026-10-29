import { ConfigExtension } from "@blocksuite/block-std"

// `triggerKeys` is typed as a non-empty array, so the triggers cannot simply be
// dropped. NUL can never arrive from a keystroke or an IME composition, which is
// what both of the widget's input handlers match against.
const NEVER_TYPED = String.fromCharCode(0)

// Disables the linked-doc widget's typing triggers ("@", "[[", "【【"), which is the
// last entry point into linked docs after `patchSlashMenu` and `patchFormatBar`.
// The widget reads `affine:page` config on every access, so supplying it through
// the editor specs overrides the library defaults without touching the widget.
export const LinkedDocConfig = ConfigExtension("affine:page", {
  linkedWidget: { triggerKeys: [NEVER_TYPED] },
})
