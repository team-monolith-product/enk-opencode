import {
  createBeforeLeave,
  createRouter,
  keepDepth,
  notifyIfNotBlocked,
  saveCurrentDepth,
  type BaseRouterProps,
} from "@solidjs/router"

// Router 의 base 는 location.pathname 에 prefix 를 남겨 경로를 직접 파싱하는 코드가 깨진다.
// 브라우저 주소에서만 prefix 를 붙이고 떼서 앱 안에서는 루트에서 도는 것처럼 보이게 한다.
export function PrefixRouter(props: BaseRouterProps & { prefix: string }) {
  const source = () => {
    const path = window.location.pathname
    const owned = path === props.prefix || path.startsWith(`${props.prefix}/`)
    const inner = owned ? path.slice(props.prefix.length) || "/" : path
    const history = window.history.state
    const state = history && history._depth && Object.keys(history).length === 1 ? undefined : history

    return { value: inner + window.location.search + window.location.hash, state }
  }

  const beforeLeave = createBeforeLeave()

  return createRouter({
    get: source,
    set({ value, replace, state }) {
      if (replace) window.history.replaceState(keepDepth(state), "", props.prefix + value)
      else window.history.pushState(state, "", props.prefix + value)
      saveCurrentDepth()
    },
    init: (notify) => {
      const handler = notifyIfNotBlocked(notify, (delta) => {
        if (delta) return !beforeLeave.confirm(delta)

        const next = source()

        return !beforeLeave.confirm(next.value, { state: next.state })
      })

      window.addEventListener("popstate", handler)

      return () => window.removeEventListener("popstate", handler)
    },
    utils: { go: (delta: number) => window.history.go(delta), beforeLeave },
  })(props)
}
