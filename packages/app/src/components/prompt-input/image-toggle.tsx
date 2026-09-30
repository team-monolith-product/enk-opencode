import { Show } from "solid-js"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"

export type ImageQuota = { limit: number; used: number; remaining: number }

export function ImageToggle(props: { enabled: boolean; quota?: ImageQuota; disabled?: boolean; onToggle: () => void }) {
  const language = useLanguage()
  const hint = () => {
    const quota = props.quota
    if (!quota) return language.t("prompt.imageToggle.hint")
    if (quota.remaining <= 0) return language.t("prompt.imageToggle.exhausted", { limit: quota.limit })
    return language.t("prompt.imageToggle.hintLimit", { limit: quota.limit, remaining: quota.remaining })
  }

  return (
    <Tooltip placement="top" value={hint()}>
      <button
        type="button"
        data-action="prompt-image-toggle"
        role="switch"
        aria-checked={props.enabled}
        aria-label={language.t("prompt.imageToggle.label")}
        class="oc-auto-toggle"
        disabled={props.disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => props.onToggle()}
      >
        <span class="oc-auto-track" classList={{ "is-on": props.enabled }}>
          <span class="oc-auto-thumb" />
        </span>
        <span class="oc-auto-label">{language.t("prompt.imageToggle.label")}</span>
        <Show when={props.quota}>
          {(quota) => (
            <span class="oc-image-count" classList={{ "is-empty": quota().remaining <= 0 }}>
              {quota().used}/{quota().limit}
            </span>
          )}
        </Show>
      </button>
    </Tooltip>
  )
}
