// 이미지 첨부 메시지 모델 라우터 플러그인 (opencode).
//
// 동작: 사용자 메시지에 이미지 파일 파트가 있는데 선택된 모델이 이미지 입력을
// 지원하지 않으면(deepseek 등), 그 메시지의 모델을 비전 지원 모델(기본
// minimax/MiniMax-M3)로 바꿔치기한다. 메시지 단위 전환이므로 이미지가 없는
// 다음 메시지는 UI 가 보내는 원래 모델로 돌아간다.
//
// 원리: chat.message 훅은 사용자 메시지가 저장되기 직전에 호출되고
// (output.message 가 저장될 객체 그 자체), 응답 루프는 저장된 마지막 사용자
// 메시지의 model 필드로 턴의 모델을 정한다(packages/opencode/src/session/prompt.ts
// 의 createUserMessage → loop 의 lastUser.model). 따라서 여기서 model 을 바꾸면
// 그 턴 전체가 대상 모델로 실행된다.
//
// 설정 — 우선순위: env > opencode.jsonc plugin 옵션 > 내장 기본값.
//   env:  ENK_AI_IMAGE_MODEL=minimax/MiniMax-M3, ENK_AI_IMAGE_MODEL_VARIANT=adaptive
//         (helm 이 주입. ENK_AI_MODEL × ENK_AI_IMAGE_MODEL 페어는 팰백 배타 그룹으로도
//          자동 유도된다 — packages/opencode/src/enk/model-fallback.ts)
//   옵션: ["./image-model-router-plugin.js", { "model": "minimax/MiniMax-M3", "variant": "adaptive" }]
//   - model: 이미지 메시지를 처리할 모델 (providerID/modelID)
//   - variant: 전환 시 사용할 variant. 대상 모델에 존재할 때만 적용.

const DEFAULT_MODEL = "minimax/MiniMax-M3"
const MODEL_ENV = "ENK_AI_IMAGE_MODEL"
const VARIANT_ENV = "ENK_AI_IMAGE_MODEL_VARIANT"

const log = (...args) => console.error("[image-model-router]", ...args)

export function parseModelRef(ref) {
  if (typeof ref !== "string") return undefined
  const index = ref.indexOf("/")
  if (index <= 0 || index === ref.length - 1) return undefined
  return { providerID: ref.slice(0, index), modelID: ref.slice(index + 1) }
}

export function supportsImageInput(model) {
  // /provider 응답(Provider.Model)은 capabilities 아래에, 레거시
  // /config/providers 응답(ModelsDev.Model)은 최상위에 attachment 가 있다. 둘 다 수용.
  const caps = model.capabilities
  if (caps) return caps.attachment === true || caps.input?.image === true
  return model.attachment === true
}

/** env > 옵션 > 기본값 순으로 첫 번째 유효한 모델 지정을 고른다. 잘못된 값은 경고 후 다음 후보로. */
export function resolveTarget(options = {}, env = process.env) {
  const candidates = [
    [env[MODEL_ENV], `env ${MODEL_ENV}`],
    [options.model, "plugin option"],
    [DEFAULT_MODEL, "default"],
  ]
  for (const [raw, source] of candidates) {
    if (raw === undefined || raw === "") continue
    const parsed = parseModelRef(raw)
    if (parsed) {
      log(`대상 모델 확정(${source}):`, `${parsed.providerID}/${parsed.modelID}`)
      return parsed
    }
    log(`잘못된 모델 지정(${source})을 무시합니다:`, raw)
  }
  return undefined
}

async function server({ client }, options = {}) {
  const target = resolveTarget(options)
  if (!target) {
    log("유효한 대상 모델이 없습니다. 플러그인을 비활성화합니다.")
    return {}
  }
  const envVariant = process.env[VARIANT_ENV]
  const targetVariant = envVariant || (typeof options.variant === "string" ? options.variant : undefined)

  // provider 목록은 런타임에 거의 바뀌지 않으므로 첫 조회 결과를 재사용한다(실패 시에만 재시도).
  let providersPromise
  const providers = () => {
    providersPromise ??= client.provider
      .list()
      .then((result) => {
        const data = result?.data ?? result
        const all = Array.isArray(data?.all) ? data.all : []
        return new Map(all.map((provider) => [provider.id, provider]))
      })
      .catch((error) => {
        providersPromise = undefined
        throw error
      })
    return providersPromise
  }
  const findModel = async (ref) => (await providers()).get(ref.providerID)?.models?.[ref.modelID]

  return {
    "chat.message": async (_input, output) => {
      const message = output.message
      const model = message?.model
      if (!model) return
      if (model.providerID === target.providerID && model.modelID === target.modelID) return

      const hasImage = (output.parts ?? []).some(
        (part) => part.type === "file" && typeof part.mime === "string" && part.mime.startsWith("image/"),
      )
      if (!hasImage) return

      try {
        const current = await findModel(model)
        // 모델 정보를 못 찾으면 판단 근거가 없으므로 건드리지 않는다.
        if (!current) {
          log("현재 모델 정보를 provider 목록에서 찾지 못해 전환하지 않습니다:", `${model.providerID}/${model.modelID}`)
          return
        }
        if (supportsImageInput(current)) {
          log("현재 모델이 이미지 입력을 지원하므로 전환하지 않습니다:", `${model.providerID}/${model.modelID}`)
          return
        }

        const targetModel = await findModel(target)
        if (!targetModel) {
          log("대상 모델이 이 배포에 없어 전환하지 않습니다:", `${target.providerID}/${target.modelID}`)
          return
        }

        message.model = { providerID: target.providerID, modelID: target.modelID }
        // variant 는 원래 모델 기준으로 검증된 값이므로 대상 모델에 없으면 버린다
        // (llm.ts 가 model.variants[variant] 를 그대로 병합하기 때문).
        const variants = targetModel.variants ?? {}
        const preferred = targetVariant && variants[targetVariant] ? targetVariant : message.variant
        message.variant = preferred && variants[preferred] ? preferred : undefined
        log(
          "이미지 첨부 감지, 모델 전환:",
          `${model.providerID}/${model.modelID}`,
          "→",
          `${message.model.providerID}/${message.model.modelID}`,
          message.variant ? `(variant: ${message.variant})` : "",
        )
      } catch (error) {
        log("모델 전환 중 오류(원래 모델 유지):", error?.message ?? error)
      }
    },
  }
}

// v1 플러그인 형식({ id, server }). 레거시 형식(default 함수)은 로더가 모든 named
// export 를 플러그인으로 취급하므로(getLegacyPlugins), 위 헬퍼 export 와 함께 쓰려면
// 반드시 이 형식이어야 한다.
export default { id: "image-model-router", server }
