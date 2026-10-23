import { describe, expect, test } from "bun:test"
import {
  PDF_ZOOM_DEFAULT,
  pdfBytesFromDataUrl,
  pdfPageForKey,
  pdfPageInput,
  pdfScale,
  pdfZoomPercent,
} from "./pdf-viewer-model"

const page = { width: 600, height: 800 }
const container = { width: 624, height: 410 }

describe("pdfScale", () => {
  test("uses the selected zoom level until the page size is known", () => {
    expect(pdfScale({ container, fit: "auto", zoom: PDF_ZOOM_DEFAULT })).toBe(1)
    expect(pdfScale({ container, page: { width: 0, height: 0 }, fit: "width", zoom: 0 })).toBe(0.25)
  })

  test("fits width and height after subtracting page padding", () => {
    expect(pdfScale({ container, page, fit: "width", zoom: 0 })).toBe(1)
    expect(pdfScale({ container, page, fit: "height", zoom: 0 })).toBe(0.5)
  })

  test("auto picks the fit that shows the whole page", () => {
    expect(pdfScale({ container, page, fit: "auto", zoom: 5 })).toBe(0.5)
  })

  test("manual zoom ignores the container", () => {
    expect(pdfScale({ container, page, fit: "none", zoom: 4 })).toBe(1.5)
  })

  test("never collapses to a non-positive scale in a tiny container", () => {
    expect(pdfScale({ container: { width: 10, height: 5 }, page, fit: "auto", zoom: 0 })).toBe(0.05)
  })
})

describe("pdfZoomPercent", () => {
  test("floors to a whole percent", () => {
    expect(pdfZoomPercent(0.5)).toBe(50)
    expect(pdfZoomPercent(0.6789)).toBe(67)
  })
})

describe("pdfPageForKey", () => {
  test("moves between pages with arrows inside bounds", () => {
    expect(pdfPageForKey("ArrowLeft", 3, 5)).toBe(2)
    expect(pdfPageForKey("ArrowRight", 3, 5)).toBe(4)
    expect(pdfPageForKey("ArrowLeft", 1, 5)).toBeUndefined()
    expect(pdfPageForKey("ArrowRight", 5, 5)).toBeUndefined()
  })

  test("jumps to the first and last page", () => {
    expect(pdfPageForKey("Home", 3, 5)).toBe(1)
    expect(pdfPageForKey("End", 3, 5)).toBe(5)
  })

  test("ignores other keys", () => {
    expect(pdfPageForKey("ArrowDown", 3, 5)).toBeUndefined()
    expect(pdfPageForKey("Enter", 3, 5)).toBeUndefined()
  })
})

describe("pdfPageInput", () => {
  test("keeps digits only and clamps to the page range", () => {
    expect(pdfPageInput("3", 5)).toBe(3)
    expect(pdfPageInput("a2b", 5)).toBe(2)
    expect(pdfPageInput("0", 5)).toBe(1)
    expect(pdfPageInput("99", 5)).toBe(5)
  })

  test("treats an empty value as invalid", () => {
    expect(pdfPageInput("", 5)).toBeUndefined()
    expect(pdfPageInput("abc", 5)).toBeUndefined()
  })
})

describe("pdfBytesFromDataUrl", () => {
  test("decodes a base64 data url", () => {
    const bytes = pdfBytesFromDataUrl(`data:application/pdf;base64,${btoa("%PDF-1.7")}`)
    expect(bytes && new TextDecoder().decode(bytes)).toBe("%PDF-1.7")
  })

  test("rejects non-base64 data urls", () => {
    expect(pdfBytesFromDataUrl("data:application/pdf,%25PDF")).toBeUndefined()
    expect(pdfBytesFromDataUrl("blob:abc")).toBeUndefined()
  })
})
