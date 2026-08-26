import { onCleanup, onMount } from "solid-js"
import { showToast } from "@opencode-ai/ui/toast"
import { usePrompt, type ContentPart, type ImageAttachmentPart, type Prompt } from "@/context/prompt"
import { useLanguage } from "@/context/language"
import {
  attachmentBudgetParams,
  fitsAttachmentBudget,
  MAX_ATTACHMENT_BYTES,
  type AttachmentUsage,
} from "@/constants/file-picker"
import { uuid } from "@/utils/uuid"
import { getCursorPosition } from "./editor-dom"
import { attachmentMime } from "./files"
import { normalizePaste, pasteMode } from "./paste"

type PromptAttachmentsInput = {
  enabled: () => boolean
  editor: () => HTMLDivElement | undefined
  isDialogActive: () => boolean
  setDraggingType: (type: "image" | "@mention" | null) => void
  focusEditor: () => void
  addPart: (part: ContentPart) => boolean
  /**
   * Stores the bytes server-side and returns the reference url the prompt part carries. Uploading
   * up front is what keeps base64 out of the message part (and out of every client's sync stream);
   * an attachment that cannot be stored is not attached at all.
   */
  upload: (file: File, mime: string) => Promise<string | undefined>
  dropPath?: (path: string) => Promise<boolean> | boolean
  dropFiles?: (files: File[]) => Promise<boolean>
  readClipboardImage?: () => Promise<File | null>
}

/**
 * What the composer currently carries against the per-prompt attachment budget. The doc side counts
 * its image/attachment blocks; here the prompt's own image parts are the equivalent — the two modes
 * never send together, so each counts only its own.
 */
export function attachmentUsage(prompt: Prompt): AttachmentUsage {
  const images = prompt.filter((part): part is ImageAttachmentPart => part.type === "image")
  return {
    count: images.length,
    bytes: images.reduce((total, part) => total + (part.size ?? 0), 0),
  }
}

/**
 * Whether a drag belongs to something that declares its own drop zone (`data-drop-zone`), such as
 * the file explorer's upload area. The listeners below are on the document in the capture phase, so
 * without this check the composer would swallow every drop in the app before the zone sees it.
 */
function ownedByDropZone(event: DragEvent) {
  const target = event.target
  return target instanceof Element && !!target.closest("[data-drop-zone]")
}

export function createPromptAttachments(input: PromptAttachmentsInput) {
  const prompt = usePrompt()
  const language = useLanguage()

  const warn = () => {
    showToast({
      title: language.t("prompt.toast.pasteUnsupported.title"),
      description: language.t("prompt.toast.pasteUnsupported.description"),
    })
  }

  const warnTooLarge = () => {
    showToast({
      title: language.t("prompt.toast.fileTooLarge.title"),
      description: language.t("prompt.toast.fileTooLarge.description"),
    })
  }

  const warnUploadFailed = () => {
    showToast({
      title: language.t("prompt.toast.attachmentUploadFailed.title"),
      description: language.t("prompt.toast.attachmentUploadFailed.description"),
    })
  }

  const warnOverBudget = () => {
    showToast({
      title: language.t("prompt.toast.tooManyAttachments.title"),
      description: language.t("prompt.toast.tooManyAttachments.description", attachmentBudgetParams()),
    })
  }

  // `usage` lets a batch keep its running total across files: the check has to happen before the
  // upload await, so re-reading the prompt per file would let a batch walk past the budget.
  const add = async (file: File, toast = true, usage = attachmentUsage(prompt.current())) => {
    // Guard on file.size (synchronous, no read) before any read so an oversized file
    // never gets pulled into memory and crashes the tab.
    if (file.size > MAX_ATTACHMENT_BYTES) {
      if (toast) warnTooLarge()
      return "size" as const
    }

    const mime = await attachmentMime(file)
    if (!mime) {
      if (toast) warn()
      return "type" as const
    }

    // Checked before the upload so a file that cannot be attached never reaches the asset store.
    if (!fitsAttachmentBudget(usage, file.size)) {
      if (toast) warnOverBudget()
      return "overflow" as const
    }

    const editor = input.editor()
    const url = await input.upload(file, mime)
    if (!url) {
      if (toast) warnUploadFailed()
      return "upload" as const
    }

    usage.count += 1
    usage.bytes += file.size

    const attachment: ImageAttachmentPart = {
      type: "image",
      id: uuid(),
      filename: file.name,
      mime,
      url,
      size: file.size,
    }
    const cursor = prompt.cursor() ?? (editor ? getCursorPosition(editor) : undefined)
    prompt.set([...prompt.current(), attachment], cursor)
    return "ok" as const
  }

  const addAttachment = async (file: File) => (await add(file)) === "ok"

  const addAttachments = async (files: File[], toast = true) => {
    let found = false
    let rejectedForSize = false
    let rejectedForType = false
    let rejectedForUpload = false
    let rejectedForBudget = false
    const usage = attachmentUsage(prompt.current())

    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        rejectedForSize = true
        continue
      }
      const result = await add(file, false, usage)
      if (result === "ok") found = true
      else if (result === "upload") rejectedForUpload = true
      else if (result === "overflow") rejectedForBudget = true
      else rejectedForType = true
    }

    if (toast) {
      // Surface the size rejection once for the batch (valid files still attach).
      // Only fall back to the unsupported-type warning when nothing else fired.
      if (rejectedForSize) warnTooLarge()
      else if (rejectedForBudget) warnOverBudget()
      else if (rejectedForUpload) warnUploadFailed()
      else if (rejectedForType && !found) warn()
    }
    return found
  }

  const removeAttachment = (id: string) => {
    const current = prompt.current()
    const next = current.filter((part) => part.type !== "image" || part.id !== id)
    prompt.set(next, prompt.cursor())
  }

  const handlePaste = async (event: ClipboardEvent) => {
    const clipboardData = event.clipboardData
    if (!clipboardData) return

    event.preventDefault()
    event.stopPropagation()

    const files = Array.from(clipboardData.items).flatMap((item) => {
      if (item.kind !== "file") return []
      const file = item.getAsFile()
      return file ? [file] : []
    })

    if (files.length > 0) {
      await addAttachments(files)
      return
    }

    const plainText = clipboardData.getData("text/plain") ?? ""

    // Desktop: Browser clipboard has no images and no text, try platform's native clipboard for images
    if (input.readClipboardImage && !plainText) {
      const file = await input.readClipboardImage()
      if (file) {
        await addAttachment(file)
        return
      }
    }

    if (!plainText) return

    const text = normalizePaste(plainText)

    const put = () => {
      if (input.addPart({ type: "text", content: text, start: 0, end: 0 })) return true
      input.focusEditor()
      return input.addPart({ type: "text", content: text, start: 0, end: 0 })
    }

    if (pasteMode(text) === "manual") {
      put()
      return
    }

    const inserted = typeof document.execCommand === "function" && document.execCommand("insertText", false, text)
    if (inserted) return

    put()
  }

  const handleGlobalDragOver = (event: DragEvent) => {
    if (!input.enabled()) return
    if (input.isDialogActive()) return
    if (ownedByDropZone(event)) return

    event.preventDefault()
    const hasFiles = event.dataTransfer?.types.includes("Files")
    const hasText = event.dataTransfer?.types.includes("text/plain")
    if (hasFiles) {
      input.setDraggingType("image")
    } else if (hasText) {
      input.setDraggingType("@mention")
    }
  }

  const handleGlobalDragLeave = (event: DragEvent) => {
    if (!input.enabled()) return
    if (input.isDialogActive()) return
    if (ownedByDropZone(event)) return
    if (!event.relatedTarget) {
      input.setDraggingType(null)
    }
  }

  const handleGlobalDrop = async (event: DragEvent) => {
    if (!input.enabled()) return
    if (input.isDialogActive()) return
    if (ownedByDropZone(event)) return

    event.preventDefault()
    event.stopPropagation()
    input.setDraggingType(null)

    const plainText = event.dataTransfer?.getData("text/plain")
    const filePrefix = "file:"
    if (plainText?.startsWith(filePrefix)) {
      const filePath = plainText.slice(filePrefix.length)
      if (await input.dropPath?.(filePath)) return
      input.focusEditor()
      input.addPart({ type: "file", path: filePath, content: "@" + filePath, start: 0, end: 0 })
      return
    }

    const dropped = event.dataTransfer?.files
    if (!dropped) return

    const files = Array.from(dropped)
    if (input.dropFiles && (await input.dropFiles(files))) return
    await addAttachments(files)
  }

  onMount(() => {
    document.addEventListener("dragover", handleGlobalDragOver)
    document.addEventListener("dragleave", handleGlobalDragLeave)
    document.addEventListener("drop", handleGlobalDrop, true)
  })

  onCleanup(() => {
    document.removeEventListener("dragover", handleGlobalDragOver)
    document.removeEventListener("dragleave", handleGlobalDragLeave)
    document.removeEventListener("drop", handleGlobalDrop, true)
  })

  return {
    addAttachment,
    addAttachments,
    removeAttachment,
    handlePaste,
  }
}
