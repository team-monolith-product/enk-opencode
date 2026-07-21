import { createEffect } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"

function initial() {
  if (typeof document === "object") {
    const fromDom = document.documentElement.getAttribute("data-theme")
    if (fromDom === "dark" || fromDom === "light") return fromDom
  }
  return "light"
}

export const { use: useTheme, provider: ThemeProvider } = createSimpleContext({
  name: "Theme",
  init: () => {
    const [store, setStore] = createStore({
      theme: initial(),
    })

    // Reflect the theme onto the DOM only. Deliberately does NOT persist here: writing localStorage on
    // mount would pin the initially-resolved theme and permanently defeat the entry-server FOUC script's
    // `prefers-color-scheme` fallback (its `!t` branch), so a later OS light/dark switch would be ignored.
    createEffect(() => {
      if (typeof document !== "object") return
      document.documentElement.setAttribute("data-theme", store.theme)
    })

    // Persist only on an explicit user choice, so an absent key keeps meaning "follow the system".
    const persist = (next: "light" | "dark") => {
      if (typeof localStorage === "object") localStorage.setItem("theme", next)
    }

    return {
      theme: () => store.theme,
      isDark: () => store.theme === "dark",
      setTheme(next: "light" | "dark") {
        setStore("theme", next)
        persist(next)
      },
      toggle() {
        const next = store.theme === "dark" ? "light" : "dark"
        setStore("theme", next)
        persist(next)
      },
    }
  },
})
