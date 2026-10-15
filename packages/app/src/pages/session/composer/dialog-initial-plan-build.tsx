import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Show } from "solid-js"
import { BuildPreview } from "@/components/doc-submit/dialog-doc-submit"
import { useLanguage } from "@/context/language"

export function DialogInitialPlanBuild(props: {
  text: string
  alone: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const language = useLanguage()
  return (
    <Dialog title={language.t("session.initialPlan.confirm.title")} fit>
      <div data-component="initial-plan-build-confirm" class="flex flex-col gap-3 px-5 pb-5">
        <span class="text-12-regular text-text-weak">{language.t("session.initialPlan.confirm.request")}</span>
        <BuildPreview text={props.text} />
        <Show when={!props.alone}>
          <p class="text-12-regular text-text-weak">{language.t("session.initialPlan.confirm.teamNotice")}</p>
        </Show>
        <div class="flex justify-end gap-2">
          <Button size="normal" variant="secondary" onClick={props.onClose}>
            {language.t("session.initialPlan.confirm.back")}
          </Button>
          <Button size="normal" variant="primary" onClick={props.onConfirm}>
            {language.t(props.alone ? "session.initialPlan.confirm.run" : "session.initialPlan.confirm.vote")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
