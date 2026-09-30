import { type Accessor, createEffect, createSignal, on, Show } from "solid-js"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"
import type { useSDK } from "@/context/sdk"

export type ImageQuota = { limit: number; used: number; remaining: number }

// 사용자가 한 번 고르면 그 값을 계속 따르고, 고른 적이 없으면 남은 개수가 있을 때 켜 둔다.
const CHOICE_KEY = "prompt.imageGeneration"

function loadChoice() {
  try {
    const value = localStorage.getItem(CHOICE_KEY)
    return value === null ? undefined : value === "1"
  } catch {
    return undefined
  }
}

/**
 * 입력창의 '이미지 만들기' 상태. 서버의 개수 캐시를 읽어 토글을 그리고, 전송할 값(request)을 준다.
 * createResource 는 루트 Suspense 를 걸어 조회 동안 화면 전체를 가리므로 신호로만 둔다.
 */
export function createImageGeneration(input: { sdk: ReturnType<typeof useSDK>; working: Accessor<boolean> }) {
  const [status, setStatus] = createSignal<{ enabled: boolean; quota?: ImageQuota }>()
  const [choice, setChoice] = createSignal(loadChoice())

  const refresh = () => {
    const directory = input.sdk.directory
    void input.sdk.client.imageQuota
      .get({ directory })
      .then((x) => {
        if (input.sdk.directory === directory) setStatus(x.data)
      })
      .catch(() => undefined)
  }
  createEffect(on(() => input.sdk.directory, refresh))
  createEffect(on(input.working, (busy, was) => was && !busy && refresh(), { defer: true }))

  const exhausted = () => (status()?.quota?.remaining ?? 1) <= 0
  const isOn = () => !exhausted() && (choice() ?? true)
  const toggle = () => {
    const next = !isOn()
    setChoice(next)
    try {
      localStorage.setItem(CHOICE_KEY, next ? "1" : "0")
    } catch {}
  }

  return {
    /** 이번 메시지에 이미지 생성을 허용할지. 기능이 없는 곳이면 보내지 않는다. */
    request: () => (status()?.enabled === false ? undefined : isOn()),
    Toggle: () => (
      <Show when={status()?.enabled}>
        <ImageToggle enabled={isOn()} quota={status()?.quota} disabled={exhausted()} onToggle={toggle} />
      </Show>
    ),
  }
}

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
      </button>
    </Tooltip>
  )
}
