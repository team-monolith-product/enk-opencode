import { type Accessor, createEffect, createSignal, on, onCleanup, Show } from "solid-js"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"
import type { ImageQuota, ImageQuotaStatus } from "@opencode-ai/sdk/v2/client"
import type { useSDK } from "@/context/sdk"

/**
 * 입력창의 '이미지 만들기' 상태. 토글은 팀 작업 공간에 값 하나라 서버에 두고, 누가 바꾸든 이벤트로 모든 화면이 따라간다.
 * createResource 는 루트 Suspense 를 걸어 조회 동안 화면 전체를 가리므로 신호로만 둔다.
 */
export function createImageGeneration(input: { sdk: ReturnType<typeof useSDK>; working: Accessor<boolean> }) {
  const [status, setStatus] = createSignal<ImageQuotaStatus>()

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
  onCleanup(
    input.sdk.event.on("image.generation.updated", (event) => {
      setStatus((current) => current && { ...current, on: event.properties.on })
    }),
  )

  const exhausted = () => (status()?.quota?.remaining ?? 1) <= 0
  const isOn = () => !exhausted() && (status()?.on ?? true)
  const toggle = () => {
    const next = !isOn()
    setStatus((current) => current && { ...current, on: next })
    void input.sdk.client.imageQuota
      .toggle({ directory: input.sdk.directory, on: next })
      .then((x) => setStatus(x.data))
      .catch(refresh)
  }

  return {
    /** 이번 메시지에 이미지 생성을 허용할지. 쓸 수 없는 곳이면 꺼서 보낸다. */
    request: () => status()?.enabled !== false && isOn(),
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
