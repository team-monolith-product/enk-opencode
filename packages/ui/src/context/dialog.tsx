import {
  createContext,
  createEffect,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  type Owner,
  type ParentProps,
  runWithOwner,
  useContext,
  type JSX,
} from "solid-js"
import { Dialog as Kobalte } from "@kobalte/core/dialog"

type DialogElement = () => JSX.Element

export type DialogOptions = {
  /**
   * false 면 바깥(오버레이) 클릭·Escape 로 닫지 않고, 닫기 버튼이나 dialog.close() 로만 닫는다.
   * 실수로 닫으면 되돌릴 수 없는 작업(저장 안 된 편집 등)을 담는 다이얼로그용. 기본 true.
   */
  dismissible?: boolean
}

type Active = {
  id: string
  node: JSX.Element
  dispose: () => void
  owner: Owner
  onClose?: () => void
  dismissible: boolean
  setClosing: (closing: boolean) => void
}

const Context = createContext<ReturnType<typeof init>>()

function init() {
  const [active, setActive] = createSignal<Active | undefined>()
  const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined }
  const lock = { value: false }

  onCleanup(() => {
    if (timer.current === undefined) return
    clearTimeout(timer.current)
    timer.current = undefined
  })

  const close = () => {
    const current = active()
    if (!current || lock.value) return
    lock.value = true
    current.onClose?.()
    current.setClosing(true)

    const id = current.id
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }

    timer.current = setTimeout(() => {
      timer.current = undefined
      current.dispose()
      if (active()?.id === id) setActive(undefined)
      lock.value = false
    }, 100)
  }

  createEffect(() => {
    if (!active()) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      if (!active()?.dismissible) return
      close()
      event.preventDefault()
      event.stopPropagation()
    }

    window.addEventListener("keydown", onKeyDown, true)
    onCleanup(() => window.removeEventListener("keydown", onKeyDown, true))
  })

  const show = (element: DialogElement, owner: Owner, onClose?: () => void, options?: DialogOptions) => {
    // Immediately dispose any existing dialog when showing a new one
    const current = active()
    if (current) {
      current.dispose()
      setActive(undefined)
    }

    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    lock.value = false

    const id = Math.random().toString(36).slice(2)
    let dispose: (() => void) | undefined
    let setClosing: ((closing: boolean) => void) | undefined
    const dismissible = options?.dismissible ?? true

    const node = runWithOwner(owner, () =>
      createRoot((d: () => void) => {
        dispose = d
        const [closing, setClosingSignal] = createSignal(false)
        setClosing = setClosingSignal
        return (
          <Kobalte
            modal
            open={!closing()}
            onOpenChange={(open: boolean) => {
              if (open) return
              close()
            }}
          >
            <Kobalte.Portal>
              <Kobalte.Overlay data-component="dialog-overlay" onClick={() => dismissible && close()} />
              {element()}
            </Kobalte.Portal>
          </Kobalte>
        )
      }),
    )

    if (!dispose || !setClosing) return

    setActive({ id, node, dispose, owner, onClose, dismissible, setClosing })
  }

  return {
    get active() {
      return active()
    },
    close,
    show,
  }
}

export function DialogProvider(props: ParentProps) {
  const ctx = init()
  return (
    <Context.Provider value={ctx}>
      {props.children}
      <div data-component="dialog-stack">{ctx.active?.node}</div>
    </Context.Provider>
  )
}

export function useDialog() {
  const ctx = useContext(Context)
  const owner = getOwner()

  if (!owner) {
    throw new Error("useDialog must be used within a DialogProvider")
  }
  if (!ctx) {
    throw new Error("useDialog must be used within a DialogProvider")
  }

  return {
    get active() {
      return ctx.active
    },
    show(element: DialogElement, onClose?: () => void, options?: DialogOptions) {
      const base = ctx.active?.owner ?? owner
      ctx.show(element, base, onClose, options)
    },
    close() {
      ctx.close()
    },
  }
}

/**
 * 지금 열린 다이얼로그를 바깥 클릭·Escape 로 닫아도 되는지. Dialog 컴포넌트가 Kobalte 의 바깥
 * 상호작용 닫힘을 막을 때 읽는다(Provider 밖이면 기본 true).
 */
export function useDialogDismissible() {
  const ctx = useContext(Context)
  return () => ctx?.active?.dismissible ?? true
}
