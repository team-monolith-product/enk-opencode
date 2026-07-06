import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { buildWorkerBootstrap } from "./create-worker"

// packages/ui/src 전체를 스캔해 raw worker 생성을 금지한다. CDN 자산 base 에서 워커는
// same-origin blob 부트스트랩(create-worker.ts)을 거쳐야 하며, 직접 new Worker 는 cross-origin
// SecurityError 를 낸다(INF-336). 도메인이 다른 패키지에 워커가 생기면 그곳에도 같은 가드를 둔다.
const SRC_ROOT = join(import.meta.dir, "..")
const ALLOWED = "pierre/create-worker.ts"
const CONSTRUCT_RE = /\bnew\s+(?:Shared)?Worker\s*\(/

describe("worker construction guard", () => {
  test("browser code constructs workers only via createWorker()", async () => {
    const offenders: string[] = []
    for await (const rel of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: SRC_ROOT })) {
      if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue
      if (rel === ALLOWED) continue
      if (CONSTRUCT_RE.test(readFileSync(join(SRC_ROOT, rel), "utf8"))) offenders.push(rel)
    }

    if (offenders.length > 0) {
      throw new Error(
        `Raw "new Worker"/"new SharedWorker" outside pierre/create-worker.ts: ${offenders.join(", ")}. ` +
          `Use createWorker() so workers stay same-origin under the CDN asset base (INF-336).`,
      )
    }
    expect(offenders).toEqual([])
  })
})

describe("cross-origin worker bootstrap", () => {
  const href = "https://cdn.example.com/assets/worker-abc123.js"
  const boot = buildWorkerBootstrap(href)

  test("imports the CDN worker dynamically, not with a hoisted static import", () => {
    // 정적 `import "..."` 는 hoisting 되어 동기 리스너 앞에 평가되므로 조기 메시지가 유실된다.
    expect(boot).not.toMatch(/(^|\n)\s*import\s+["']/)
    expect(boot).toContain(`import(${JSON.stringify(href)})`)
  })

  test("registers a message buffer BEFORE importing the CDN worker", () => {
    // 워커 포트가 CDN 모듈 로드보다 먼저 enable 돼도 조기 메시지를 잃지 않으려면
    // 동기 message 리스너가 import 보다 먼저 있어야 한다.
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
