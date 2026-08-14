import { createEffect, createSignal, onCleanup } from "solid-js"

/**
 * `active` 가 `delay` ms 넘게 유지될 때만 true 가 되는 신호.
 *
 * 로딩 표시를 이걸로 감싸면 캐시 히트처럼 즉시 끝나는 대기에서 스켈레톤이 한 프레임 번쩍이고
 * 사라지는 걸 막는다. `active` 가 꺼지면 지연 없이 즉시 false 로 떨어진다.
 */
export function useDelayed(active: () => boolean, delay = 180) {
  const [on, setOn] = createSignal(false)

  createEffect(() => {
    if (!active()) {
      setOn(false)
      return
    }

    const timer = window.setTimeout(() => setOn(true), delay)
    onCleanup(() => window.clearTimeout(timer))
  })

  return on
}
