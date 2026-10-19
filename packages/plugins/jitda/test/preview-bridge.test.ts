import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PreviewBridge } from "../src/preview-bridge"

const TAG = '<script src="/__preview-bridge.js" data-preview-bridge></script>'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "preview-bridge-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function heal(html: string) {
  await writeFile(join(dir, "index.html"), html)
  await PreviewBridge.heal(dir, "/* bridge */")
  return readFile(join(dir, "index.html"), "utf8")
}

describe("preview-bridge-plugin", () => {
  test("head 맨 앞, 인라인 스크립트보다 먼저 주입한다", async () => {
    const out = await heal(
      "<!DOCTYPE html>\n<html>\n<head>\n<title>t</title>\n<script>let x = 1</script>\n</head>\n<body><p>hi</p></body>\n</html>\n",
    )
    expect(out).toContain(`<head>${TAG}`)
    expect(out.indexOf(TAG)).toBeLessThan(out.indexOf("<script>let x"))
    expect(out.match(/data-preview-bridge/g)).toHaveLength(1)
  })

  test("body 끝에 있던 기존 태그를 head 맨 앞으로 옮긴다", async () => {
    const out = await heal(
      `<html>\n<head>\n<title>t</title>\n</head>\n<body>\n<script>taeche</script>\n  ${TAG}\n</body>\n</html>\n`,
    )
    expect(out).toContain(`<head>${TAG}`)
    expect(out).toContain("<script>taeche</script>\n</body>")
    expect(out.match(/data-preview-bridge/g)).toHaveLength(1)
  })

  test("이미 head 첫 스크립트면 파일을 다시 쓰지 않는다", async () => {
    const html = `<html>\n<head>\n<meta charset="utf-8">\n${TAG}\n<script>let x = 1</script>\n</head>\n<body></body>\n</html>\n`
    expect(await heal(html)).toBe(html)
  })

  test("두 번 돌려도 결과가 같다", async () => {
    const first = await heal("<html><head></head><body><script>a()</script></body></html>")
    expect(await heal(first)).toBe(first)
  })

  test("head 가 없으면 body 맨 앞에 주입한다", async () => {
    const out = await heal("<body><script>a()</script></body>")
    expect(out).toBe(`<body>${TAG}<script>a()</script></body>`)
  })
})

test("copies the bridge bundle only where it is missing or stale", async () => {
  await writeFile(join(dir, "index.html"), "<html><head></head></html>")
  await PreviewBridge.heal(dir, "/* v1 */")
  expect(await readFile(join(dir, PreviewBridge.FILENAME), "utf8")).toBe("/* v1 */")
  await PreviewBridge.heal(dir, "/* v2 */")
  expect(await readFile(join(dir, PreviewBridge.FILENAME), "utf8")).toBe("/* v2 */")
})
