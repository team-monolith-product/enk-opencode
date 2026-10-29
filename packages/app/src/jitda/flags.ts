// 짓다 운영 빌드에서 V1 과 같은 화면이 되도록 끄고 켜는 값. 이름과 의미는 V1 packages/app/.env.production 그대로다.
const env = import.meta.env as unknown as Record<string, string | undefined>

const on = (name: string) => env[name] === "true"

export const Flags = {
  productionLayout: on("VITE_PRODUCTION_LAYOUT"),
  disableSessionHeader: on("VITE_DISABLE_SESSION_HEADER"),
  disablePromptTriggers: on("VITE_DISABLE_PROMPT_TRIGGERS"),
  disablePromptPermissions: on("VITE_DISABLE_PROMPT_PERMISSIONS"),
  disableWysiwygOnly: on("VITE_DISABLE_WYSIWYG_ONLY"),
  disablePromptFooter: on("VITE_DISABLE_PROMPT_FOOTER"),
  disableChangeFiles: on("VITE_DISABLE_CHANGE_FILES"),
  disableChatIntro: on("VITE_DISABLE_CHAT_INTRO"),
  disableAnswerClose: on("VITE_DISABLE_ANSWER_CLOSE"),
  disableMinorErrors: on("VITE_DISABLE_MINOR_ERRORS"),
  submitFailureCloseSec: Number(env.VITE_SUBMIT_FAILURE_CLOSE_SEC ?? 0) || undefined,
  promptSubmitKey: env.VITE_PROMPT_SUBMIT_KEY ?? "enter",
  promptNewlineKey: env.VITE_PROMPT_NEWLINE_KEY ?? "shift+enter",
  modelPin: env.VITE_MODEL_PIN,
  modelPinVariant: env.VITE_MODEL_PIN_VARIANT,
  previewUrl: env.VITE_PREVIEW_URL,
}
