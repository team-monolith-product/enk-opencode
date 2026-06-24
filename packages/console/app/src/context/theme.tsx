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

    createEffect(() => {
      if (typeof document !== "object") return
      document.documentElement.setAttribute("data-theme", store.theme)
      localStorage.setItem("theme", store.theme)
    })

    return {
      theme: () => store.theme,
      isDark: () => store.theme === "dark",
      setTheme(next: "light" | "dark") {
        setStore("theme", next)
      },
      toggle() {
        setStore("theme", store.theme === "dark" ? "light" : "dark")
      },
    }
  },
})
