import { describe, expect, test } from "bun:test"
import { buildWorkerBootstrap } from "./create-worker"

describe("cross-origin worker bootstrap", () => {
  const href = "https://cdn.example.com/assets/worker-abc123.js"
  const boot = buildWorkerBootstrap(href)

  test("imports the CDN worker dynamically, not with a hoisted static import", () => {
    expect(boot).not.toMatch(/(^|\n)\s*import\s+["']/)
    expect(boot).toContain(`import(${JSON.stringify(href)})`)
  })

  test("registers a message buffer BEFORE importing the CDN worker", () => {
    const listenAt = boot.indexOf('addEventListener("message"')
    const importAt = boot.indexOf("import(")
    expect(listenAt).toBeGreaterThanOrEqual(0)
    expect(importAt).toBeGreaterThan(listenAt)
  })

  test("replays buffered messages once the CDN worker has loaded", () => {
    expect(boot).toContain('removeEventListener("message"')
    expect(boot).toContain('dispatchEvent(new MessageEvent("message"')
  })
})
