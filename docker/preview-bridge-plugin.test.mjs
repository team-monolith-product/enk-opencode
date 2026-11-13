// preview-bridge-plugin 유닛 테스트 (bun test).
// 빌드 산출물을 직접 불러와 session.idle 시 엔트리 HTML 주입 결과를 검증한다.
// PREVIEW_BRIDGE_PLUGIN 이 있으면 그 파일(packages/preview-bridge 의 test 가 소스에서 새로 빌드한 것)을,
// 없으면 docker/ 에 커밋된 빌드 결과를 검사한다.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const { default: plugin } = await import(
  process.env.PREVIEW_BRIDGE_PLUGIN
    ? pathToFileURL(resolve(process.env.PREVIEW_BRIDGE_PLUGIN)).href
    : "./preview-bridge-plugin.js"
)

const TAG = '<script src="/__preview-bridge.js" data-preview-bridge></script>'

let dir

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "preview-bridge-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function heal(html) {
  await writeFile(join(dir, "index.html"), html)
  const hooks = await plugin({ directory: dir })
  await hooks.event({ event: { type: "session.idle" } })
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

describe("preview-bridge-plugin 브릿지 사본 위치", () => {
  test("src/index.html 이 있으면 src 에도 브릿지를 둔다(src 를 서빙하는 경우)", async () => {
    await mkdir(join(dir, "src"))
    await writeFile(join(dir, "src", "index.html"), "<html><head></head><body></body></html>")
    const hooks = await plugin({ directory: dir })
    await hooks.event({ event: { type: "session.idle" } })
    expect(existsSync(join(dir, "__preview-bridge.js"))).toBe(true)
    expect(existsSync(join(dir, "src", "__preview-bridge.js"))).toBe(true)
  })

  test("index.html 없는 src(앱 소스 폴더)에는 두지 않는다", async () => {
    await mkdir(join(dir, "src"))
    await writeFile(join(dir, "src", "main.js"), "console.log(1)")
    const hooks = await plugin({ directory: dir })
    await hooks.event({ event: { type: "session.idle" } })
    expect(existsSync(join(dir, "src", "__preview-bridge.js"))).toBe(false)
  })

  test("파일 수정 때는 브릿지 사본만 두고 HTML 은 건드리지 않는다", async () => {
    const html = "<html><head></head><body><script>a()</script></body></html>"
    await writeFile(join(dir, "index.html"), html)
    const hooks = await plugin({ directory: dir })
    await hooks.event({ event: { type: "file.edited" } })
    expect(existsSync(join(dir, "__preview-bridge.js"))).toBe(true)
    expect(await readFile(join(dir, "index.html"), "utf8")).toBe(html)
  })
})
