import { describe, expect, test } from "bun:test"
import { DocCollection } from "@blocksuite/store"
import { link } from "./doc-remote"
import type { OpencodeDocSource } from "./opencode-doc-source"

const Y = DocCollection.Y

type Apply = (id: string, data: Uint8Array) => void

// link()가 사용하는 표면(subscribe/pull/push/close/name)만 흉내 낸 소스. subscribe가 넘겨준
// apply 콜백을 붙잡아 테스트에서 원격 업데이트 도착을 직접 흉내 낸다.
function fakeSource() {
  let apply: Apply | undefined
  const source = {
    name: "test-source",
    pull: async () => undefined,
    push: async () => {},
    close: () => {},
    subscribe: async (onUpdate: Apply) => {
      apply = onUpdate
      return () => {}
    },
  } as unknown as OpencodeDocSource
  return { source, emit: (id: string, data: Uint8Array) => apply?.(id, data) }
}

function encodeInsert(guid: string, text: string) {
  const doc = new Y.Doc({ guid })
  doc.getText("t").insert(0, text)
  return Y.encodeStateAsUpdate(doc)
}

describe("link", () => {
  test("applies remote updates immediately when not holding", async () => {
    const { source, emit } = fakeSource()
    const root = new Y.Doc()
    const page = new Y.Doc()
    const channel = await link(source, root, page, () => false)
    emit(page.guid, encodeInsert(page.guid, "안녕"))
    expect(page.getText("t").toString()).toBe("안녕")
    channel.unlink()
  })

  test("buffers remote updates while holding (IME 조합 중) and flushes after", async () => {
    const { source, emit } = fakeSource()
    const root = new Y.Doc()
    const page = new Y.Doc()
    let composing = true
    const channel = await link(source, root, page, () => composing)

    emit(page.guid, encodeInsert(page.guid, "가"))
    emit(page.guid, encodeInsert(page.guid, "나"))
    // 조합 중에는 문서에 반영되지 않는다 — inline editor re-render(조합 취소)가 일어나지 않게.
    expect(page.getText("t").toString()).toBe("")

    composing = false
    channel.flush()
    // 조합이 끝나면 밀린 업데이트가 병합 적용되어 수렴한다.
    expect(page.getText("t").toString().length).toBeGreaterThan(0)
    channel.unlink()
  })

  test("flush is a no-op with nothing pending", async () => {
    const { source } = fakeSource()
    const root = new Y.Doc()
    const page = new Y.Doc()
    const channel = await link(source, root, page, () => true)
    expect(() => channel.flush()).not.toThrow()
    channel.unlink()
  })

  test("ignores updates for other doc guids while holding", async () => {
    const { source, emit } = fakeSource()
    const root = new Y.Doc()
    const page = new Y.Doc()
    const channel = await link(source, root, page, () => true)
    emit("other-guid", encodeInsert("other-guid", "무시"))
    channel.flush()
    expect(page.getText("t").toString()).toBe("")
    channel.unlink()
  })
})
