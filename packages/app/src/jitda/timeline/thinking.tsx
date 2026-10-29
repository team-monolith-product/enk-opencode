// V1 짓다 session-turn 의 "생각 중" 줄. 추론 요약을 숨긴 채 응답이 끝날 때까지 턴 맨 아래에 둔다.
import { useI18n } from "@opencode/ui/context/i18n"
import { Spinner } from "@opencode/ui/spinner"
import { TextReveal } from "@opencode/ui/text-reveal"
import { TextShimmer } from "@opencode/ui/text-shimmer"

export function JitdaThinking(props: { heading?: string }) {
  const i18n = useI18n()

  return (
    <div data-component="session-turn" class="min-w-0 w-full relative">
      <div data-slot="session-turn-thinking">
        <Spinner class="shrink-0" style={{ color: "currentColor" }} />
        <TextShimmer text={i18n.t("ui.sessionTurn.status.thinking")} />
        <TextReveal text={props.heading} class="session-turn-thinking-heading" travel={25} duration={700} />
      </div>
    </div>
  )
}
