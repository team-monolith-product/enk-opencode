import { createMemo, createSignal, Show } from "solid-js"
import type { ImageRequest } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { DockPrompt } from "@opencode-ai/ui/dock-prompt"
import { Icon } from "@opencode-ai/ui/icon"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { useParentParams } from "@/context/parent-params"
import { useSDK } from "@/context/sdk"

export function SessionImageRequestDock(props: { request: ImageRequest; onSubmit?: () => void }) {
  const language = useLanguage()
  const sdk = useSDK()
  const readonly = useParentParams().readonly

  const [prompt, setPrompt] = createSignal(props.request.prompt)
  const [busy, setBusy] = createSignal(false)

  const shape = createMemo(() => {
    const [w, h] = props.request.size.split("x").map(Number)
    if (!w || !h || w === h) return language.t("imageRequest.shape.square")
    return w > h ? language.t("imageRequest.shape.landscape") : language.t("imageRequest.shape.portrait")
  })

  const run = async (action: () => Promise<unknown>) => {
    if (busy() || readonly) return
    setBusy(true)
    try {
      await action()
      props.onSubmit?.()
    } catch (err) {
      const description = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("common.requestFailed"), description })
      setBusy(false)
    }
  }

  const approve = () =>
    run(() =>
      sdk.client.imageRequest.approve({
        requestID: props.request.id,
        directory: sdk.directory,
        prompt: prompt().trim() || props.request.prompt,
      }),
    )
  const skip = () => run(() => sdk.client.imageRequest.skip({ requestID: props.request.id, directory: sdk.directory }))

  return (
    <DockPrompt
      kind="image"
      header={
        <>
          <span class="inline-flex shrink-0 items-center justify-center text-icon-base">
            <Icon name="photo" size="small" />
          </span>
          <span data-slot="image-title" class="shrink-0">
            {language.t("imageRequest.title")}
          </span>
          <Show when={props.request.quota}>
            {(quota) => (
              <span data-slot="image-subtitle" class="text-text-weaker truncate min-w-0">
                · {language.t("imageRequest.remaining", { remaining: quota().remaining, limit: quota().limit })}
              </span>
            )}
          </Show>
        </>
      }
      footer={
        <>
          <span data-slot="image-note" class="text-text-weak truncate min-w-0">
            {language.t("imageRequest.notice")}
          </span>
          <div class="flex-1" />
          <div class="flex items-center gap-2 shrink-0">
            <Button variant="secondary" size="small" onClick={() => void skip()} disabled={busy() || readonly}>
              {language.t("imageRequest.skip")}
            </Button>
            <Button
              variant="primary"
              size="small"
              onClick={() => void approve()}
              disabled={busy() || readonly || !prompt().trim()}
            >
              {language.t("imageRequest.approve")}
            </Button>
          </div>
        </>
      }
    >
      <TextField
        multiline
        autofocus
        label={language.t("imageRequest.field.prompt")}
        hideLabel
        value={prompt()}
        disabled={readonly}
        onChange={setPrompt}
      />
      <span data-slot="image-note" class="text-text-weaker truncate">
        {shape()} · {props.request.path}
      </span>
    </DockPrompt>
  )
}
