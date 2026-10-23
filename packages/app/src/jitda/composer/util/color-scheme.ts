import { createSignal, onCleanup } from "solid-js"

export type ColorSchemeMode = "light" | "dark"

/** 현재 색 구성. 테마 적용기(ui/theme/context)가 :root 에 써 두는 data-color-scheme 이 진실이고,
 *  아직 적용 전이면 OS 설정으로 폴백한다. */
export function readColorScheme(): ColorSchemeMode {
  const scheme = document.documentElement.getAttribute("data-color-scheme")
  if (scheme === "dark" || scheme === "light") return scheme
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

/** data-color-scheme 은 JS 가 갈아끼우는 DOM 속성이라 그 자체로는 반응형이 아니다 — 한 번 읽고
 *  마는 코드는 마운트 시점 색에 그대로 굳는다. 속성 변화와 OS 설정 변화를 함께 구독해서,
 *  BlockSuite 처럼 색을 내부 상태로 굽는 렌더러가 전환 때 다시 칠할 수 있게 한다. */
export function useColorScheme() {
  const [mode, setMode] = createSignal<ColorSchemeMode>(readColorScheme())
  const sync = () => setMode(readColorScheme())

  const observer = new MutationObserver(sync)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-color-scheme"] })

  const media = window.matchMedia("(prefers-color-scheme: dark)")
  media.addEventListener("change", sync)

  onCleanup(() => {
    observer.disconnect()
    media.removeEventListener("change", sync)
  })

  return mode
}
