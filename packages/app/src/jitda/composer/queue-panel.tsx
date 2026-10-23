import { For, Show } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import type { SessionQueueView } from "@/session/composer/queue"
import { Icon } from "../env/ui/icon"
import "./queue-panel.css"

export function JitdaQueuePanel(props: {
  queue?: Pick<SessionQueueView, "rows" | "busy" | "working" | "steer" | "remove">
}) {
  const language = useLanguage()
  const rows = () => props.queue?.rows() ?? []

  return (
    <Show when={props.queue && rows().length > 0}>
      <div data-component="jitda-queue" class="pointer-events-auto">
        <div data-slot="jitda-queue-title">{language.plural("session.queue.count", rows().length)}</div>
        <For each={rows()}>
          {(row) => (
            <div data-slot="jitda-queue-row">
              <span data-slot="jitda-queue-text" dir="auto">
                {row.text || language.plural("session.queue.attachments", row.attachments)}
              </span>
              <button
                type="button"
                data-action="jitda-queue-steer"
                disabled={props.queue!.busy()}
                title={props.queue!.working() ? language.t("session.queue.steerTooltip") : undefined}
                onClick={() => void props.queue!.steer(row.id)}
              >
                <Icon name="arrow-up-bold" class="size-3.5" />
                {props.queue!.working() ? language.t("session.queue.steer") : language.t("session.queue.send")}
              </button>
              <button
                type="button"
                data-action="jitda-queue-remove"
                disabled={props.queue!.busy()}
                aria-label={language.t("session.queue.remove")}
                title={language.t("session.queue.remove")}
                onClick={() => void props.queue!.remove(row.id)}
              >
                <Icon name="close-small" class="size-3.5" />
              </button>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
