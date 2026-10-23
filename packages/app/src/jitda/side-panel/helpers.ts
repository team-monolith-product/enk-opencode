import { batch, createMemo, type Accessor } from "solid-js"
import { encodeFilePath } from "@opencode/util/path"

// V1 pages/session/helpers.ts·file-tab-scroll.ts 중 사이드 패널이 쓰는 부분.
export const fileTab = (normalize: (input: string) => string) => ({
  tab: (input: string) => `file://${encodeFilePath(normalize(input))}`,
  pathFromTab: (tab: string) => (tab.startsWith("file://") ? normalize(tab) : undefined),
  diffTab: (input: string) => `diff://${encodeFilePath(normalize(input))}`,
  pathFromDiffTab: (tab: string) =>
    tab.startsWith("diff://") ? normalize(`file://${tab.slice("diff://".length)}`) : undefined,
})

export type FileTabHelpers = ReturnType<typeof fileTab>

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])

const emptyTabs: string[] = []

type TabsInput = {
  active: Accessor<string | undefined>
  all: Accessor<string[]>
  pathFromTab: (tab: string) => string | undefined
  normalizeTab: (tab: string) => string
  review?: Accessor<boolean>
  preview?: Accessor<boolean>
  hasReview?: Accessor<boolean>
}

export const createSessionTabs = (input: TabsInput) => {
  const review = input.review ?? (() => false)
  const preview = input.preview ?? (() => false)
  const hasReview = input.hasReview ?? (() => false)
  const contextOpen = createMemo(() => input.active() === "context" || input.all().includes("context"))
  const openedTabs = createMemo(
    () => {
      const seen = new Set<string>()
      return input.all().flatMap((tab) => {
        if (tab === "context" || tab === "review" || tab === "preview") return []
        const value = input.pathFromTab(tab) ? input.normalizeTab(tab) : tab
        if (seen.has(value)) return []
        seen.add(value)
        return [value]
      })
    },
    emptyTabs,
    { equals: same },
  )
  const activeTab = createMemo(() => {
    const active = input.active()
    if (active === "context") return active
    if (active === "preview" && preview()) return active
    if (active === "review" && review()) return active
    if (active && input.pathFromTab(active)) return input.normalizeTab(active)

    const first = openedTabs()[0]
    if (first) return first
    if (contextOpen()) return "context"
    if (preview()) return "preview"
    if (review() && hasReview()) return "review"
    return "empty"
  })
  const activeFileTab = createMemo(() => {
    const active = activeTab()
    if (!openedTabs().includes(active)) return
    return active
  })

  return { contextOpen, openedTabs, activeTab, activeFileTab }
}

export const isDiffTab = (tab: string) => tab.startsWith("diff://")

const pseudoTab = (tab: string) => tab === "preview" || tab === "review"

let suppressPseudo = 0

export const shouldSuppressPseudoTab = (tab: string) => suppressPseudo > 0 && pseudoTab(tab)

// 파일·diff 탭을 여는 동안 Kobalte 가 preview/review 로 폴백하는 onChange 를 무시한다.
export const beginContentTabOpen = (fn: () => void) => {
  suppressPseudo++
  fn()
  queueMicrotask(() => {
    requestAnimationFrame(() => {
      suppressPseudo--
    })
  })
}

export const createOpenDiffTab = (input: {
  tabForPath: (path: string) => string
  openTab: (tab: string) => void
  setActive: (tab: string) => void
}) => {
  return (path: string) => {
    beginContentTabOpen(() => {
      batch(() => {
        const tab = input.tabForPath(path)
        input.openTab(tab)
        input.setActive(tab)
      })
    })
  }
}

export const createOpenSessionFileTab = (input: {
  normalizeTab: (tab: string) => string
  openTab: (tab: string) => void
  pathFromTab: (tab: string) => string | undefined
  loadFile: (path: string) => void
  setActive: (tab: string) => void
}) => {
  return (value: string) => {
    if (shouldSuppressPseudoTab(value)) return

    const next = input.normalizeTab(value)
    const path = input.pathFromTab(next)

    if (!path) {
      input.openTab(next)
      return
    }

    beginContentTabOpen(() => {
      input.openTab(next)
      if (isDiffTab(next)) {
        input.setActive(next)
        return
      }
      input.loadFile(path)
      input.setActive(next)
    })
  }
}

export const nextTabListScrollLeft = (input: {
  prevScrollWidth: number
  scrollWidth: number
  clientWidth: number
  prevContextOpen: boolean
  contextOpen: boolean
}) => {
  if (input.scrollWidth <= input.prevScrollWidth) return
  if (!input.prevContextOpen && input.contextOpen) return 0
  if (input.scrollWidth <= input.clientWidth) return
  return input.scrollWidth - input.clientWidth
}

export const createFileTabListSync = (input: { el: HTMLDivElement; contextOpen: () => boolean }) => {
  let frame: number | undefined
  let prevScrollWidth = input.el.scrollWidth
  let prevContextOpen = input.contextOpen()

  const update = () => {
    const scrollWidth = input.el.scrollWidth
    const clientWidth = input.el.clientWidth
    const contextOpen = input.contextOpen()
    const left = nextTabListScrollLeft({ prevScrollWidth, scrollWidth, clientWidth, prevContextOpen, contextOpen })
    if (left !== undefined) input.el.scrollTo({ left, behavior: "smooth" })
    prevScrollWidth = scrollWidth
    prevContextOpen = contextOpen
  }

  const schedule = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      frame = undefined
      update()
    })
  }

  const onWheel = (e: WheelEvent) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
    input.el.scrollLeft += e.deltaY > 0 ? 50 : -50
    e.preventDefault()
  }

  input.el.addEventListener("wheel", onWheel, { passive: false })
  const observer = new MutationObserver(schedule)
  observer.observe(input.el, { childList: true })

  return () => {
    input.el.removeEventListener("wheel", onWheel)
    observer.disconnect()
    if (frame !== undefined) cancelAnimationFrame(frame)
  }
}
