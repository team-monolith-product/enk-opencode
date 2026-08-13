import { type ComponentProps, splitProps } from "solid-js"

export interface SkeletonProps extends ComponentProps<"div"> {
  /** 숫자는 px, 문자열은 CSS 값 그대로. 생략하면 부모가 정한다. */
  width?: number | string
  height?: number | string
  shape?: "line" | "block" | "circle"
  /** 스윕 위상을 초 단위로 어긋낸다. 여러 줄이 한 몸처럼 번쩍이는 걸 막는 용도. */
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
        // 음수 delay 라야 첫 사이클부터 이미 어긋난 위상으로 시작한다.
        ...(split.delay === undefined ? {} : { "animation-delay": `${-split.delay}s` }),
      }}
    />
  )
}
