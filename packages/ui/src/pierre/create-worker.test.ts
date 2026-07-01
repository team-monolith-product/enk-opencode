import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

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
      // 주석 속 예시 문구가 아니라 실제 코드만 검사하도록 블록·라인 주석을 먼저 제거한다.
      const code = readFileSync(join(SRC_ROOT, rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
      if (CONSTRUCT_RE.test(code)) offenders.push(rel)
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
