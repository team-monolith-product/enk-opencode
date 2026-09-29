import { createMemo, createResource, Match, Show, Switch } from "solid-js"
import { useData } from "../context"
import { useDialog } from "../context/dialog"
import { useI18n } from "../context/i18n"
import { dataUrlFromMediaValue } from "../pierre/media"
import { BasicTool } from "./basic-tool"
import { Icon } from "./icon"
import { ImagePreview } from "./image-preview"
import { TextShimmer } from "./text-shimmer"
import type { ToolProps } from "./message-part"

function ratio(size: unknown) {
  const [w, h] = typeof size === "string" ? size.split("x").map(Number) : []
  return w && h ? `${w} / ${h}` : "1 / 1"
}

export function GeneratedImage(props: ToolProps) {
  const i18n = useI18n()
  const data = useData()
  const dialog = useDialog()

  const pending = createMemo(() => props.status === "pending" || props.status === "running")
  const path = createMemo(() => {
    const value = props.metadata.path ?? props.input.path
    return typeof value === "string" ? value : ""
  })
  const prompt = createMemo(() => (typeof props.input.prompt === "string" ? props.input.prompt : ""))
  const notice = createMemo(() => {
    const status = props.metadata.status
    if (status === "blocked") return i18n.t("ui.tool.generateImage.blocked")
    if (status === "disabled") return i18n.t("ui.tool.generateImage.disabled")
    if (status === "unavailable") return i18n.t("ui.tool.generateImage.unavailable")
    if (status === "limited")
      return i18n.t("ui.tool.generateImage.limited", { limit: props.metadata.quota?.limit ?? 0 })
  })
  const remaining = createMemo(() => {
    const quota = props.metadata.quota
    if (props.metadata.status !== "generated" || typeof quota?.remaining !== "number") return
    return i18n.t("ui.tool.generateImage.remaining", { remaining: quota.remaining, limit: quota.limit })
  })
  const ready = createMemo(() => props.status === "completed" && props.metadata.status === "generated")

  const [src] = createResource(
    () => (ready() && data.readFile && path() ? path() : false),
    async (file) => dataUrlFromMediaValue((await data.readFile!(file)) as never, "image"),
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
          subtitle: props.status === "pending" ? undefined : path(),
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
