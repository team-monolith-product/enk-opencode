import type { Plugin } from "@opencode/plugin"
import { Assets } from "./assets"

// 사용자 화면 언어(ko/en)대로 답하고 생각하게 하는 지시와, 업로드 폴더 안내를 매 모델 호출의 시스템 프롬프트 끝에 붙인다.
// 화면 언어는 프롬프트 metadata.locale 로 오고, 세션별로 기억한다. 서브에이전트는 부모의 언어를 따른다.

type Context = Plugin.Context

export type Locale = "ko" | "en"

const DIRECTIVE: Record<Locale, string> = {
  en: [
    "<response_language>",
    "The user's interface language is English.",
    "- Write every user-visible sentence in English: acknowledgements, change summaries, questions, refusals.",
    "- Think in English as well. Do not open your reasoning in another language.",
    "- Keep code, identifiers, file paths, shell commands, and URLs exactly as they are.",
    "- Tone: friendly, short sentences, one step at a time, encouraging. Use the same polite, warm register the instructions above describe for Korean.",
    "</response_language>",
  ].join("\n"),
  ko: [
    "<response_language>",
    "사용자의 화면 언어는 한국어입니다.",
    "- 사용자에게 보이는 모든 문장(진행 안내·변경 요약·질문·거절)은 한국어 존댓말로 씁니다.",
    "- 사고(thinking)도 한국어로 합니다. 다른 언어로 사고를 열지 않습니다.",
    "- 코드·식별자·파일 경로·셸 명령·URL 은 그대로 둡니다.",
    "</response_language>",
  ].join("\n"),
}

export function directive(locale?: Locale) {
  return DIRECTIVE[locale ?? "ko"]
}

export function parse(value: unknown): Locale | undefined {
  return value === "ko" || value === "en" ? value : undefined
}

export async function start(ctx: Context) {
  const locales = new Map<string, Locale>()
  const lookup = async (sessionID: string): Promise<Locale> => {
    const known = locales.get(sessionID)
    if (known) return known
    const session = await ctx.session.get({ sessionID }).catch(() => undefined)
    const parent = (session as { parentID?: string } | undefined)?.parentID
    const value = parent ? await lookup(parent) : "ko"
    locales.set(sessionID, value)
    return value
  }
  const registrations = [
    await ctx.session.hook("prompt", (event) => {
      const value = parse(event.metadata?.locale)
      if (value) locales.set(event.sessionID, value)
    }),
    await ctx.session.hook("context", async (event) => {
      const uploads = Assets.prompt(ctx.location.directory)
      event.system.push({
        type: "text",
        text: [uploads, directive(await lookup(event.sessionID))].filter(Boolean).join("\n"),
      })
    }),
  ]
  return async () => {
    for (const registration of registrations) await registration.dispose()
  }
}

export * as Locale from "./locale"
