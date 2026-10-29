import type { SessionMessageAssistant, SessionMessageAssistantTool, SessionMessageUser } from "@opencode/client/promise"
import { Match, Show, Switch, createMemo, type ComponentProps } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { SessionUserActions, SessionUserAttachmentReference, SessionUserComment } from "../actions"
import { AssistantReasoningContent, AssistantTextContent, CurrentUserMessageDisplay } from "./message-content"
import {
  CurrentContextToolGroup,
  CurrentFileToolGroup,
  CurrentReadToolGroup,
  ToolDisplay,
} from "../tools/tool-renderer"
import { currentToolError, currentToolInput, currentToolMetadata, currentToolOutput } from "./current-tool-state"
import { useMessageHost } from "./host"
import { parsePartialToolInput } from "./tool-input"

export type { SessionUserActions, SessionUserAttachmentReference, SessionUserComment } from "../actions"

export { SessionShellMessage } from "../tools/tool-renderer"

export { currentContentDefaultOpen } from "./current-tool-state"

export { MessageHostProvider, useMessageHost, type MessageHost, type HostToolProps, type MessageDocView } from "./host"

export { minorToolError } from "./minor-error"

export { writeClipboard } from "./message-content"

export { countPartialStringLines, editPendingDiff, parsePartialToolInput } from "./tool-input"

export function hostToolInput(tool: SessionMessageAssistantTool, partial?: boolean): Record<string, unknown> {
  const input = currentToolInput(tool)

  if (!partial || tool.state.status !== "streaming" || Object.keys(input).length > 0) return input

  return parsePartialToolInput(tool.state.input) ?? input
}

export function SessionUserMessage(props: {
  sessionID: string
  message: SessionMessageUser
  displayText?: string
  comments?: SessionUserComment[]
  references?: SessionUserAttachmentReference[]
  voice?: boolean
  historicalAgent: string
  historicalModel: SessionMessageAssistant["model"]
  actions?: SessionUserActions
}) {
  return (
    <CurrentUserMessageDisplay
      sessionID={props.sessionID}
      message={props.message}
      text={props.displayText ?? props.message.text}
      comments={props.comments}
      references={props.references}
      voice={props.voice}
      agent={props.historicalAgent}
      model={props.historicalModel}
      actions={props.actions}
    />
  )
}

export function SessionAssistantContent(props: {
  message: SessionMessageAssistant
  content: SessionMessageAssistant["content"][number]
  contentID: string
  showAssistantCopyPartID?: string | null
  turnDurationMs?: number | null
  defaultOpen?: boolean
  reasoningDefaultOpen?: boolean
  toolOpen?: boolean
  onToolOpenChange?: (open: boolean) => void
  onContentRendered?: () => void
}) {
  return (
    <Switch>
      <Match when={props.content.type === "text" ? props.content : undefined}>
        {(content) => (
          <AssistantTextContent
            id={props.contentID}
            text={content().text}
            message={props.message}
            showCopy={props.showAssistantCopyPartID === props.contentID}
            turnDurationMs={props.turnDurationMs}
          />
        )}
      </Match>
      <Match when={props.content.type === "reasoning" ? props.content : undefined}>
        {(content) => (
          <AssistantReasoningContent
            id={props.contentID}
            content={content()}
            streaming={false}
            defaultOpen={props.reasoningDefaultOpen}
            open={props.toolOpen}
            onOpenChange={props.onToolOpenChange}
            onContentRendered={props.onContentRendered}
          />
        )}
      </Match>
      <Match when={props.content.type === "tool" ? props.content : undefined}>
        {(tool) => (
          <HostToolDisplay
            id={props.contentID}
            tool={tool()}
            defaultOpen={props.defaultOpen}
            open={props.toolOpen}
            onOpenChange={props.onToolOpenChange}
            onContentRendered={props.onContentRendered}
          />
        )}
      </Match>
    </Switch>
  )
}

function HostToolDisplay(props: {
  id: string
  tool: SessionMessageAssistantTool
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onContentRendered?: () => void
}) {
  const host = useMessageHost()
  const error = createMemo(() => currentToolError(props.tool))
  const input = createMemo(() => hostToolInput(props.tool, host.partialInput))
  const raw = () => (props.tool.state.status === "streaming" ? props.tool.state.input : undefined)
  const override = createMemo(() => host.tool?.(props.tool.name))
  const failed = createMemo(() => (props.tool.name === "question" ? undefined : host.toolError))

  return (
    <Show
      when={error() !== undefined && failed()}
      fallback={
        <Show
          when={error() === undefined && override()}
          fallback={
            <ToolDisplay
              id={props.id}
              tool={props.tool.name}
              input={input()}
              metadata={currentToolMetadata(props.tool)}
              output={currentToolOutput(props.tool)}
              status={props.tool.state.status}
              error={error()}
              defaultOpen={props.defaultOpen}
              open={props.open}
              onOpenChange={props.onOpenChange}
              deferContent
              virtualizeDiff={false}
              onContentRendered={props.onContentRendered}
            />
          }
        >
          {(component) => (
            <div data-component="tool-part-wrapper" data-timeline-part-id={props.id}>
              <Dynamic
                component={component()}
                tool={props.tool.name}
                input={input()}
                metadata={currentToolMetadata(props.tool)}
                output={currentToolOutput(props.tool)}
                status={props.tool.state.status}
                raw={raw()}
                defaultOpen={props.defaultOpen}
                open={props.open}
                onOpenChange={props.onOpenChange}
                onContentRendered={props.onContentRendered}
              />
            </div>
          )}
        </Show>
      }
    >
      {(component) => (
        <div data-component="tool-part-wrapper" data-timeline-part-id={props.id}>
          <Dynamic component={component()} tool={props.tool.name} error={error()!} input={input()} />
        </div>
      )}
    </Show>
  )
}

export function SessionContextToolGroup(props: ComponentProps<typeof CurrentContextToolGroup>) {
  return <CurrentContextToolGroup {...props} />
}

export function SessionReadToolGroup(props: ComponentProps<typeof CurrentReadToolGroup>) {
  return <CurrentReadToolGroup {...props} />
}

export function SessionFileToolGroup(props: {
  tools: SessionMessageAssistantTool[]
  fileOpen: (path: string) => boolean | undefined
  onFileOpenChange: (path: string, open: boolean) => void
  onSizeChange?: () => void
}) {
  return (
    <CurrentFileToolGroup
      tools={props.tools}
      fileOpen={props.fileOpen}
      onFileOpenChange={props.onFileOpenChange}
      onSizeChange={props.onSizeChange}
    />
  )
}
