import type { Plugin } from "@opencode/plugin"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

// 공유 갤러리에 올라갈 서비스 소개(title, description, usage)를 만든다. 짓다 프론트가 postMessage 로 부르고,
// 세션 기록에는 남기지 않는다. 워크스페이스 파일이 권위 있는 근거이고 대화 기록은 보조 단서다.

type Context = Plugin.Context

export type Summary = { title: string; description: string; usage: string }

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  ".vite",
  ".vscode",
  ".idea",
  "coverage",
])
const IGNORE_FILES = new Set(["bun.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", ".DS_Store"])
const BINARY_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".webm",
  ".wav",
  ".zip",
  ".tar",
  ".gz",
  ".pdf",
])
const MAX_FILES = 500
const MAX_DEPTH = 8
const PER_FILE_CAP = 8 * 1024
const TOTAL_BODY_BUDGET = 64 * 1024
const ENTRY_HINTS = [
  /(^|\/)README(\.|$)/i,
  /(^|\/)package\.json$/,
  /(^|\/)pyproject\.toml$/,
  /(^|\/)Cargo\.toml$/,
  /(^|\/)go\.mod$/,
  /(^|\/)index\.html$/,
  /(^|\/)src\/main\.[jt]sx?$/,
  /(^|\/)src\/App\.[jt]sx?$/,
  /(^|\/)src\/index\.[jt]sx?$/,
  /(^|\/)app\/page\.[jt]sx?$/,
]
const PATH_REGEX = /[\w./-]+\.(?:tsx?|jsx?|html|css|scss|md|json|py|go|rs|java|kt|rb|swift|vue|svelte|toml|yaml|yml)\b/g

export async function collectFiles(root: string) {
  const out: string[] = []
  const walk = async (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue
        await walk(path.join(dir, entry.name), depth + 1)
      } else if (entry.isFile()) {
        if (IGNORE_FILES.has(entry.name) || entry.name.startsWith(".env")) continue
        if (BINARY_EXT.has(path.extname(entry.name).toLowerCase())) continue
        out.push(path.relative(root, path.join(dir, entry.name)))
      }
    }
  }
  await walk(root, 0)
  return out
}

export function rankFiles(files: string[], transcript: string) {
  const mentioned = new Set(transcript.match(PATH_REGEX) ?? [])
  const score = (file: string) => {
    let value = 0
    for (const hint of ENTRY_HINTS) if (hint.test(file)) value += 1000
    for (const item of mentioned)
      if (file === item || file.endsWith("/" + item) || item.endsWith("/" + file)) value += 500
    return value
  }
  return [...files].sort((a, b) => score(b) - score(a))
}

export async function workspaceContext(root: string, transcript: string) {
  const files = await collectFiles(root)
  if (files.length === 0) return ""
  let used = 0
  const bodies: string[] = []
  for (const relative of rankFiles(files, transcript)) {
    if (used >= TOTAL_BODY_BUDGET) break
    const raw = await readFile(path.join(root, relative), "utf8").catch(() => undefined)
    if (raw === undefined) continue
    const text = raw.length > PER_FILE_CAP ? raw.slice(0, PER_FILE_CAP) + "\n... (truncated)" : raw
    const block = `=== ${relative} ===\n${text}\n`
    const remain = TOTAL_BODY_BUDGET - used
    if (block.length > remain) {
      if (remain > 200) bodies.push(block.slice(0, remain) + "\n... (truncated)")
      break
    }
    bodies.push(block)
    used += block.length
  }
  return ["워크스페이스 트리:", [...files].sort().join("\n"), "", "핵심 파일:", bodies.join("\n")].join("\n")
}

const SYSTEM = [
  "당신은 공유 갤러리에 올라갈 '서비스 소개글' 을 작성합니다.",
  "독자는 코드를 읽지 않는 일반 사용자입니다. 결과물(앱/서비스) 자체를 소개하세요.",
  "절대 금지: 기술 스택, 라이브러리·프레임워크 이름, 구현 방식, 파일/함수/API 이름, 코드 용어, 디버깅 과정, '구현했습니다/추가했습니다' 같은 개발자 시점 표현.",
  "transcript 의 언어와 같은 언어로 답변하세요.",
  '응답은 {"title": string, "description": string, "usage": string} 형태의 JSON 객체 하나만 출력하세요.',
].join(" ")

export function prompt(transcript: string, workspace: string) {
  return `${SYSTEM}

다음 작업 기록과 워크스페이스 상태를 바탕으로, 이 결과물을 '서비스 소개' 형태로 정리하세요. 워크스페이스 트리와 핵심 파일이 실제 만들어진 결과물의 권위 있는 근거이며, 작업 기록은 보조 단서입니다. 둘 사이가 충돌하면 워크스페이스를 우선합니다.

각 필드 가이드:
- title: 서비스의 이름 또는 한 줄 정체성. 60자 이내. 예) "증권 리서치 자동화 도구".
- description: 이 서비스가 사용자에게 무엇을 해주는지 한두 문장으로. 기술이 아니라 '가치/효용'. 예) "뉴스와 리서치 데이터를 자동으로 수집하여 종목별 분석 리포트를 만들어주는 도구입니다."
- usage: 사용자가 이 서비스를 쓰는 단계를 한 줄에 한 단계씩, 번호 없이 줄바꿈으로 구분. 각 단계는 명령형 문장. 예)
  "종목코드를 입력합니다
  기간을 선택합니다
  분석 시작 버튼을 클릭합니다"

작업 기록:
${transcript || "(empty)"}

${workspace || "(워크스페이스 비어있음)"}`
}

// 모델이 코드 블록이나 앞뒤 말을 붙여도 첫 JSON 객체를 꺼낸다.
export function parse(text: string): Summary | undefined {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "")
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined
  const value = (() => {
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
    } catch {
      return undefined
    }
  })()
  if (!value) return undefined
  const field = (name: string) => (typeof value[name] === "string" ? (value[name] as string) : "")
  return { title: field("title"), description: field("description"), usage: field("usage") }
}

type Message = {
  type: string
  text?: string
  content?: Array<{ type: string; text?: string }>
  model?: { providerID: string; id: string }
}

export function transcript(messages: ReadonlyArray<Message>) {
  return messages
    .map((message) => {
      if (message.type === "user") return message.text?.trim() ? `[user] ${message.text}` : ""
      if (message.type !== "assistant") return ""
      const text = (message.content ?? [])
        .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
        .join("\n")
      return text.trim() ? `[assistant] ${text}` : ""
    })
    .filter(Boolean)
    .join("\n\n")
}

export const Rpc = {
  id: "jitda.project-summary",
  methods: {
    generate: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: { type: "object", additionalProperties: true },
    },
  },
  events: {},
} as const

export async function start(ctx: Context) {
  const registration = await ctx.rpc.register(Rpc, {
    generate: async (raw) => {
      const sessionID = (raw as { sessionID: string }).sessionID
      const messages = (await ctx.session.context({ sessionID })) as unknown as Message[]
      const text = transcript(messages)
      const workspace = await workspaceContext(ctx.location.directory, text)
      if (!text.trim() && !workspace) return { title: "", description: "", usage: "" }
      const model = messages.findLast((message) => message.type === "assistant" && message.model)?.model
      const result = await ctx.generate.text({
        prompt: prompt(text, workspace),
        ...(model ? { model: { providerID: model.providerID, id: model.id } } : {}),
      })
      return parse(result.text) ?? { title: "", description: "", usage: "" }
    },
  })
  return () => registration.dispose()
}

export * as ProjectSummary from "./project-summary"
