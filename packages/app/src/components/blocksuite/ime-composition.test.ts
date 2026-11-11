import { afterEach, describe, expect, test } from "bun:test"
import { createPage } from "./blocksuite-doc"

// Guards patches/@blocksuite%2Finline@0.0.0-canary-20250316001624.patch. These drive the real
// editor with synthetic IME events, so they fail if the patch stops applying (e.g. after a
// BlockSuite bump) and Android keyboards start producing "주주제" again.

type Range = { index: number; length: number }
type Inline = {
  yText: { toString(): string; insert(index: number, text: string): void; doc: { transact(fn: () => void, origin: unknown): void } }
  eventSource: HTMLElement
  toDomRange(range: Range): globalThis.Range | null
  waitForUpdate(): Promise<void>
}
type Page = Awaited<ReturnType<typeof createPage>>

const opened: { page: Page; host: HTMLElement }[] = []

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map(async ({ page, host }) => {
      await page.dispose()
      host.remove()
    }),
  )
})

async function setup(text: string, selection: Range) {
  const host = document.createElement("div")
  document.body.append(host)
  const page = await createPage({ theme: "light", init: true })
  opened.push({ page, host })
  await page.attach(host)
  const inline = (page.editor.querySelector("rich-text") as unknown as { inlineEditor: Inline }).inlineEditor
  if (text) inline.yText.insert(0, text)
  await inline.waitForUpdate()
  const dom = inline.toDomRange(selection)!
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(dom)
  return { page, inline }
}

// happy-dom drops `data` from the CompositionEvent init dict.
function composition(type: string, data = "") {
  const event = new CompositionEvent(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, "data", { value: data })
  return event
}

// happy-dom has no StaticRange or InputEvent#getTargetRanges.
function compositionText(inline: Inline, data: string, target?: Range) {
  const event = new InputEvent("beforeinput", { inputType: "insertCompositionText", data, bubbles: true, cancelable: true })
  const dom = target && inline.toDomRange(target)
  const ranges = dom ? [{ startContainer: dom.startContainer, startOffset: dom.startOffset, endContainer: dom.endContainer, endOffset: dom.endOffset }] : []
  Object.defineProperty(event, "getTargetRanges", { value: () => ranges })
  return event
}

async function compose(inline: Inline, updates: [string, Range?][], data: string) {
  inline.eventSource.dispatchEvent(composition("compositionstart"))
  for (const [text, target] of updates) inline.eventSource.dispatchEvent(compositionText(inline, text, target))
  inline.eventSource.dispatchEvent(composition("compositionend", data))
  await new Promise((resolve) => setTimeout(resolve, 20))
  await inline.waitForUpdate()
}

// The app holds remote updates while composing and applies them in a capture-phase
// compositionend listener, before BlockSuite replaces the composed text. Do the same.
function remoteAtCompositionEnd(page: Page, inline: Inline, edit: () => void) {
  page.editor.addEventListener("compositionend", () => inline.yText.doc.transact(edit, "remote"), {
    capture: true,
    once: true,
  })
}

describe("IME composition", () => {
  test("replaces committed text an IME re-opens instead of duplicating it", async () => {
    const { inline } = await setup("주", { index: 1, length: 0 })
    await compose(inline, [["주제", { index: 0, length: 1 }]], "주제")
    expect(inline.yText.toString()).toBe("주제")
  })

  test("keeps text after a re-opened composition in the middle of a line", async () => {
    const { inline } = await setup("주X", { index: 1, length: 0 })
    await compose(
      inline,
      [
        ["주ㅈ", { index: 0, length: 1 }],
        ["주제", { index: 0, length: 2 }],
      ],
      "주제",
    )
    expect(inline.yText.toString()).toBe("주제X")
  })

  test("leaves a composition that starts at the caret where it is", async () => {
    const { inline } = await setup("주X", { index: 1, length: 0 })
    await compose(
      inline,
      [
        ["ㅈ", { index: 1, length: 0 }],
        ["제", { index: 1, length: 1 }],
      ],
      "제",
    )
    expect(inline.yText.toString()).toBe("주제X")
  })

  test("replaces the selection with the composed text", async () => {
    const { inline } = await setup("abc", { index: 1, length: 1 })
    await compose(inline, [["제", { index: 1, length: 1 }]], "제")
    expect(inline.yText.toString()).toBe("a제c")
  })

  test("keeps a collaborator's text inserted before a re-opened composition", async () => {
    const { page, inline } = await setup("주", { index: 1, length: 0 })
    remoteAtCompositionEnd(page, inline, () => inline.yText.insert(0, "XY"))
    await compose(inline, [["주제", { index: 0, length: 1 }]], "주제")
    expect(inline.yText.toString()).toBe("XY주제")
  })

  test("follows a collaborator's insert before a caret composition", async () => {
    const { page, inline } = await setup("주X", { index: 1, length: 0 })
    remoteAtCompositionEnd(page, inline, () => inline.yText.insert(0, "AB"))
    await compose(inline, [["제", { index: 1, length: 0 }]], "제")
    expect(inline.yText.toString()).toBe("AB주제X")
  })
})
