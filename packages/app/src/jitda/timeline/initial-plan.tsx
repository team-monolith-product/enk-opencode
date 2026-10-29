import { createSignal, Show } from "solid-js"
import type { SessionMessageUser } from "@opencode/client/promise"
import { Markdown } from "@opencode/session-ui/markdown"
import { useLanguage } from "@/runtime/i18n/language"

// 서버가 팀 대신 Plan 에 넘긴 최초 기획(metadata.enkInitialPlan)은 한 줄 제목만 보이고, 펼치면 전문을 보인다(V1 UserMessageDisplay).
export const INITIAL_PLAN_MARKER = "enkInitialPlan"

export function isInitialPlan(message: Pick<SessionMessageUser, "metadata">) {
  return message.metadata?.[INITIAL_PLAN_MARKER] === true
}

export function InitialPlanMessage(props: { id: string; text: string }) {
  const language = useLanguage()
  const [expanded, setExpanded] = createSignal(false)

  return (
    <>
      <div data-slot="user-message-initial-plan" class="flex items-center gap-2">
        <span class="text-14-medium text-text-strong">{language.t("jitda.initialPlan.title")}</span>
        <button
          type="button"
          data-slot="user-message-initial-plan-toggle"
          class="ml-auto text-12-regular text-text-weak hover:text-text-base"
          aria-expanded={expanded()}
          onClick={(event) => {
            event.stopPropagation()
            setExpanded((value) => !value)
          }}
        >
          {language.t(expanded() ? "jitda.initialPlan.collapse" : "jitda.initialPlan.expand")}
        </button>
      </div>
      <Show when={expanded()}>
        <div data-slot="user-message-initial-plan-body" class="mt-2">
          <Markdown text={props.text} cacheKey={`${props.id}:initial-plan`} />
        </div>
      </Show>
    </>
  )
}
