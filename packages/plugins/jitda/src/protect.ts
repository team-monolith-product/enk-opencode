import type { Plugin } from "@opencode/plugin"
import { Env } from "./env"
import { Guard } from "./guard"
import { Secret } from "./secret"

type Context = Plugin.Context

const GUARD_MESSAGE =
  "이 경로나 명령은 시크릿을 보호하기 위해 막혀 있습니다. .env 값이나 프로세스 환경은 읽을 수 없습니다."

// 검색 결과에 .env 계열 파일 줄이 섞이지 않게 한다. 경로 구분자 뒤나 줄 맨 앞의 .env 파일 이름을 본다.
const ENV_PATH = /(^|[\\/\s])\.env(\.(?!example\b)[^\s:\\/]+)?(?=[:\s]|$)/

// grep 은 "경로:" 머리줄 아래에 들여쓴 일치 줄을 묶어 내고, glob 은 경로를 한 줄씩 낸다. .env 계열 파일이면 머리줄과
// 그 아래 묶음까지 통째로 뺀다.
export function filterSearch(text: string) {
  const out: string[] = []
  let skipping = false
  for (const line of text.split("\n")) {
    const indented = /^\s/.test(line)
    if (skipping && (indented || line === "")) {
      if (line === "") skipping = false
      continue
    }
    skipping = false
    if (!indented && ENV_PATH.test(line)) {
      skipping = /:\s*$/.test(line)
      continue
    }
    out.push(line)
  }
  return out.join("\n")
}

async function redactValue(value: unknown, dir: string): Promise<unknown> {
  if (typeof value === "string") return Secret.redact(value, dir)
  if (value === undefined || value === null) return value
  const text = JSON.stringify(value)
  const redacted = await Secret.redact(text, dir)
  return redacted === text ? value : JSON.parse(redacted)
}

export async function protectResult(
  tool: string,
  result: { content?: unknown; output?: unknown; metadata?: unknown },
  dir: string,
) {
  const search = tool === "grep" || tool === "glob"
  const text = async (value: string) => Secret.redact(search ? filterSearch(value) : value, dir)
  const content =
    typeof result.content === "string"
      ? await text(result.content)
      : Array.isArray(result.content)
        ? await Promise.all(
            result.content.map(async (item: { type: string; text?: string }) =>
              item.type === "text" && typeof item.text === "string" ? { ...item, text: await text(item.text) } : item,
            ),
          )
        : result.content
  return {
    ...result,
    ...(result.content === undefined ? {} : { content }),
    ...(result.output === undefined ? {} : { output: await redactValue(result.output, dir) }),
    ...(result.metadata === undefined ? {} : { metadata: await redactValue(result.metadata, dir) }),
  }
}

export async function start(ctx: Context) {
  const directory = ctx.location.directory
  const registrations = [
    await ctx.permission.hook("evaluate", (event) => {
      if (!Guard.denied(event.action, event.resources)) return
      event.effect = "deny"
      event.message = GUARD_MESSAGE
    }),
    // 셸 환경은 allowlist 로 거르고, 프로젝트 .env 키는 지운다(앱은 받지만 에이전트 셸은 못 본다).
    await ctx.shell.hook("create.before", async (event) => {
      const keys = await Env.envFileKeys(directory)
      const env: Record<string, string | undefined> = { ...Env.mask({ base: event.env as NodeJS.ProcessEnv }) }
      for (const key of keys) env[key] = undefined
      for (const [key, value] of Object.entries(env)) if (value === undefined) event.env[key] = undefined
    }),
    await ctx.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed") return
      event.result = (await protectResult(event.tool, event.result, directory)) as typeof event.result
    }),
  ]
  return async () => {
    for (const registration of registrations) await registration.dispose()
  }
}

export * as Protect from "./protect"
