import { afterEach, describe, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { writeClipboard } from "./clipboard"

const dom = new JSDOM("<!doctype html><html><body><input id='focused' /></body></html>")
const win = dom.window as unknown as Window & typeof globalThis

const globals = globalThis as Record<string, unknown>
globals.document = win.document
globals.HTMLElement = win.HTMLElement
globals.navigator = win.navigator

function stubClipboard(writeText?: (value: string) => Promise<void>) {
  Object.defineProperty(win.navigator, "clipboard", {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  })
}

function stubExecCommand(result: boolean | (() => boolean)) {
  const copied: string[] = []
  win.document.execCommand = () => {
    const selected = win.document.activeElement
    if (selected instanceof win.HTMLTextAreaElement) copied.push(selected.value)
    return typeof result === "function" ? result() : result
  }
  return copied
}

afterEach(() => {
  stubClipboard(undefined)
})

describe("writeClipboard", () => {
  test("uses the clipboard API when it resolves", async () => {
    const written: string[] = []
    stubClipboard(async (value) => {
      written.push(value)
    })
    const execCommand = stubExecCommand(false)

    expect(await writeClipboard("hello")).toBe(true)
    expect(written).toEqual(["hello"])
    // The API worked, so the selection fallback must not run and steal focus.
    expect(execCommand).toEqual([])
  })

  test("falls back to selection when the document is not focused", async () => {
    stubClipboard(() => Promise.reject(new win.DOMException("Document is not focused.", "NotAllowedError")))
    const execCommand = stubExecCommand(true)

    expect(await writeClipboard("hello")).toBe(true)
    expect(execCommand).toEqual(["hello"])
  })

  test("falls back to selection when the clipboard API is missing", async () => {
    stubClipboard(undefined)
    const execCommand = stubExecCommand(true)

    expect(await writeClipboard("hello")).toBe(true)
    expect(execCommand).toEqual(["hello"])
  })

  test("restores focus and removes the textarea after falling back", async () => {
    stubClipboard(() => Promise.reject(new win.DOMException("Document is not focused.", "NotAllowedError")))
    stubExecCommand(true)
    const input = win.document.getElementById("focused") as HTMLInputElement
    input.focus()

    await writeClipboard("hello")

    expect(win.document.activeElement).toBe(input)
    expect(win.document.querySelector("textarea")).toBeNull()
  })

  test("reports failure instead of rejecting when both paths fail", async () => {
    stubClipboard(() => Promise.reject(new win.DOMException("Document is not focused.", "NotAllowedError")))
    stubExecCommand(false)

    expect(await writeClipboard("hello")).toBe(false)
  })

  test("reports failure when the selection fallback throws", async () => {
    stubClipboard(undefined)
    stubExecCommand(() => {
      throw new Error("execCommand is unsupported")
    })

    expect(await writeClipboard("hello")).toBe(false)
    expect(win.document.querySelector("textarea")).toBeNull()
  })
})
