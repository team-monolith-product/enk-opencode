import { Locale } from "./locale"

export namespace ProjectSummaryLanguage {
  export function resolve(input: {
    requested?: Locale.Value
    messages: ReadonlyArray<{ info: { role: string; locale?: Locale.Value } }>
  }): Locale.Value {
    if (input.requested) return input.requested
    for (let i = input.messages.length - 1; i >= 0; i--) {
      const info = input.messages[i].info
      if (info.role === "user" && info.locale) return info.locale
    }
    return Locale.DEFAULT
  }

  const DIRECTIVE: Record<Locale.Value, string> = {
    en: "Write title, description and usage in English, whatever language the work log or files are in. Keep proper nouns such as the app name as they are.",
    ko: "title·description·usage 는 작업 기록이나 파일의 언어와 관계없이 한국어로 씁니다. 앱 이름 같은 고유명사는 그대로 둡니다.",
  }

  export function directive(locale: Locale.Value) {
    return DIRECTIVE[locale]
  }
}
