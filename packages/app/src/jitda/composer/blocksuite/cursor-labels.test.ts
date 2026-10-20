import { describe, expect, test } from "bun:test"
import { watchCursorLabels } from "./cursor-labels"

// 실제 태그(affine-doc-remote-selection-widget)를 쓰면 다른 테스트 파일이 createPage()로
// BlockSuite custom element를 전역 등록한 뒤엔 이 엘리먼트가 진짜 Lit 위젯으로 업그레이드되어
// doc.awarenessStore 접근에서 터진다. 정의될 일 없는 태그를 쓰고 selector를 주입한다.
const TAG = "test-remote-selection-widget"

type Widget = HTMLElement & {
  requestUpdate?: () => unknown
}
type Slot = {
  callback?: () => void
  on: (fn: () => void) => { dispose: () => void }
  emit: () => void
}
type Doc = {
  callback?: () => void
  on: (name: "update", fn: () => void) => void
  off: (name: "update", fn: () => void) => void
  emit: () => void
}
type Editor = HTMLElement & {
  std?: {
    doc?: {
      spaceDoc?: Doc
    }
    selection?: {
      slots?: {
        remoteChanged?: Slot
      }
    }
  }
}

const wait = () => new Promise((resolve) => setTimeout(resolve, 30))

const slot = (): Slot => ({
  on(fn) {
    this.callback = fn
    return {
      dispose: () => {
        this.callback = undefined
      },
    }
  },
  emit() {
    this.callback?.()
  },
})

const doc = (): Doc => ({
  on(_name, fn) {
    this.callback = fn
  },
  off(_name, fn) {
    if (this.callback !== fn) return
    this.callback = undefined
  },
  emit() {
    this.callback?.()
  },
})

describe("watchCursorLabels", () => {
  test("refreshes remote cursor widgets when editor text changes", async () => {
    const host = document.createElement("div")
    const editor = document.createElement("div")
    const block = document.createElement("span")
    const text = document.createTextNode("a")
    const widget = document.createElement(TAG) as Widget
    let calls = 0

    widget.requestUpdate = () => {
      calls++
    }
    widget.attachShadow({ mode: "open" })
    block.append(text)
    editor.append(block, widget)
    host.append(editor)
    document.body.append(host)

    const stop = watchCursorLabels(editor, host, TAG)
    calls = 0

    text.data = ""
    await wait()

    expect(calls).toBeGreaterThan(0)
    stop()
    host.remove()
  })

  test("refreshes remote cursor widgets when blocksuite signals change", async () => {
    const host = document.createElement("div")
    const editor = document.createElement("div") as Editor
    const widget = document.createElement(TAG) as Widget
    const remote = slot()
    const sync = doc()
    let calls = 0

    widget.requestUpdate = () => {
      calls++
    }
    widget.attachShadow({ mode: "open" })
    editor.std = {
      doc: { spaceDoc: sync },
      selection: { slots: { remoteChanged: remote } },
    }
    editor.append(widget)
    host.append(editor)
    document.body.append(host)

    const stop = watchCursorLabels(editor, host, TAG)
    calls = 0

    remote.emit()
    sync.emit()
    await wait()

    expect(calls).toBeGreaterThan(0)
    const done = calls
    stop()
    remote.emit()
    sync.emit()
    await wait()
    expect(calls).toBe(done)
    host.remove()
  })

  test("applies Status Pill round + vertical size to remote cursor labels", async () => {
    const host = document.createElement("div")
    const editor = document.createElement("div")
    const widget = document.createElement(TAG) as Widget
    const root = widget.attachShadow({ mode: "open" })
    const label = document.createElement("div")
    label.style.whiteSpace = "nowrap"
    label.style.textOverflow = "ellipsis"
    root.append(label)
    editor.append(widget)
    host.append(editor)
    document.body.append(host)

    const stop = watchCursorLabels(editor, host, TAG)
    await wait()

    expect(root.adoptedStyleSheets.length).toBeGreaterThan(0)

    const computed = getComputedStyle(label)
    expect(computed.borderRadius).toBe("999px")
    expect(computed.paddingTop).toBe("3px")
    expect(computed.paddingBottom).toBe("3px")

    const fontSize = Number.parseFloat(computed.fontSize)
    const lineHeight = Number.parseFloat(computed.lineHeight)
    expect(lineHeight === 1 || lineHeight / fontSize === 1).toBe(true)
    stop()
    host.remove()
  })
})
