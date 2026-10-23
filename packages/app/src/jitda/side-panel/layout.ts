import { createEffect, createMemo, createRoot } from "solid-js"
import { createStore, produce } from "solid-js/store"

// V1 context/layout 의 파일 트리·세션 폭·세션 탭 상태. V2 레이아웃은 이 패널을 모르므로 짓다가 직접 보관한다.
export const MIN_FILE_TREE_WIDTH = 240
export const MAX_FILE_TREE_WIDTH = 360
const DEFAULT_FILE_TREE_WIDTH = MIN_FILE_TREE_WIDTH
const DEFAULT_SESSION_WIDTH = 600
const MAX_SESSION_KEYS = 50
const KEY = "jitda.side-panel.v1"

type SessionTabs = { all: string[]; active?: string }

const pseudo = (tab: string) => tab === "review" || tab === "preview"

type State = {
  fileTree: { opened: boolean; width: number; tab: "changes" | "all" }
  session: { width: number }
  tabs: Record<string, SessionTabs>
}

const initial = (): State => ({
  fileTree: { opened: false, width: DEFAULT_FILE_TREE_WIDTH, tab: "changes" },
  session: { width: DEFAULT_SESSION_WIDTH },
  tabs: {},
})

function load(): State {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return initial()
    const value = JSON.parse(raw) as Partial<State>
    const base = initial()
    return {
      fileTree: { ...base.fileTree, ...value.fileTree },
      session: { ...base.session, ...value.session },
      tabs: value.tabs && typeof value.tabs === "object" ? value.tabs : {},
    }
  } catch {
    return initial()
  }
}

const [store, setStore] = createStore<State>(load())

createRoot(() => {
  createEffect(() => {
    const value = JSON.stringify(store)
    try {
      localStorage.setItem(KEY, value)
    } catch {
      /* 저장 불가(시크릿 창 등)면 메모리에만 둔다 */
    }
  })
})

const touch = (key: string) =>
  setStore(
    "tabs",
    produce((tabs) => {
      const keys = Object.keys(tabs)
      if (keys.length <= MAX_SESSION_KEYS || tabs[key]) return
      delete tabs[keys[0]!]
    }),
  )

export const sidePanelLayout = {
  fileTree: {
    opened: () => store.fileTree.opened,
    width: () => Math.min(MAX_FILE_TREE_WIDTH, Math.max(MIN_FILE_TREE_WIDTH, store.fileTree.width)),
    tab: () => store.fileTree.tab,
    setTab: (tab: "changes" | "all") => setStore("fileTree", "tab", tab),
    open: () => setStore("fileTree", "opened", true),
    close: () => setStore("fileTree", "opened", false),
    toggle: () => setStore("fileTree", "opened", (x) => !x),
    resize: (width: number) => setStore("fileTree", "width", width),
  },
  session: {
    width: () => store.session.width,
    resize: (width: number) => setStore("session", "width", width),
  },
}

export function createSessionTabStore(key: () => string) {
  const current = createMemo(() => store.tabs[key()] ?? { all: [] })
  const ensure = () => {
    const id = key()
    if (store.tabs[id]) return id
    touch(id)
    setStore("tabs", id, { all: [] })
    return id
  }

  return {
    active: () => current().active,
    all: () => current().all.filter((tab) => !pseudo(tab)),
    setActive: (tab: string | undefined) => setStore("tabs", ensure(), "active", tab),
    open: (tab: string) => {
      const id = ensure()
      setStore(
        "tabs",
        id,
        produce((value) => {
          if (pseudo(tab)) value.all = value.all.filter((x) => x !== tab)
          else if (!value.all.includes(tab)) value.all.push(tab)
          value.active = tab
        }),
      )
    },
    close: (tab: string) => {
      const id = ensure()
      setStore(
        "tabs",
        id,
        produce((value) => {
          if (pseudo(tab)) {
            if (value.active === tab) value.active = value.all[0]
            return
          }
          const index = value.all.indexOf(tab)
          const all = value.all.filter((x) => x !== tab)
          if (value.active === tab) value.active = value.all[index - 1] ?? value.all[index + 1] ?? all[0]
          value.all = all
        }),
      )
    },
    move: (tab: string, to: number) => {
      const id = ensure()
      setStore(
        "tabs",
        id,
        "all",
        produce((all) => {
          const from = all.indexOf(tab)
          if (from === -1) return
          all.splice(from, 1)
          all.splice(to, 0, tab)
        }),
      )
    },
  }
}

export type SessionTabStore = ReturnType<typeof createSessionTabStore>

// 리사이즈 드래그 중에는 폭 transition 을 끈다(V1 createSizing). 세션 폭 핸들은 채팅 컬럼(리드 소유)에, 파일 트리
// 핸들은 이 패널에 있어 둘이 같은 상태를 봐야 하므로 모듈 단위로 둔다.
const [sizing, setSizing] = createStore({ active: false })
let sizingTimer: number | undefined
let sizingBound = false

const stopSizing = () => {
  if (sizingTimer !== undefined) window.clearTimeout(sizingTimer)
  sizingTimer = undefined
  setSizing("active", false)
}

const startSizing = () => {
  if (!sizingBound && typeof window !== "undefined") {
    sizingBound = true
    window.addEventListener("pointerup", stopSizing)
    window.addEventListener("pointercancel", stopSizing)
    window.addEventListener("blur", stopSizing)
  }
  if (sizingTimer !== undefined) window.clearTimeout(sizingTimer)
  sizingTimer = undefined
  setSizing("active", true)
}

export const panelSizing = {
  active: () => sizing.active,
  start: startSizing,
  touch: () => {
    startSizing()
    sizingTimer = window.setTimeout(stopSizing, 120)
  },
}
