import z from "zod"

export namespace Locale {
  export const Schema = z.enum(["ko", "en"]).meta({ ref: "PromptLocale" })
  export type Value = z.infer<typeof Schema>
  export const DEFAULT: Value = "ko"

  const DIRECTIVE: Record<Value, string> = {
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

  export function directive(locale?: Value) {
    return DIRECTIVE[locale ?? DEFAULT]
  }
}
