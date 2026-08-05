import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { ContentPart, Prompt } from "@/context/prompt"
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT, MAX_ATTACHMENT_TOTAL_BYTES } from "@/constants/file-picker"
import { attachmentMime } from "./files"
import { pasteMode } from "./paste"

let current: Prompt = []
const toasts: string[] = []

mock.module("@/context/prompt", () => ({
  usePrompt: () => ({
    current: () => current,
    cursor: () => undefined,
    set: (next: Prompt) => {
      current = next
    },
  }),
}))

mock.module("@/context/language", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

mock.module("@opencode-ai/ui/toast", () => ({
  showToast: (input: { title: string }) => {
    toasts.push(input.title)
  },
}))

let attachments: typeof import("./attachments")

beforeAll(async () => {
  attachments = await import("./attachments")
})

describe("attachmentMime", () => {
  test("keeps PDFs when the browser reports the mime", async () => {
    const file = new File(["%PDF-1.7"], "guide.pdf", { type: "application/pdf" })
    expect(await attachmentMime(file)).toBe("application/pdf")
  })

  test("normalizes structured text types to text/plain", async () => {
    const file = new File(['{"ok":true}\n'], "data.json", { type: "application/json" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("accepts text files even with a misleading browser mime", async () => {
    const file = new File(["export const x = 1\n"], "main.ts", { type: "video/mp2t" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("rejects binary files", async () => {
    const file = new File([Uint8Array.of(0, 255, 1, 2)], "blob.bin", { type: "application/octet-stream" })
    expect(await attachmentMime(file)).toBeUndefined()
  })
})

describe("pasteMode", () => {
  test("uses native paste for short single-line text", () => {
    expect(pasteMode("hello world")).toBe("native")
  })

  test("uses manual paste for multiline text", () => {
    expect(
      pasteMode(`{
  "ok": true
}`),
    ).toBe("manual")
    expect(pasteMode("a\r\nb")).toBe("manual")
  })

  test("uses manual paste for large text", () => {
    expect(pasteMode("x".repeat(8000))).toBe("manual")
  })
})

describe("composer attachment budget", () => {
  // File.size is a getter, so a fake size beats allocating tens of megabytes per case.
  const file = (name: string, size: number) => {
    const value = new File(["x"], name, { type: "image/png" })
    Object.defineProperty(value, "size", { value: size })
    return value
  }

  const image = (id: string, size?: number): ContentPart => ({
    type: "image",
    id,
    filename: `${id}.png`,
    mime: "image/png",
    url: `/doc/doc_1/asset/${id}`,
    size,
  })

  let uploads = 0

  const composer = () =>
    attachments.createPromptAttachments({
      enabled: () => true,
      editor: () => undefined,
      isDialogActive: () => false,
      setDraggingType: () => {},
      focusEditor: () => {},
      addPart: () => true,
      upload: async () => {
        uploads += 1
        return `/doc/doc_1/asset/asset_${uploads}`
      },
    })

  beforeEach(() => {
    current = []
    uploads = 0
    toasts.length = 0
  })

  test("counts the prompt's own attachments, unknown sizes included", () => {
    current = [image("a", 100), image("b"), { type: "text", content: "hi", start: 0, end: 2 }]
    expect(attachments.attachmentUsage(current)).toEqual({ count: 2, bytes: 100 })
  })

  test("attaches every file while within budget", async () => {
    const added = await composer().addAttachments([file("a.png", 1), file("b.png", 1)])
    expect(added).toBe(true)
    expect(uploads).toBe(2)
    expect(toasts).toEqual([])
  })

  test("drops the files past the count limit and warns once", async () => {
    const files = Array.from({ length: MAX_ATTACHMENT_COUNT + 3 }, (_, i) => file(`f${i}.png`, 1))
    await composer().addAttachments(files)
    expect(uploads).toBe(MAX_ATTACHMENT_COUNT)
    expect(toasts).toEqual(["prompt.toast.tooManyAttachments.title"])
  })

  test("counts what the prompt already carries, not just this batch", async () => {
    current = Array.from({ length: MAX_ATTACHMENT_COUNT - 1 }, (_, i) => image(`old${i}`, 1))
    await composer().addAttachments([file("a.png", 1), file("b.png", 1)])
    expect(uploads).toBe(1)
    expect(toasts).toEqual(["prompt.toast.tooManyAttachments.title"])
  })

  test("stops at the total byte budget", async () => {
    // Each file sits exactly at the per-file cap, so only the total budget can reject them: two fit
    // under 25 MB, the third does not.
    const size = MAX_ATTACHMENT_BYTES
    expect(size * 2).toBeLessThanOrEqual(MAX_ATTACHMENT_TOTAL_BYTES)
    await composer().addAttachments([file("a.png", size), file("b.png", size), file("c.png", size)])
    expect(uploads).toBe(2)
    expect(toasts).toEqual(["prompt.toast.tooManyAttachments.title"])
  })

  test("never uploads a file it cannot attach", async () => {
    current = Array.from({ length: MAX_ATTACHMENT_COUNT }, (_, i) => image(`old${i}`, 1))
    const ok = await composer().addAttachment(file("a.png", 1))
    expect(ok).toBe(false)
    expect(uploads).toBe(0)
  })

  test("oversized single files still report the size problem", async () => {
    await composer().addAttachments([file("big.png", MAX_ATTACHMENT_BYTES + 1)])
    expect(uploads).toBe(0)
    expect(toasts).toEqual(["prompt.toast.fileTooLarge.title"])
  })
})
