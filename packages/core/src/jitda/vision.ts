// 이미지·PDF 가 첨부된 메시지인데 기본 모델이 이미지를 못 읽으면 그 턴만 비전 모델로 돌린다. 세션 모델은 바꾸지 않으므로
// 미디어가 없는 다음 메시지는 원래 모델로 돌아간다. 대상은 ENK_AI_IMAGE_MODEL(+_VARIANT), 없으면 MiniMax-M3(adaptive).

const DEFAULT_MODEL = "minimax/MiniMax-M3"
const DEFAULT_VARIANT = "adaptive"

export function isMedia(mime: string) {
  const value = mime.toLowerCase()
  return value.startsWith("image/") || value === "application/pdf"
}

export function target(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.ENK_AI_IMAGE_MODEL || DEFAULT_MODEL
  const slash = raw.indexOf("/")
  if (slash <= 0 || slash === raw.length - 1) return undefined
  return {
    providerID: raw.slice(0, slash),
    modelID: raw.slice(slash + 1),
    variant: env.ENK_AI_IMAGE_MODEL_VARIANT || (env.ENK_AI_IMAGE_MODEL ? undefined : DEFAULT_VARIANT),
  }
}

export function wanted(
  message: { readonly files?: ReadonlyArray<{ readonly mime: string }> } | undefined,
  input: ReadonlyArray<string>,
) {
  if (input.includes("image")) return false
  return (message?.files ?? []).some((file) => isMedia(file.mime))
}

export * as Vision from "./vision.js"
