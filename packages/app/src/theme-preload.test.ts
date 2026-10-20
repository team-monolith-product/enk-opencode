import { beforeEach, describe, expect, test } from "bun:test"

const src = await Bun.file(new URL("../public/oc-theme-preload.js", import.meta.url)).text()

const run = () => Function(src)()

const setSystemDark = (matches: boolean) =>
  Object.defineProperty(window, "matchMedia", {
    value: () => ({ matches }) as MediaQueryList,
    configurable: true,
  })

beforeEach(() => {
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-color-scheme")
  document.documentElement.style.removeProperty("background-color")
  localStorage.clear()
  setSystemDark(false)
})

describe("theme preload", () => {
  test.each([
    { stored: undefined, systemDark: false, scheme: "light", background: "#f4f2ec" },
    { stored: "dark", systemDark: false, scheme: "light", background: "#f4f2ec" },
    { stored: "light", systemDark: true, scheme: "dark", background: "#14130f" },
    { stored: "system", systemDark: true, scheme: "dark", background: "#14130f" },
  ])(
    "pins jitda and follows the system scheme $scheme whatever was stored ($stored, system dark: $systemDark)",
    ({ stored, systemDark, scheme, background }) => {
      setSystemDark(systemDark)
      localStorage.setItem("opencode-theme-id", "nightowl")

      if (stored) localStorage.setItem("opencode-color-scheme", stored)
      run()

      expect(document.documentElement.dataset.theme).toBe("jitda")
      expect(document.documentElement.dataset.colorScheme).toBe(scheme)
      expect(document.documentElement.style.backgroundColor).toBe(background)
      expect(localStorage.getItem("opencode-theme-id")).toBe("jitda")
      expect(localStorage.getItem("opencode-color-scheme")).toBe("system")
    },
  )

  test.each([
    { systemDark: false, key: "opencode-theme-css-light", css: "--background-base:#fff;", expected: "light" },
    { systemDark: true, key: "opencode-theme-css-dark", css: "--background-base:#010203;", expected: "dark" },
  ])("restores the cached $expected css of the jitda theme", ({ systemDark, key, css, expected }) => {
    setSystemDark(systemDark)
    localStorage.setItem(key, css)
    run()

    expect(document.documentElement.dataset.colorScheme).toBe(expected)
    expect(document.getElementById("oc-theme-preload")?.textContent).toContain(css)
  })
})
