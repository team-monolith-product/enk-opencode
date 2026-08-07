import { createSimpleContext } from "@opencode-ai/ui/context"
import { useStorageSignal } from "@/hooks/use-storage-signal"

const key = "devMode"
const STRING_TRUE = "true"
const submitFailureCloseFallback = 5

function submitFailureCloseSec() {
  const raw = import.meta.env.VITE_SUBMIT_FAILURE_CLOSE_SEC
  if (typeof raw !== "string") return submitFailureCloseFallback
  const value = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(value) || value < 1) return submitFailureCloseFallback
  return value
}

export function createClientEnv() {
  const productionLayout = import.meta.env.VITE_PRODUCTION_LAYOUT === STRING_TRUE
  const disablePromptFooter = import.meta.env.VITE_DISABLE_PROMPT_FOOTER === STRING_TRUE
  const disablePromptPermissions = import.meta.env.VITE_DISABLE_PROMPT_PERMISSIONS === STRING_TRUE
  const disablePromptTriggers = import.meta.env.VITE_DISABLE_PROMPT_TRIGGERS === STRING_TRUE
  const disableWysiwygOnly = import.meta.env.VITE_DISABLE_WYSIWYG_ONLY === STRING_TRUE
  const disableChangeFiles = import.meta.env.VITE_DISABLE_CHANGE_FILES === STRING_TRUE
  const disableChatIntro = import.meta.env.VITE_DISABLE_CHAT_INTRO === STRING_TRUE
  const disableAnswerClose = import.meta.env.VITE_DISABLE_ANSWER_CLOSE === STRING_TRUE
  // 서버는 오류를 그대로 내려주되, 스스로 회복되는 오류(파일 도구 실패, 재시도/폴백으로 넘어가는
  // 모델 오류)는 대화에 그리지 않는다. 폴백까지 모두 소진된 최종 실패는 이 플래그와 무관하게 보인다.
  const disableMinorErrors = import.meta.env.VITE_DISABLE_MINOR_ERRORS === STRING_TRUE
  const promptSubmitKey = import.meta.env.VITE_PROMPT_SUBMIT_KEY?.trim() || "enter"
  const promptNewlineKey = import.meta.env.VITE_PROMPT_NEWLINE_KEY?.trim() || "shift+enter"
  const [devMode] = useStorageSignal(key, false, {
    storage: "local", 
    parse: (value) => value === STRING_TRUE,
    stringify: (value) => (value ? STRING_TRUE : undefined),
  })

  return {
    devMode,
    productionLayout: () => productionLayout && !devMode(),
    disablePromptFooter: () => disablePromptFooter && !devMode(),
    disablePromptPermissions: () => disablePromptPermissions && !devMode(),
    disablePromptTriggers: () => disablePromptTriggers && !devMode(),
    disableWysiwygOnly: () => disableWysiwygOnly && !devMode(),
    disableChangeFiles: () => disableChangeFiles && !devMode(),
    disableChatIntro: () => disableChatIntro && !devMode(),
    disableAnswerClose: () => disableAnswerClose && !devMode(),
    disableMinorErrors: () => disableMinorErrors && !devMode(),
    promptSubmitKey: () => promptSubmitKey,
    promptNewlineKey: () => promptNewlineKey,
    submitFailureCloseSec,
  }
}

export const { use: useClientEnv, provider: ClientEnvProvider } = createSimpleContext({
  name: "ClientEnv",
  init: createClientEnv,
})
