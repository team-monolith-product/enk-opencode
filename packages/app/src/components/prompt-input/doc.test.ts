import { beforeAll, describe, expect, mock, test } from "bun:test"
import { createStore } from "solid-js/store"
import type { DocMountInput } from "@/components/blocksuite/blocksuite-doc"
import type { PromptDocConfig } from "./doc"
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT, MAX_ATTACHMENT_TOTAL_BYTES } from "@/constants/file-picker"

const mounts: DocMountInput[] = []
const promptDocs: Array<{ sessionID: string; directory: string }> = []
let onSubmit: (() => void) | undefined

let assetUsage = { count: 0, bytes: 0 }

const handle = {
  addFile: mock(async () => true),
  assets: () => assetUsage,
  attach: mock(async () => {}),
  detach: mock(() => {}),
  dispose: mock(async () => {}),
  setTheme: mock(() => {}),
  setActorIdentity: mock(() => {}),
  doc: {
    slots: {
      historyUpdated: {
        on: mock(() => ({ dispose: () => {} })),
      },
    },
  },
  onHistory: mock(() => {}),
  canUndo: () => false,
  canRedo: () => false,
  empty: () => true,
  plain: () => "",
  actors: () => [],
  markdown: async () => ({ text: "", assets: [] }),
  collection: { id: "doc_1" },
}

// Injected per-instance rather than registered as a module mock for blocksuite-doc. Module mocks are
// global to the whole `bun test` process, so stubbing createPage there would also hand the stub to
// blocksuite-doc.test.ts, which exercises the real one — and whether that broke the suite came down
// to which file the runner reached first (fine on macOS, 6 failures on CI's Linux box).
// See src/module-mock-allowlist.test.ts.
const createPage = mock(async (input: DocMountInput) => {
  mounts.push(input)
  onSubmit = input.onSubmit
  return handle
}) as never

let createPromptDoc: typeof import("./doc").createPromptDoc

beforeAll(async () => {
  ;({ createPromptDoc } = await import("./doc"))
})

const client = {
  session: {
    actor: {
      upsert: async () => ({
        data: { actorID: "act_1", name: "Test", color: "#3574D9" },
      }),
    },
    promptDoc: async (input: { sessionID: string; directory: string }) => {
      promptDocs.push(input)
      return { data: { docID: "doc_1" } }
    },
    promptDoc2: {
      advance: async () => ({ data: { docID: "doc_2" } }),
      ready: async () => ({ data: { docID: "doc_2" } }),
    },
  },
} as never

function config(overrides?: Partial<PromptDocConfig>): PromptDocConfig {
  return {
    sessionID: "session_1",
    url: "http://localhost:4096",
    directory: "/tmp/project",
    submitKey: "enter",
    ...overrides,
  }
}

describe("createPromptDoc plain props", () => {
  test("mount passes plain theme to createPage", async () => {
    mounts.length = 0
    const [store] = createStore(config())
    const doc = createPromptDoc({ createPage, config: store, client, onSubmit: () => {} })
    const el = document.createElement("div")
    await doc.mount({ el, theme: "light" })
    expect(mounts[0]?.theme).toBe("light")
  })

  test("setTheme updates stored theme before remount", async () => {
    mounts.length = 0
    const [store] = createStore(config())
    const doc = createPromptDoc({ createPage, config: store, client, onSubmit: () => {} })
    const el = document.createElement("div")
    await doc.mount({ el, theme: "light" })
    doc.setTheme("dark")
    await doc.pivot("session_1", "doc_2")
    expect(mounts.at(-1)?.theme).toBe("dark")
  })

  test("remount reads submitKey from config store", async () => {
    mounts.length = 0
    const [store, setStore] = createStore(config({ submitKey: "enter" }))
    const doc = createPromptDoc({ createPage, config: store, client, onSubmit: () => {} })
    const el = document.createElement("div")
    await doc.mount({ el, theme: "light" })
    setStore("submitKey", "mod+enter")
    await doc.pivot("session_1", "doc_2")
    expect(mounts.at(-1)?.submitKey).toBe("mod+enter")
  })

  test("onSubmit forwarded to createPage", async () => {
    mounts.length = 0
    let sent = 0
    const [store] = createStore(config())
    const doc = createPromptDoc({ createPage, config: store, client, onSubmit: () => sent++ })
    const el = document.createElement("div")
    await doc.mount({ el, theme: "light" })
    onSubmit?.()
    expect(sent).toBe(1)
  })

  test("config store sessionID read after await", async () => {
    promptDocs.length = 0
    const [store, setStore] = createStore(config({ sessionID: "session_1" }))
    const doc = createPromptDoc({ createPage, config: store, client, onSubmit: () => {} })
    const el = document.createElement("div")
    await doc.mount({ el, theme: "light" })
    setStore("sessionID", "session_2")
    await doc.refresh("session_2")
    expect(promptDocs.at(-1)?.sessionID).toBe("session_2")
  })

  test("readonly mounts read-only and never registers a server actor", async () => {
    mounts.length = 0
    const upsert = mock(async () => ({ data: { actorID: "act_1", name: "Test", color: "#3574D9" } }))
    const readonlyClient = {
      session: {
        actor: { upsert },
        promptDoc: async () => ({ data: { docID: "doc_1" } }),
      },
    } as never
    const [store] = createStore(config({ readonly: true }))
    const doc = createPromptDoc({ createPage, config: store, client: readonlyClient, onSubmit: () => {} })
    const el = document.createElement("div")
    await doc.mount({ el, theme: "light" })
    expect(mounts.at(-1)?.readonly).toBe(true)
    // No actor.upsert → no SessionActorTable row; identity is a local-only synthetic id. It carries
    // the `act` prefix so it passes ActorID.zod on the observer-only submit socket.
    expect(upsert).not.toHaveBeenCalled()
    expect(doc.actorID()?.startsWith("act")).toBe(true)
  })
})

describe("createPromptDoc attachment budget", () => {
  // File.size is a getter, so a fake size beats allocating tens of megabytes per case.
  const file = (name: string, size: number) => {
    const value = new File(["x"], name)
    Object.defineProperty(value, "size", { value: size })
    return value
  }

  const mounted = async () => {
    assetUsage = { count: 0, bytes: 0 }
    handle.addFile.mockClear()
    const [store] = createStore(config())
    const doc = createPromptDoc({ createPage, config: store, client, onSubmit: () => {} })
    await doc.mount({ el: document.createElement("div"), theme: "light" })
    return doc
  }

  test("adds every file while the prompt is within budget", async () => {
    const doc = await mounted()
    const result = await doc.addFiles([file("a.png", 1), file("b.png", 1)])
    expect(result).toEqual({ added: true, tooLarge: false, overflow: false })
    expect(handle.addFile).toHaveBeenCalledTimes(2)
  })

  test("drops the files past the count limit and reports overflow", async () => {
    const doc = await mounted()
    const files = Array.from({ length: MAX_ATTACHMENT_COUNT + 3 }, (_, i) => file(`f${i}.png`, 1))
    const result = await doc.addFiles(files)
    expect(result.overflow).toBe(true)
    expect(handle.addFile).toHaveBeenCalledTimes(MAX_ATTACHMENT_COUNT)
  })

  test("counts what the doc already holds, not just this batch", async () => {
    const doc = await mounted()
    assetUsage = { count: MAX_ATTACHMENT_COUNT - 1, bytes: 0 }
    const result = await doc.addFiles([file("a.png", 1), file("b.png", 1)])
    expect(result.overflow).toBe(true)
    expect(handle.addFile).toHaveBeenCalledTimes(1)
  })

  test("stops at the total byte budget", async () => {
    const doc = await mounted()
    // Each file is exactly at the per-file cap, so only the total budget can reject them: two fit
    // under 25 MB, the third does not.
    const size = MAX_ATTACHMENT_BYTES
    expect(size * 2).toBeLessThanOrEqual(MAX_ATTACHMENT_TOTAL_BYTES)
    const result = await doc.addFiles([file("a.png", size), file("b.png", size), file("c.png", size)])
    expect(result.overflow).toBe(true)
    expect(handle.addFile).toHaveBeenCalledTimes(2)
  })

  test("oversized single files are still reported separately", async () => {
    const doc = await mounted()
    const result = await doc.addFiles([file("big.png", MAX_ATTACHMENT_BYTES + 1)])
    expect(result).toEqual({ added: false, tooLarge: true, overflow: false })
    expect(handle.addFile).not.toHaveBeenCalled()
  })
})
