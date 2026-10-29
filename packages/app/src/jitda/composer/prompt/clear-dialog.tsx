import { onCleanup, onMount } from "solid-js"
import { useDialog } from "@opencode/ui/context/dialog"
import { useLanguage } from "@/runtime/i18n/language"
import { Button } from "../../env/ui/button"
import { Dialog } from "../../env/ui/dialog"
import { Icon } from "../../env/ui/icon"

// V1 components/session/dialog-clear-session.tsx "대화 초기화" 확인창. 속으로는 보관이지만 사용자에겐 그렇게 말하지 않는다.
export function DialogClearSession(props: { onClear: () => void | Promise<void> }) {
  const dialog = useDialog()
  const language = useLanguage()

  const handleClear = async () => {
    dialog.close()
    await props.onClear()
  }

  // Enter 로 확인 — 버튼의 키 힌트가 실제로 동작해야 한다(Esc 는 다이얼로그가 닫는다).
  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return
      if (event.isComposing) return
      event.preventDefault()
      void handleClear()
    }
    window.addEventListener("keydown", onKey, true)
    onCleanup(() => window.removeEventListener("keydown", onKey, true))
  })

  return (
    <Dialog
      title={language.t("session.clear.confirm")}
      description={language.t("session.clear.description")}
      action={<span class="sr-only" />}
      transition
      fit
      class="session-clear-dialog hazard-dialog"
    >
      <div class="session-clear-body">
        <p class="session-clear-warn">
          <Icon name="warning" class="size-3.5" />
          <span>{language.t("session.clear.note")}</span>
        </p>
      </div>
      <div class="hazard-dialog-footer">
        <Button
          type="button"
          size="normal"
          variant="secondary"
          class="session-clear-cancel"
          onClick={() => dialog.close()}
        >
          {language.t("common.cancel")}
          <span class="session-clear-kbd">Esc</span>
        </Button>
        <div class="flex-1" />
        <Button type="button" size="normal" variant="primary" class="session-clear-confirm" onClick={handleClear}>
          {language.t("session.clear.button")}
          <span class="session-clear-kbd session-clear-kbd--on-dark">Enter</span>
        </Button>
      </div>
    </Dialog>
  )
}
