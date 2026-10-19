export function basePath() {
  if (typeof document === "undefined") return ""

  return document.querySelector("base")?.getAttribute("href")?.replace(/\/+$/, "") ?? ""
}
