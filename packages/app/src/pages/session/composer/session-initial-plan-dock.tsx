import { Button } from "@opencode-ai/ui/button"
import { DockTray } from "@opencode-ai/ui/dock-surface"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Match, Show, Switch } from "solid-js"
import { useLanguage } from "@/context/language"
import type { InitialPlanMode } from "./initial-plan-cta"

export function SessionInitialPlanDock(props: {
  mode: InitialPlanMode
  pending: boolean
  onStart: () => void
  onRetry: () => void
}) {
  const language = useLanguage()
  const copy = () => {
    if (props.mode === "running")
      return { title: "session.initialPlan.running.title", body: "session.initialPlan.running.description" } as const
    if (props.mode === "failed")
      return { title: "session.initialPlan.failed.title", body: "session.initialPlan.failed.description" } as const
    return { title: "session.initialPlan.title", body: "session.initialPlan.description" } as const
  }

  return (
    <DockTray
      data-component="session-initial-plan-dock"
      data-mode={props.mode}
      style={{
        "margin-bottom": "-0.875rem",
        "border-bottom-left-radius": 0,
        "border-bottom-right-radius": 0,
      }}
    >
      <div class="pl-3 pr-2 pt-2 pb-6 flex items-center gap-3 min-w-0">
        <Show when={props.mode === "running"}>
          <Spinner class="size-4 shrink-0 text-icon-base" />
        </Show>
        <div class="min-w-0 flex-1 flex flex-col gap-0.5">
          <span
            classList={{
              "text-13-medium": true,
              "text-text-strong": props.mode !== "failed",
              "text-icon-critical-base": props.mode === "failed",
            }}
          >
            {language.t(copy().title)}
          </span>
          <span class="text-12-regular text-text-weak">{language.t(copy().body)}</span>
        </div>
        <Switch>
          <Match when={props.mode === "ready"}>
            <Button size="small" variant="primary" class="shrink-0" disabled={props.pending} onClick={props.onStart}>
              {language.t("session.initialPlan.start")}
            </Button>
          </Match>
          <Match when={props.mode === "failed"}>
            <Button size="small" variant="secondary" class="shrink-0" disabled={props.pending} onClick={props.onRetry}>
              {language.t("session.initialPlan.retry")}
            </Button>
          </Match>
        </Switch>
      </div>
    </DockTray>
  )
}
