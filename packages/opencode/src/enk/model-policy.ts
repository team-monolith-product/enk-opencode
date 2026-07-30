import type { MessageV2 } from "@/session/message-v2"
import type { ModelID, ProviderID } from "@/provider/schema"

export namespace ModelPolicy {
  export function parseModel(raw?: string) {
    if (!raw) return undefined
    const slash = raw.indexOf("/")
    if (slash <= 0 || slash === raw.length - 1) return undefined
    const providerID = raw.slice(0, slash)
    const modelID = raw.slice(slash + 1)
    if (!providerID || !modelID) return undefined
    return { providerID, modelID }
  }

  export function validVariant(variants: Record<string, unknown> | undefined, variant?: string) {
    if (!variant || !variants) return undefined
    if (!(variant in variants)) return undefined
    return variant
  }

  // 세션 밖에서 도는 생성 작업(요약·기획서)이 쓸 모델을 고른다.
  // 호출자 지정 > 세션의 마지막 사용자 메시지 모델 > 기본 모델 순.
  export async function resolveModel(
    msgs: MessageV2.WithParts[],
    override?: { providerID?: ProviderID; modelID?: ModelID },
  ) {
    // AIDEV-NOTE: config -> model-policy -> provider 순환 import 를 피하려고 지연 로드한다.
    const { Provider } = await import("@/provider/provider")
    let providerID = override?.providerID
    let modelID = override?.modelID
    if (!providerID || !modelID) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const info = msgs[i].info
        if (info.role === "user") {
          providerID = info.model.providerID
          modelID = info.model.modelID
          break
        }
      }
    }
    if (!providerID || !modelID) {
      const def = await Provider.defaultModel()
      providerID = def.providerID
      modelID = def.modelID
    }
    return Provider.getLanguage(await Provider.getModel(providerID, modelID))
  }
}
