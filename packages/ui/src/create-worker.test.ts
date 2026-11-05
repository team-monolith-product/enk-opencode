import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { buildWorkerBootstrap } from "./create-worker"

// 자산이 CDN 에 있으면 직접 new Worker 는 SecurityError 를 낸다. 브라우저 코드 전체를 스캔해 막는다.
const PACKAGES = join(import.meta.dir, "../..")
const CONSTRUCT_RE = /\bnew\s+(?:Shared)?Worker\s*\(/

describe("worker construction guard", () => {
  test("browser code constructs workers only via createWorker()", async () => {
    const offenders: string[] = []
    for (const pkg of ["app", "session-ui", "ui", "gui-extensions"]) {
      for await (const rel of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: join(PACKAGES, pkg, "src") })) {
        if (/\.test\.tsx?$/.test(rel) || `${pkg}/${rel}` === "ui/create-worker.ts") continue
        if (CONSTRUCT_RE.test(readFileSync(join(PACKAGES, pkg, "src", rel), "utf8"))) offenders.push(`${pkg}/${rel}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

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
