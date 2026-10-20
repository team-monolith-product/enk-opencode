// V1 짓다 ContextToolGroup(packages/ui/src/components/message-part.tsx). 진행 중에는 펼쳐 두고, 읽기 줄 범위를 보인다.
import { createMemo, createSignal, For, Index, Show } from "solid-js"
import type { SessionMessageAssistantTool } from "@opencode/client/promise"
import { hostToolInput } from "@opencode/session-ui/message"
import { AnimatedCountList } from "@opencode/session-ui/tool-count-summary"
import { ToolStatusTitle } from "@opencode/session-ui/tool-status-title"
import { Collapsible } from "@opencode/ui/collapsible"
import { useI18n, type UiI18n } from "@opencode/ui/context/i18n"
import { Spinner } from "@opencode/ui/spinner"
import { TextShimmer } from "@opencode/ui/text-shimmer"
import { getDirectory, getFilename } from "@opencode/util/path"

const pendingStatus = (tool: SessionMessageAssistantTool) =>
  tool.state.status === "streaming" || tool.state.status === "running"

export function readRange(input: Record<string, unknown>, i18n: Pick<UiI18n, "t">) {
  const offset = typeof input.offset === "number" ? input.offset : undefined
  const limit = typeof input.limit === "number" ? input.limit : undefined
  const start = offset !== undefined && offset > 0 ? offset : 1
  const end = limit !== undefined && limit > 0 ? start + limit - 1 : undefined
  if (end !== undefined) return i18n.t("ui.tool.lineRange", { start, end })
  if (offset !== undefined) return i18n.t("ui.tool.lineFrom", { start })
  return ""
}

function trigger(tool: SessionMessageAssistantTool, i18n: UiI18n) {
  const input = hostToolInput(tool, true)
  const path = typeof input.path === "string" ? input.path : "/"
  const file = typeof input.path === "string" ? input.path : undefined
  const pattern = typeof input.pattern === "string" ? input.pattern : undefined
  const include = typeof input.include === "string" ? input.include : undefined

  switch (tool.name) {
    case "read": {
      const range = readRange(input, i18n)
      return {
        title: i18n.t(tool.state.status === "streaming" ? "ui.tool.readActive" : "ui.tool.read"),
        subtitle: file ? getFilename(file) : "",
        args: file && range ? [range] : [],
      }
    }
    case "list":
      return { title: i18n.t("ui.tool.list"), subtitle: getDirectory(path), args: [] }
    case "glob":
      return {
        title: i18n.t("ui.tool.glob"),
        subtitle: getDirectory(path),
        args: pattern ? ["pattern=" + pattern] : [],
      }
    case "grep":
      return {
        title: i18n.t("ui.tool.grep"),
        subtitle: getDirectory(path),
        args: [...(pattern ? ["pattern=" + pattern] : []), ...(include ? ["include=" + include] : [])],
      }
    default:
      return { title: tool.name, subtitle: "", args: [] }
  }
}

export function JitdaContextToolGroup(props: {
  tools: SessionMessageAssistantTool[]
  busy: boolean
  onSizeChange?: () => void
}) {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  const pending = createMemo(() => props.busy || props.tools.some(pendingStatus))
  const effectiveOpen = createMemo(() => open() || pending())
  const summary = createMemo(() => ({
    read: props.tools.filter((tool) => tool.name === "read").length,
    search: props.tools.filter((tool) => tool.name === "glob" || tool.name === "grep").length,
    list: props.tools.filter((tool) => tool.name === "list").length,
  }))

  return (
    <div data-timeline-part-ids={props.tools.map((tool) => tool.id).join(",")}>
      <Collapsible
        open={effectiveOpen()}
        onOpenChange={(value) => {
          setOpen(value)
          props.onSizeChange?.()
        }}
        variant="ghost"
        class="tool-collapsible"
      >
        <Collapsible.Trigger>
          <div data-component="context-tool-group-trigger">
            <span
              data-slot="context-tool-group-title"
              class="min-w-0 flex items-center gap-2 text-14-medium text-text-strong"
            >
              <span data-slot="context-tool-group-label" class="shrink-0 inline-flex items-center gap-1.5">
                <Show when={pending()}>
                  <span data-slot="tool-status-spinner">
                    <Spinner style={{ color: "currentColor" }} />
                  </span>
                </Show>
                <ToolStatusTitle
                  active={pending()}
                  activeText={i18n.t("ui.sessionTurn.status.gatheringContext")}
                  doneText={i18n.t("ui.sessionTurn.status.gatheredContext")}
                  split={false}
                />
              </span>
              <span
                data-slot="context-tool-group-summary"
                class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-normal text-text-base"
              >
                <AnimatedCountList
                  items={[
                    { key: "ui.messagePart.context.read", count: summary().read },
                    { key: "ui.messagePart.context.search", count: summary().search },
                    { key: "ui.messagePart.context.list", count: summary().list },
                  ]}
                  fallback=""
                />
              </span>
            </span>
            <Collapsible.Arrow />
          </div>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div data-component="context-tool-group-list">
            <Index each={props.tools}>
              {(tool) => {
                const value = createMemo(() => trigger(tool(), i18n))
                const running = createMemo(() => pendingStatus(tool()))
                return (
                  <div data-slot="context-tool-group-item" data-timeline-part-id={tool().id}>
                    <div data-component="tool-trigger">
                      <div data-slot="basic-tool-tool-trigger-content">
                        <div data-slot="basic-tool-tool-info">
                          <div data-slot="basic-tool-tool-info-structured">
                            <div data-slot="basic-tool-tool-info-main">
                              <span data-slot="basic-tool-tool-title">
                                <TextShimmer text={value().title} active={running()} />
                              </span>
                              <Show when={value().subtitle}>
                                <span data-slot="basic-tool-tool-subtitle">{value().subtitle}</span>
                              </Show>
                              <Show when={value().args.length}>
                                <For each={value().args}>
                                  {(arg) => <span data-slot="basic-tool-tool-arg">{arg}</span>}
                                </For>
                              </Show>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              }}
            </Index>
          </div>
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}
