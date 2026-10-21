import { describe, expect, test } from "bun:test"
import { fileContentFromBytes } from "@/workspaces/files/artifact"
import { pickFileViewer, viewerBytes, type FileViewer } from "./file-viewer"

const View = () => null
const pdf: FileViewer = { kinds: ["pdf"], View }
const document: FileViewer = { kinds: ["document"], View }
const spreadsheet: FileViewer = { kinds: ["spreadsheet"], View }
const presentation: FileViewer = { kinds: ["presentation"], View }
const viewers = [pdf, document, spreadsheet, presentation]

const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 1, 2])

describe("pickFileViewer", () => {
  test("picks the registered viewer for each office kind", () => {
    expect(pickFileViewer(viewers, "a/report.docx", fileContentFromBytes("a/report.docx", zip))).toBe(document)
    expect(pickFileViewer(viewers, "data.XLSX", fileContentFromBytes("data.XLSX", zip))).toBe(spreadsheet)
    expect(pickFileViewer(viewers, "deck.pptx", fileContentFromBytes("deck.pptx", zip))).toBe(presentation)
  })

  test("keeps the pdf viewer for pdf files", () => {
    expect(pickFileViewer(viewers, "doc.pdf", fileContentFromBytes("doc.pdf", zip))).toBe(pdf)
  })

  test("uses the first viewer that lists the kind", () => {
    const other: FileViewer = { kinds: ["document", "pdf"], View }
    expect(pickFileViewer([other, document], "a.docx", fileContentFromBytes("a.docx", zip))).toBe(other)
  })

  test("leaves kinds the tab renders itself and unregistered kinds alone", () => {
    const text = new TextEncoder().encode("hello")
    const any: FileViewer = { kinds: ["text", "image", "markdown"], View }
    expect(pickFileViewer([any], "a.ts", fileContentFromBytes("a.ts", text))).toBeUndefined()
    expect(pickFileViewer([any], "a.md", fileContentFromBytes("a.md", text))).toBeUndefined()
    expect(pickFileViewer([any], "a.png", fileContentFromBytes("a.png", zip))).toBeUndefined()
    expect(pickFileViewer([pdf], "a.docx", fileContentFromBytes("a.docx", zip))).toBeUndefined()
  })

  test("skips files loaded without bytes", () => {
    expect(pickFileViewer(viewers, "a.docx", undefined)).toBeUndefined()
    expect(pickFileViewer(viewers, "a.docx", { type: "binary", content: "", size: 10 })).toBeUndefined()
  })
})

describe("viewerBytes", () => {
  test("copies raw bytes so a viewer may transfer them", () => {
    const content = fileContentFromBytes("a.docx", zip)
    const bytes = viewerBytes(content)
    expect(Array.from(bytes)).toEqual(Array.from(zip))
    expect(bytes.buffer).not.toBe(content.bytes?.buffer)
  })

  test("decodes base64 content", () => {
    const content = {
      type: "binary" as const,
      content: btoa(String.fromCharCode(...zip)),
      encoding: "base64" as const,
      mimeType: "application/pdf",
    }
    expect(Array.from(viewerBytes(content))).toEqual(Array.from(zip))
  })
})
