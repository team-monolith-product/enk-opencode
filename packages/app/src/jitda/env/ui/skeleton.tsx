import { type ComponentProps, splitProps } from "solid-js"
import "./skeleton.css"

// V1 Skeleton. V2 UI 키트에는 없다.
export interface SkeletonProps extends ComponentProps<"div"> {
  width?: number | string
  height?: number | string
  shape?: "line" | "block" | "circle"
  delay?: number
}

const size = (value: number | string | undefined) => (typeof value === "number" ? `${value}px` : value)

export function Skeleton(props: SkeletonProps) {
  const [split, rest] = splitProps(props, ["width", "height", "shape", "delay", "class", "classList", "style"])
  return (
    <div
      {...rest}
      aria-hidden="true"
      data-component="skeleton"
      data-shape={split.shape ?? "line"}
      classList={{
        ...(split.classList ?? {}),
        [split.class ?? ""]: !!split.class,
      }}
      style={{
        ...(typeof split.style === "object" ? split.style : {}),
        ...(split.width === undefined ? {} : { width: size(split.width) }),
        ...(split.height === undefined ? {} : { height: size(split.height) }),
        ...(split.delay === undefined ? {} : { "animation-delay": `${-split.delay}s` }),
      }}
    />
  )
}
