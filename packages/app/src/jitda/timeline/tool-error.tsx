// V1 짓다 ToolErrorCard(packages/ui/src/components/tool-error-card.tsx): 접히지 않는 흐린 한 줄.
import { createMemo } from "solid-js"
import { Card } from "@opencode/ui/card"
import { useI18n } from "@opencode/ui/context/i18n"
import { Icon } from "@opencode/ui/icon"

const names: Record<string, string> = {
  read: "ui.tool.read",
  list: "ui.tool.list",
  glob: "ui.tool.glob",
  grep: "ui.tool.grep",
  subagent: "ui.tool.task",
  webfetch: "ui.tool.webfetch",
  websearch: "ui.tool.websearch",
  shell: "ui.tool.shell",
  patch: "ui.tool.patch",
  question: "ui.tool.questions",
}

export function JitdaToolError(props: { tool: string; error: string }) {
  const i18n = useI18n()
  const name = createMemo(() => {
    const key = names[props.tool]
    return key ? i18n.t(key as Parameters<typeof i18n.t>[0]) : props.tool
  })
  const subtitle = createMemo(() => {
    const cleaned = props.error.replace(/^Error:\s*/, "").trim()
    const prefix = `${props.tool} `
    const tail = cleaned.startsWith(prefix) ? cleaned.slice(prefix.length) : cleaned
    const parts = tail.split(": ")
    const head = (parts[0] ?? "").trim()
    if (parts.length <= 1 || !head) return i18n.t("ui.toolErrorCard.failed")
    return head[0]!.toUpperCase() + head.slice(1)
  })

  return (
    <div data-kind="tool-error-card">
      <div data-component="tool-trigger">
        <div data-slot="basic-tool-tool-trigger-content">
          <span data-slot="basic-tool-tool-indicator" data-component="tool-error-card-icon">
            <Icon name="circle-x" size="small" />
          </span>
          <div data-slot="basic-tool-tool-info">
            <div data-slot="basic-tool-tool-info-structured">
              <div data-slot="basic-tool-tool-info-main">
                <span data-slot="basic-tool-tool-title">{name()}</span>
                <span data-slot="basic-tool-tool-subtitle">{subtitle()}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// V1 session-turn 의 턴 오류 카드는 아이콘·굵은 제목 없이 본문만 보인다.
export function JitdaSessionError(props: { message: string }) {
  return (
    <Card variant="error" class="error-card">
      {props.message}
    </Card>
  )
}
