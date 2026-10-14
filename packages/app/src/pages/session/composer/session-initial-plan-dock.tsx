import { Button } from "@opencode-ai/ui/button"
import { DockTray } from "@opencode-ai/ui/dock-surface"
import { useLanguage } from "@/context/language"

export function SessionInitialPlanDock(props: { starting: boolean; onStart: () => void }) {
  const language = useLanguage()

  return (
    <DockTray
      data-component="session-initial-plan-dock"
      style={{
        "margin-bottom": "-0.875rem",
        "border-bottom-left-radius": 0,
        "border-bottom-right-radius": 0,
      }}
    >
      <div class="pl-3 pr-2 pt-2 pb-6 flex items-center gap-3 min-w-0">
        <div class="min-w-0 flex-1 flex flex-col gap-0.5">
          <span class="text-13-medium text-text-strong">{language.t("session.initialPlan.title")}</span>
          <span class="text-12-regular text-text-weak">{language.t("session.initialPlan.description")}</span>
        </div>
        <Button size="small" variant="primary" class="shrink-0" disabled={props.starting} onClick={props.onStart}>
          {language.t("session.initialPlan.start")}
        </Button>
      </div>
    </DockTray>
  )
}
