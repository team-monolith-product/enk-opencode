// V1 짓다 도구 카드(packages/ui/src/components/message-part.tsx 의 bash·edit·write). 데이터는 V2 도구 상태를 읽는다.
import { createMemo, createSignal, For, onMount, Show, type Component, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { BasicTool } from "@opencode/session-ui/basic-tool"
import {
  countPartialStringLines,
  editPendingDiff,
  writeClipboard,
  type HostToolProps,
} from "@opencode/session-ui/message"
import { resolveFileDiff } from "@opencode/session-ui/session-diff"
import { Accordion } from "@opencode/ui/accordion"
import { useFileComponent } from "@opencode/ui/context/file"
import { useI18n } from "@opencode/ui/context/i18n"
import { DiffChanges } from "@opencode/ui/diff-changes"
import { FileIcon } from "@opencode/ui/file-icon"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Spinner } from "@opencode/ui/spinner"
import { StickyAccordionHeader } from "@opencode/ui/sticky-accordion-header"
import { TextShimmer } from "@opencode/ui/text-shimmer"
import { Tooltip } from "@opencode/ui/tooltip"
import { checksum } from "@opencode/util/encode"
import { getDirectory, getFilename } from "@opencode/util/path"

type Diagnostic = { range: { start: { line: number; character: number } }; message: string; severity?: number }

type FileDiff = { file: string; patch?: string; additions: number; deletions: number }

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

const text = (value: unknown) => (typeof value === "string" ? value : undefined)

const pendingStatus = (status?: string) => status === "streaming" || status === "running"

function fileDiff(metadata: Record<string, unknown>): FileDiff | undefined {
  const files = metadata.files
  if (!Array.isArray(files)) return
  const file = files.find((item) => !!item && typeof item === "object" && typeof item.file === "string")
  if (!file) return
  return {
    file: file.file,
    patch: typeof file.patch === "string" ? file.patch : undefined,
    additions: typeof file.additions === "number" ? file.additions : 0,
    deletions: typeof file.deletions === "number" ? file.deletions : 0,
  }
}

function diagnostics(metadata: Record<string, unknown>, path: string | undefined): Diagnostic[] {
  const all = metadata.diagnostics
  if (!path || !all || typeof all !== "object") return []
  const list = (all as Record<string, unknown>)[path]
  if (!Array.isArray(list)) return []
  return list
    .filter(
      (item): item is Diagnostic =>
        !!item && typeof item === "object" && typeof item.message === "string" && item.severity === 1,
    )
    .slice(0, 3)
}

function DiagnosticsDisplay(props: { diagnostics: Diagnostic[] }): JSX.Element {
  const i18n = useI18n()
  return (
    <Show when={props.diagnostics.length > 0}>
      <div data-component="diagnostics">
        <For each={props.diagnostics}>
          {(diagnostic) => (
            <div data-slot="diagnostic">
              <span data-slot="diagnostic-label">{i18n.t("ui.messagePart.diagnostic.error")}</span>
              <span data-slot="diagnostic-location">
                [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}]
              </span>
              <span data-slot="diagnostic-message">{diagnostic.message}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

function ToolFileAccordion(props: { path: string; actions?: JSX.Element; children: JSX.Element }) {
  const value = createMemo(() => props.path || "tool-file")

  return (
    <Accordion
      multiple
      data-scope="apply-patch"
      style={{ "--sticky-accordion-offset": "40px" }}
      defaultValue={[value()]}
    >
      <Accordion.Item value={value()}>
        <StickyAccordionHeader>
          <Accordion.Trigger>
            <div data-slot="apply-patch-trigger-content">
              <div data-slot="apply-patch-file-info">
                <FileIcon node={{ path: props.path, type: "file" }} />
                <div data-slot="apply-patch-file-name-container">
                  <Show when={props.path.includes("/")}>
                    <span data-slot="apply-patch-directory">{`‪${getDirectory(props.path)}‬`}</span>
                  </Show>
                  <span data-slot="apply-patch-filename">{getFilename(props.path)}</span>
                </div>
              </div>
              <div data-slot="apply-patch-trigger-actions">
                {props.actions}
                <Icon name="chevron-grabber-vertical" size="small" />
              </div>
            </div>
          </Accordion.Trigger>
        </StickyAccordionHeader>
        <Accordion.Content>{props.children}</Accordion.Content>
      </Accordion.Item>
    </Accordion>
  )
}

function ShellSubmessage(props: { text: string; animate?: boolean }) {
  let widthRef: HTMLSpanElement | undefined
  let valueRef: HTMLSpanElement | undefined

  onMount(() => {
    if (!props.animate) return
    // V1 은 motion 스프링으로 폭을 펼쳤다. 같은 시간·곡선을 Web Animations 로 낸다.
    requestAnimationFrame(() => {
      if (widthRef) {
        const target = `${widthRef.scrollWidth}px`
        const run = widthRef.animate([{ width: "0px" }, { width: target }], { duration: 250, easing: "ease-out" })
        run.onfinish = () => {
          if (widthRef) widthRef.style.width = "auto"
        }
      }
      if (valueRef) {
        valueRef.animate(
          [
            { opacity: 0, filter: "blur(2px)" },
            { opacity: 1, filter: "blur(0px)" },
          ],
          {
            duration: 320,
            easing: "cubic-bezier(0.16, 1, 0.3, 1)",
            fill: "forwards",
          },
        )
      }
    })
  })

  return (
    <span data-component="shell-submessage">
      <span ref={widthRef} data-slot="shell-submessage-width" style={{ width: props.animate ? "0px" : undefined }}>
        <span data-slot="basic-tool-tool-subtitle">
          <span
            ref={valueRef}
            data-slot="shell-submessage-value"
            style={props.animate ? { opacity: 0, filter: "blur(2px)" } : undefined}
          >
            {props.text}
          </span>
        </span>
      </span>
    </span>
  )
}

function TitleSpinner(props: { slot: string }) {
  return (
    <span data-slot={props.slot}>
      <Spinner style={{ color: "currentColor" }} />
    </span>
  )
}

const ShellTool: Component<HostToolProps> = (props) => {
  const i18n = useI18n()
  const pending = () => pendingStatus(props.status)
  const sawPending = pending()
  const command = () => text(props.input.command) ?? text(props.metadata.command) ?? ""
  const description = () => text(props.input.description)
  const body = createMemo(() => {
    const out = (props.output || text(props.metadata.output) || "").replace(ANSI, "")
    return `$ ${command()}${out ? "\n\n" + out : ""}`
  })
  const [copied, setCopied] = createSignal(false)

  const copy = async () => {
    if (!body() || !(await writeClipboard(body()))) return
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <BasicTool
      icon="console"
      status={props.status}
      defaultOpen={props.defaultOpen}
      open={props.open}
      onOpenChange={props.onOpenChange}
      hasContent
      trigger={
        <div data-slot="basic-tool-tool-info-structured">
          <div data-slot="basic-tool-tool-info-main">
            <span data-slot="basic-tool-tool-title" class="inline-flex items-center gap-1.5">
              <Show when={pending()}>
                <TitleSpinner slot="basic-tool-title-spinner" />
              </Show>
              <TextShimmer
                text={pending() ? i18n.t("ui.tool.shellActive") : i18n.t("ui.tool.shell")}
                active={pending()}
              />
            </span>
            <Show when={pending() && command()}>
              <ShellSubmessage text={command()} animate={sawPending} />
            </Show>
            <Show when={!pending() && description()}>
              {(value) => <ShellSubmessage text={value()} animate={sawPending} />}
            </Show>
          </div>
        </div>
      }
    >
      <div data-component="bash-output">
        <div data-slot="bash-copy">
          <Tooltip
            value={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
            placement="top"
            gutter={4}
          >
            <IconButton
              icon={<Icon name={copied() ? "check" : "copy"} size="small" />}
              size="small"
              variant="neutral"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void copy()}
              aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
            />
          </Tooltip>
        </div>
        <div data-slot="bash-scroll" data-scrollable>
          <pre data-slot="bash-pre">
            <code>{body()}</code>
          </pre>
        </div>
      </div>
    </BasicTool>
  )
}

function FileTrigger(props: {
  component: string
  pending: boolean
  title: string
  activeTitle: string
  path?: string
  changes?: { additions: number; deletions: number }
}) {
  return (
    <div data-component={props.component}>
      <div data-slot="message-part-title-area">
        <div data-slot="message-part-title">
          <span data-slot="message-part-title-text">
            <Show when={props.pending}>
              <TitleSpinner slot="message-part-title-spinner" />
            </Show>
            <TextShimmer text={props.pending ? props.activeTitle : props.title} active={props.pending} />
          </span>
          <Show when={props.path}>
            {(path) => <span data-slot="message-part-title-filename">{getFilename(path())}</span>}
          </Show>
        </div>
        <Show when={!props.pending && props.path?.includes("/")}>
          <div data-slot="message-part-path">
            <span data-slot="message-part-directory">{getDirectory(props.path!)}</span>
          </div>
        </Show>
      </div>
      <div data-slot="message-part-actions">
        <Show when={props.changes && (props.changes.additions > 0 || props.changes.deletions > 0 || !props.pending)}>
          <DiffChanges changes={props.changes!} />
        </Show>
      </div>
    </div>
  )
}

const EditTool: Component<HostToolProps> = (props) => {
  const i18n = useI18n()
  const fileComponent = useFileComponent()
  const pending = () => pendingStatus(props.status)
  const inputPath = () => text(props.input.path)
  const diff = createMemo(() => fileDiff(props.metadata))
  const path = createMemo(() => diff()?.file ?? inputPath() ?? "")
  const changes = createMemo(() => {
    if (pending())
      return editPendingDiff({ oldString: props.input.oldString, newString: props.input.newString, raw: props.raw })
    return diff()
  })
  const view = createMemo(() => {
    const source = diff()
    if (source?.patch) {
      try {
        const value = resolveFileDiff({ file: source.file, patch: source.patch })
        if (value) return { fileDiff: value }
      } catch {}
    }
    return {
      before: { name: path(), contents: text(props.input.oldString) ?? "" },
      after: { name: path(), contents: text(props.input.newString) ?? "" },
    }
  })

  return (
    <div data-component="edit-tool">
      <BasicTool
        icon="code-lines"
        status={props.status}
        defaultOpen={props.defaultOpen}
        open={props.open}
        onOpenChange={props.onOpenChange}
        hasContent
        defer
        trigger={
          <FileTrigger
            component="edit-trigger"
            pending={pending()}
            title={i18n.t("ui.messagePart.title.edit")}
            activeTitle={i18n.t("ui.messagePart.title.editActive")}
            path={inputPath()}
            changes={changes()}
          />
        }
      >
        <Show when={path()}>
          <ToolFileAccordion
            path={path()}
            actions={<Show when={!pending() ? diff() : undefined}>{(value) => <DiffChanges changes={value()} />}</Show>}
          >
            <div data-component="edit-content">
              <Dynamic component={fileComponent} mode="diff" onRendered={props.onContentRendered} {...view()} />
            </div>
          </ToolFileAccordion>
        </Show>
        <DiagnosticsDisplay diagnostics={diagnostics(props.metadata, inputPath())} />
      </BasicTool>
    </div>
  )
}

const WriteTool: Component<HostToolProps> = (props) => {
  const i18n = useI18n()
  const fileComponent = useFileComponent()
  const pending = () => pendingStatus(props.status)
  const path = () => text(props.input.path) ?? ""
  const content = () => text(props.input.content)
  const changes = createMemo(() => {
    if (!pending()) return fileDiff(props.metadata)
    const value = content()
    const lines =
      value !== undefined
        ? value.split("\n").length
        : typeof props.raw === "string"
          ? countPartialStringLines(props.raw, "content")
          : 0
    return { additions: lines, deletions: 0 }
  })

  return (
    <div data-component="write-tool">
      <BasicTool
        icon="code-lines"
        status={props.status}
        defaultOpen={props.defaultOpen}
        open={props.open}
        onOpenChange={props.onOpenChange}
        hasContent
        defer
        trigger={
          <FileTrigger
            component="write-trigger"
            pending={pending()}
            title={i18n.t("ui.messagePart.title.write")}
            activeTitle={i18n.t("ui.messagePart.title.writeActive")}
            path={text(props.input.path)}
            changes={changes()}
          />
        }
      >
        <Show when={content() && path()}>
          <ToolFileAccordion path={path()}>
            <div data-component="write-content">
              <Dynamic
                component={fileComponent}
                mode="text"
                file={{ name: path(), contents: content()!, cacheKey: checksum(content()!) }}
                overflow="scroll"
                onRendered={props.onContentRendered}
              />
            </div>
          </ToolFileAccordion>
        </Show>
        <DiagnosticsDisplay diagnostics={diagnostics(props.metadata, path())} />
      </BasicTool>
    </div>
  )
}

const tools: Record<string, Component<HostToolProps>> = {
  shell: ShellTool,
  edit: EditTool,
  write: WriteTool,
}

export function jitdaTool(name: string) {
  return tools[name]
}
