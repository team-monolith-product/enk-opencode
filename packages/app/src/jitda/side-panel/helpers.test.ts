import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import {
  beginContentTabOpen,
  createOpenDiffTab,
  createOpenSessionFileTab,
  createSessionTabs,
  fileTab,
  nextTabListScrollLeft,
  shouldSuppressPseudoTab,
} from "./helpers"

describe("nextTabListScrollLeft", () => {
  test("does not scroll when width shrinks", () => {
    const left = nextTabListScrollLeft({
      prevScrollWidth: 500,
      scrollWidth: 420,
      clientWidth: 300,
      prevContextOpen: false,
      contextOpen: false,
    })

    expect(left).toBeUndefined()
  })

  test("scrolls to start when context tab opens", () => {
    const left = nextTabListScrollLeft({
      prevScrollWidth: 400,
      scrollWidth: 500,
      clientWidth: 320,
      prevContextOpen: false,
      contextOpen: true,
    })

    expect(left).toBe(0)
  })

  test("scrolls to right edge for new file tabs", () => {
    const left = nextTabListScrollLeft({
      prevScrollWidth: 500,
      scrollWidth: 780,
      clientWidth: 300,
      prevContextOpen: true,
      contextOpen: true,
    })

    expect(left).toBe(480)
  })
})

const flushPseudoGuard = () =>
  new Promise<void>((resolve) => queueMicrotask(() => requestAnimationFrame(() => resolve())))

describe("shouldSuppressPseudoTab", () => {
  test("blocks preview while a content tab is opening", async () => {
    expect(shouldSuppressPseudoTab("preview")).toBe(false)
    beginContentTabOpen(() => {})
    expect(shouldSuppressPseudoTab("preview")).toBe(true)
    expect(shouldSuppressPseudoTab("review")).toBe(true)
    expect(shouldSuppressPseudoTab("file://src/a.ts")).toBe(false)
    await flushPseudoGuard()
    expect(shouldSuppressPseudoTab("preview")).toBe(false)
  })
})

describe("createOpenDiffTab", () => {
  test("opens and activates diff tab", async () => {
    const calls: string[] = []
    const open = createOpenDiffTab({
      tabForPath: (path) => {
        calls.push(`tab:${path}`)
        return `diff://${path}`
      },
      openTab: (tab) => calls.push(`open:${tab}`),
      setActive: (tab) => calls.push(`active:${tab}`),
    })

    open("src/a.ts")

    expect(calls).toEqual(["tab:src/a.ts", "open:diff://src/a.ts", "active:diff://src/a.ts"])
    await flushPseudoGuard()
  })
})

describe("createOpenSessionFileTab", () => {
  test("activates the opened file tab", async () => {
    const calls: string[] = []
    const openTab = createOpenSessionFileTab({
      normalizeTab: (value) => {
        calls.push(`normalize:${value}`)
        return `file://${value}`
      },
      openTab: (tab) => calls.push(`open:${tab}`),
      pathFromTab: (tab) => {
        calls.push(`path:${tab}`)
        return tab.slice("file://".length)
      },
      loadFile: (path) => calls.push(`load:${path}`),
      setActive: (tab) => calls.push(`active:${tab}`),
    })

    openTab("src/a.ts")

    expect(calls).toEqual([
      "normalize:src/a.ts",
      "path:file://src/a.ts",
      "open:file://src/a.ts",
      "load:src/a.ts",
      "active:file://src/a.ts",
    ])
    await flushPseudoGuard()
  })

  test("activates diff tab without loading file", async () => {
    const calls: string[] = []
    const openTab = createOpenSessionFileTab({
      normalizeTab: (value) => value,
      openTab: (tab) => calls.push(`open:${tab}`),
      pathFromTab: (tab) => tab.slice("diff://".length),
      loadFile: (path) => calls.push(`load:${path}`),
      setActive: (tab) => calls.push(`active:${tab}`),
    })

    openTab("diff://src/a.ts")

    expect(calls).toEqual(["open:diff://src/a.ts", "active:diff://src/a.ts"])
    await flushPseudoGuard()
  })

  test("opens the preview tab directly", async () => {
    const calls: string[] = []
    const openTab = createOpenSessionFileTab({
      normalizeTab: (value) => value,
      openTab: (tab) => calls.push(`open:${tab}`),
      pathFromTab: () => undefined,
      loadFile: () => calls.push("load"),
      setActive: (tab) => calls.push(`active:${tab}`),
    })

    openTab("preview")

    expect(calls).toEqual(["open:preview"])
    await flushPseudoGuard()
  })
})

describe("createSessionTabs", () => {
  test("normalizes the effective file tab", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: undefined as string | undefined,
        all: ["file://src/a.ts", "context"],
      })
      const result = createSessionTabs({
        active: () => state.active,
        all: () => state.all,
        pathFromTab: (tab) => (tab.startsWith("file://") ? tab.slice("file://".length) : undefined),
        normalizeTab: (tab) => (tab.startsWith("file://") ? `norm:${tab.slice("file://".length)}` : tab),
      })

      expect(result.activeTab()).toBe("norm:src/a.ts")
      expect(result.activeFileTab()).toBe("norm:src/a.ts")
      dispose()
    })
  })

  test("falls back to preview when nothing else is open", () => {
    createRoot((dispose) => {
      const result = createSessionTabs({
        active: () => undefined,
        all: () => [],
        pathFromTab: () => undefined,
        normalizeTab: (tab) => tab,
        preview: () => true,
      })

      expect(result.activeTab()).toBe("preview")
      expect(result.activeFileTab()).toBeUndefined()
      dispose()
    })
  })
})

describe("fileTab", () => {
  const tabs = fileTab((input) => input.replace(/^(file|diff):\/\//, ""))

  test("round-trips file and diff tabs", () => {
    expect(tabs.tab("src/a b.ts")).toBe("file://src/a%20b.ts")
    expect(tabs.pathFromTab("file://src/a.ts")).toBe("src/a.ts")
    expect(tabs.pathFromTab("diff://src/a.ts")).toBeUndefined()
    expect(tabs.diffTab("src/a.ts")).toBe("diff://src/a.ts")
    expect(tabs.pathFromDiffTab("diff://src/a.ts")).toBe("src/a.ts")
    expect(tabs.pathFromDiffTab("file://src/a.ts")).toBeUndefined()
  })
})
