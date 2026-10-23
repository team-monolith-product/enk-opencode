import type { Plugin } from "@opencode/plugin"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parse, TextNode } from "node-html-parser"
import SOURCE from "../../../../docker/preview-bridge.js" with { type: "text" }

// 응답이 끝날 때마다 결과물에 미리보기 브릿지를 보강한다.
//   1) /__preview-bridge.js 번들 사본이 최신인지 보고 없거나 다르면 복사한다
//   2) 엔트리 HTML 의 <head> 맨 앞에 브릿지 <script> 를 멱등하게 넣는다(다른 스크립트보다 먼저 돌아야 초기 에러를 잡는다)
// 내용이 같으면 다시 쓰지 않는다(파일 감시 리로드 루프 방지). dist/ 같은 빌드 산출물은 건드리지 않는다.

type Context = Plugin.Context

// 텍스트로 불러오지만 타입 검사기는 JS 모듈로 보므로 문자열로 다룬다.
const BRIDGE = SOURCE as unknown as string

const SCRIPT_PATH = "/__preview-bridge.js"
export const FILENAME = "__preview-bridge.js"
const MARKER = "data-preview-bridge"
const TAG = `<script src="${SCRIPT_PATH}" ${MARKER}></script>`
const HTML_CANDIDATES = ["index.html", "public/index.html", "src/index.html"]
const TARGET_DIRS = [".", "public", "static"]

async function writeIfChanged(path: string, content: string) {
  if (existsSync(path) && (await readFile(path, "utf8").catch(() => undefined)) === content) return false
  await writeFile(path, content)
  return true
}

export function injectTag(html: string) {
  const root = parse(html, { comment: true })
  const head = root.querySelector("head")
  const existing = root.querySelector(`script[${MARKER}]`)
  if (existing && existing === root.querySelector("script") && (!head || existing.parentNode === head)) return html
  if (existing) {
    const previous = existing.previousSibling
    if (previous instanceof TextNode && previous.isWhitespace) previous.remove()
    existing.remove()
  }
  const target = head ?? root.querySelector("body") ?? root
  target.insertAdjacentHTML("afterbegin", TAG)
  return root.toString()
}

export async function heal(directory: string, source: string = BRIDGE) {
  if (!source) return
  for (const dir of TARGET_DIRS) {
    const target = dir === "." ? directory : join(directory, dir)
    if (!existsSync(target)) continue
    await writeIfChanged(join(target, FILENAME), source).catch(() => undefined)
  }
  for (const relative of HTML_CANDIDATES) {
    const path = join(directory, relative)
    if (!existsSync(path)) continue
    const html = await readFile(path, "utf8").catch(() => undefined)
    if (html === undefined) continue
    const next = injectTag(html)
    if (next !== html) await writeIfChanged(path, next).catch(() => undefined)
  }
}

export async function start(ctx: Context) {
  const directory = ctx.location.directory
  const sessions = new Set<string>()
  const controller = new AbortController()
  void (async () => {
    while (!controller.signal.aborted) {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const value = event as { type: string; location?: { directory?: string }; data?: { sessionID?: string } }
          const sessionID = value.data?.sessionID
          if (!sessionID) continue
          if (value.location) {
            if (value.location.directory === directory) sessions.add(sessionID)
            continue
          }
          if (
            value.type.startsWith("session.execution.") &&
            value.type !== "session.execution.started" &&
            sessions.has(sessionID)
          )
            void heal(directory).catch(() => undefined)
        }
      } catch {
        if (controller.signal.aborted) return
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  })()
  return () => controller.abort()
}

export * as PreviewBridge from "./preview-bridge"
