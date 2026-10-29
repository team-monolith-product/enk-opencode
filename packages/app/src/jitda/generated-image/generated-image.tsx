import { createEffect, createMemo, createSignal, Match, on, onCleanup, Show, Switch, type Component } from "solid-js"
import { BasicTool } from "@opencode/session-ui/basic-tool"
import { useMarkdown } from "@opencode/session-ui/context/markdown"
import { useDialog } from "@opencode/ui/context/dialog"
import { ImagePreview } from "@opencode/ui/image-preview"
import { TextShimmer } from "@opencode/ui/text-shimmer"
import { useLanguage } from "@/runtime/i18n/language"
import { Icon } from "../pdf/ui/icon"
import "./generated-image.css"

// session-ui ToolProps 중 이 카드가 읽는 필드. 등록 시 session-ui ToolProps 가 그대로 들어온다.
export type GeneratedImageProps = {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  tool: string
  status?: string
  output?: string
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

type Quota = { limit?: number; used?: number; remaining?: number }

function ratio(size: unknown) {
  const [w, h] = typeof size === "string" ? size.split("x").map(Number) : []
  return w && h ? `${w} / ${h}` : "1 / 1"
}

export const GeneratedImage: Component<GeneratedImageProps> = (props) => {
  const i18n = useLanguage()
  const markdown = useMarkdown()
  const dialog = useDialog()

  const pending = createMemo(() => props.status === "streaming" || props.status === "running")
  const quota = createMemo(() => {
    const value = props.metadata.quota
    return value && typeof value === "object" ? (value as Quota) : undefined
  })
  const path = createMemo(() => {
    const value = props.metadata.path ?? props.input.path
    return typeof value === "string" ? value : ""
  })
  const prompt = createMemo(() => {
    const value = props.metadata.prompt ?? props.input.prompt
    return typeof value === "string" ? value : ""
  })
  const notice = createMemo(() => {
    const status = props.metadata.status
    if (status === "off") return i18n.t("ui.tool.generateImage.off")
    if (status === "subagent") return i18n.t("ui.tool.generateImage.subagent")
    if (status === "blocked") return i18n.t("ui.tool.generateImage.blocked")
    if (status === "timeout") return i18n.t("ui.tool.generateImage.timeout")
    if (status === "disabled") return i18n.t("ui.tool.generateImage.disabled")
    if (status === "unavailable") return i18n.t("ui.tool.generateImage.unavailable")
    if (status === "limited") return i18n.t("ui.tool.generateImage.limited", { limit: quota()?.limit ?? 0 })
  })
  const remaining = createMemo(() => {
    const value = quota()
    if (props.metadata.status !== "generated" || typeof value?.remaining !== "number") return
    return i18n.t("ui.tool.generateImage.remaining", { remaining: value.remaining, limit: value.limit ?? 0 })
  })
  const ready = createMemo(() => props.status === "completed" && props.metadata.status === "generated")

  const [src, setSrc] = createSignal<string>()
  createEffect(
    on(
      () => (ready() && markdown?.readImage && path() ? path() : undefined),
      (file) => {
        setSrc(undefined)
        if (!file) return
        const controller = new AbortController()
        let url: string | undefined
        onCleanup(() => {
          controller.abort()
          if (url) URL.revokeObjectURL(url)
        })
        void markdown!.readImage!(file, controller.signal)
          .then((blob) => {
            if (!blob || controller.signal.aborted) return
            url = URL.createObjectURL(blob)
            setSrc(url)
          })
          .catch(() => undefined)
      },
    ),
  )

  const open = () => {
    const url = src()
    if (url) dialog.show(() => <ImagePreview src={url} alt={prompt()} />)
  }

  return (
    <div data-component="generated-image-tool">
      <BasicTool
        {...props}
        hideDetails
        icon="photo"
        trigger={{
          title: i18n.t("ui.tool.generateImage"),
          subtitle: props.status === "streaming" ? undefined : path(),
        }}
      />
      <Switch>
        <Match when={pending()}>
          <div
            data-slot="generated-image-frame"
            data-state="generating"
            style={{ "aspect-ratio": ratio(props.input.size) }}
          >
            <div data-slot="generated-image-placeholder">
              <Icon name="photo" />
              <TextShimmer text={i18n.t("ui.tool.generateImage.generating")} active />
            </div>
          </div>
        </Match>
        <Match when={notice()}>{(text) => <div data-slot="generated-image-note">{text()}</div>}</Match>
        <Match when={src()}>
          {(url) => (
            <figure data-slot="generated-image-figure">
              <button
                type="button"
                data-slot="generated-image-frame"
                data-state="ready"
                data-transparent={props.input.background === "transparent" ? "" : undefined}
                style={{ "aspect-ratio": ratio(props.input.size) }}
                aria-label={i18n.t("ui.tool.generateImage.open")}
                onClick={open}
              >
                <img data-slot="generated-image-image" src={url()} alt={prompt()} />
              </button>
              <Show when={prompt()}>
                <figcaption data-slot="generated-image-caption" title={prompt()}>
                  {prompt()}
                </figcaption>
              </Show>
              <Show when={remaining()}>
                <span data-slot="generated-image-remaining">{remaining()}</span>
              </Show>
            </figure>
          )}
        </Match>
      </Switch>
    </div>
  )
}
