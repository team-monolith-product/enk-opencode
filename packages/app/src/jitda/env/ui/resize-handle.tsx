import { Show, splitProps, type JSX } from "solid-js"
import "./resize-handle.css"

// V1 packages/ui ResizeHandle(pointer capture + body[data-resizing] 로 iframe 위 드래그가 끊기지 않게 한다).

export interface ResizeHandleProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "onResize"> {
  direction: "horizontal" | "vertical"
  edge?: "start" | "end"
  size: number
  min: number
  max: number
  onResize: (size: number) => void
  onCollapse?: () => void
  collapseThreshold?: number
  showHandle?: boolean
}

export function ResizeHandle(props: ResizeHandleProps) {
  const [local, rest] = splitProps(props, [
    "direction",
    "edge",
    "size",
    "min",
    "max",
    "onResize",
    "onCollapse",
    "collapseThreshold",
    "class",
    "classList",
    "showHandle",
  ])

  let handleRef!: HTMLDivElement

  const handlePointerDown = (e: PointerEvent) => {
    e.preventDefault()
    const edge = local.edge ?? (local.direction === "vertical" ? "start" : "end")
    const start = local.direction === "horizontal" ? e.clientX : e.clientY
    const startSize = local.size
    let current = startSize

    document.body.style.userSelect = "none"
    document.body.style.overflow = "hidden"
    document.body.dataset.resizing = "true"

    handleRef.setPointerCapture(e.pointerId)

    const onPointerMove = (moveEvent: PointerEvent) => {
      const pos = local.direction === "horizontal" ? moveEvent.clientX : moveEvent.clientY
      const delta =
        local.direction === "vertical"
          ? edge === "end"
            ? pos - start
            : start - pos
          : edge === "start"
            ? start - pos
            : pos - start
      current = startSize + delta
      const clamped = Math.min(local.max, Math.max(local.min, current))
      local.onResize(clamped)
    }

    const finish = (upEvent: PointerEvent) => {
      document.body.style.userSelect = ""
      document.body.style.overflow = ""
      delete document.body.dataset.resizing
      handleRef.releasePointerCapture(upEvent.pointerId)
      handleRef.removeEventListener("pointermove", onPointerMove)
      handleRef.removeEventListener("pointerup", finish)
      handleRef.removeEventListener("pointercancel", finish)
    }

    const onPointerUp = (upEvent: PointerEvent) => {
      finish(upEvent)
      const threshold = local.collapseThreshold ?? 0
      if (local.onCollapse && threshold > 0 && current < threshold) {
        local.onCollapse()
      }
    }

    handleRef.addEventListener("pointermove", onPointerMove)
    handleRef.addEventListener("pointerup", onPointerUp)
    handleRef.addEventListener("pointercancel", finish)
  }

  return (
    <div
      {...rest}
      ref={handleRef}
      data-component="resize-handle"
      data-direction={local.direction}
      data-edge={local.edge ?? (local.direction === "vertical" ? "start" : "end")}
      classList={{
        ...(local.classList ?? {}),
        "justify-center items-center group flex": true,
        [local.class ?? ""]: !!local.class,
      }}
      onPointerDown={handlePointerDown}
    >
      <Show when={local.showHandle}>
        <div
          classList={{
            "rounded-none bg-border-base transition-colors group-hover:bg-border-strong-base": true,
            "h-18 w-0.5": local.direction === "horizontal",
            "w-18 h-0.5": local.direction === "vertical",
          }}
        />
      </Show>
    </div>
  )
}
