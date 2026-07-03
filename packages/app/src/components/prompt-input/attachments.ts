import { onCleanup, onMount } from "solid-js"
import { showToast } from "@opencode-ai/ui/toast"
import { usePrompt, type ContentPart, type ImageAttachmentPart } from "@/context/prompt"
import { useLanguage } from "@/context/language"
import { MAX_ATTACHMENT_BYTES } from "@/constants/file-picker"
import { uuid } from "@/utils/uuid"
import { getCursorPosition } from "./editor-dom"
import { attachmentMime } from "./files"
import { fitImageToByteLimit } from "./capture-export"
import { normalizePaste, pasteMode } from "./paste"

function dataUrl(file: File, mime: string) {
  return new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.addEventListener("error", () => resolve(""))
    reader.addEventListener("load", () => {
      const value = typeof reader.result === "string" ? reader.result : ""
      const idx = value.indexOf(",")
      if (idx === -1) {
        resolve(value)
        return
      }
      resolve(`data:${mime};base64,${value.slice(idx + 1)}`)
    })
    reader.readAsDataURL(file)
  })
}

type PromptAttachmentsInput = {
  enabled: () => boolean
  editor: () => HTMLDivElement | undefined
  isDialogActive: () => boolean
  setDraggingType: (type: "image" | "@mention" | null) => void
  focusEditor: () => void
  addPart: (part: ContentPart) => boolean
  dropPath?: (path: string) => Promise<boolean> | boolean
  dropFiles?: (files: File[]) => Promise<boolean>
  readClipboardImage?: () => Promise<File | null>
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

  // 상한 초과 이미지는 거절하지 않고 상한 이하로 재인코딩/축소해 붙인다(미리보기 캡처처럼 풀 해상도라
  // 커지는 경우 대응). 이미지가 아니거나 못 줄이면 원본 그대로 → 호출부가 크기 재확인 후 거절.
  const fitForAttach = async (file: File) => {
    if (file.size <= MAX_ATTACHMENT_BYTES) return file
    return fitImageToByteLimit(file, MAX_ATTACHMENT_BYTES)
  }

  const add = async (file: File, toast = true) => {
    const fitted = await fitForAttach(file)
    // 축소 후에도 상한을 넘으면(비이미지이거나 못 줄임) 거절 — base64 로 메모리에 올리기 전에 막는다.
    if (fitted.size > MAX_ATTACHMENT_BYTES) {
      if (toast) warnTooLarge()
      return false
    }

    const mime = await attachmentMime(fitted)
    if (!mime) {
      if (toast) warn()
      return false
    }

    const editor = input.editor()
    const url = await dataUrl(fitted, mime)
    if (!url) return false

    const attachment: ImageAttachmentPart = {
      type: "image",
      id: uuid(),
      filename: fitted.name,
      mime,
      dataUrl: url,
    }
    const cursor = prompt.cursor() ?? (editor ? getCursorPosition(editor) : undefined)
    prompt.set([...prompt.current(), attachment], cursor)
    return true
  }

  const addAttachment = (file: File) => add(file)

  const addAttachments = async (files: File[], toast = true) => {
    let found = false
    let rejectedForSize = false
    let rejectedForType = false

    for (const file of files) {
      const fitted = await fitForAttach(file)
      if (fitted.size > MAX_ATTACHMENT_BYTES) {
        rejectedForSize = true
        continue
      }
      const ok = await add(fitted, false)
      if (ok) found = true
      else rejectedForType = true
    }

    if (toast) {
      // Surface the size rejection once for the batch (valid files still attach).
      // Only fall back to the unsupported-type warning when nothing else fired.
      if (rejectedForSize) warnTooLarge()
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
    if (!event.relatedTarget) {
      input.setDraggingType(null)
    }
  }

  const handleGlobalDrop = async (event: DragEvent) => {
    if (!input.enabled()) return
    if (input.isDialogActive()) return

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
