;(function () {
  // 짓다 웹은 jitda 테마·시스템 색 모드로 고정한다(packages/app/src/app.tsx 의 ThemeProvider pinned 와 같은 값).
  var themeId = "jitda"
  var scheme = "system"
  localStorage.setItem("opencode-theme-id", themeId)
  localStorage.setItem("opencode-color-scheme", scheme)

  var isDark = matchMedia("(prefers-color-scheme: dark)").matches
  var mode = isDark ? "dark" : "light"

  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode
  document.documentElement.style.backgroundColor = isDark ? "#14130f" : "#f4f2ec"

  var metas = document.querySelectorAll("meta[name='theme-color']")
  if (metas.length > 0) metas[0].setAttribute("content", isDark ? "#14130f" : "#f4f2ec")

  var css = localStorage.getItem("opencode-theme-css-" + mode)
  if (css) {
    var style = document.createElement("style")
    style.id = "oc-theme-preload"
    style.textContent =
      ":root{color-scheme:" +
      mode +
      ";--text-mix-blend-mode:" +
      (isDark ? "plus-lighter" : "multiply") +
      ";" +
      css +
      "}"
    document.head.appendChild(style)
  }
})()
