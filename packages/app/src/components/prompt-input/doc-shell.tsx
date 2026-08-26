import { Component, createEffect, createSignal, JSX, on, Show } from "solid-js"
import { Portal } from "solid-js/web"
import type { IconProps } from "@opencode-ai/ui/icon"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { writeClipboard } from "@opencode-ai/ui/util/clipboard"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { showToast } from "@opencode-ai/ui/toast"
import { useClientEnv } from "@/context/client-env"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { ACCEPTED_FILE_TYPES } from "./files"
import { ACCEPTED_IMAGE_TYPES, MAX_ATTACHMENT_COUNT, MAX_ATTACHMENT_TOTAL_BYTES } from "@/constants/file-picker"
import { PromptDocPanel } from "./doc-panel"
import type { createPromptDoc } from "./doc"

type ShellProps = {
  doc: ReturnType<typeof createPromptDoc>
  /** A readonly viewer sees the doc content but no editing/submit affordances. */
  readonly?: boolean
  submitIcon: IconProps["name"]
  submitLabel: string
  submitDisabled?: boolean
  /** Current prompt length in characters (code points). */
  length: number
  /** Upper bound; the counter fades in as it is approached and turns red when exceeded. */
  maxLength: number
  /** Nonce — bump it to replay the over-limit shake (e.g. when submit is blocked). */
  shake: number
  tip: JSX.Element
  onExit: () => void | Promise<void>
  modes?: JSX.Element
  onCapture: () => void
  capturing?: boolean
  /** 다른 합의가 도는 중에는 지우기를 시작할 수 없다. */
  clearDisabled?: boolean
  /** 미리보기가 캡처 가능한 상태(URL·ready·패널 열림)인지. false 면 캡처 항목을 비활성화한다. */
  canCapture?: boolean
  expand?: {
    expanded: boolean
    onExpand: () => void
    onCollapse: () => void
  }
  autoExpand?: {
    enabled: boolean
    onToggle: () => void
  }
}

export const PromptDocShell: Component<ShellProps> = (props) => {
  const env = useClientEnv()
  const command = useCommand()
  const language = useLanguage()
  let fileInputRef: HTMLInputElement | undefined
  let imageInputRef: HTMLInputElement | undefined
  let attachBtnRef: HTMLButtonElement | undefined
  const [copied, setCopied] = createSignal(false)
  const [attachOpen, setAttachOpen] = createSignal(false)
  const [attachPos, setAttachPos] = createSignal<{ left: number; bottom: number } | null>(null)
  let countRef: HTMLSpanElement | undefined

  // 세션이 등록한 컴팩션 커맨드. 세션 밖(읽기 전용 뷰어 등)에서는 없으므로 그때는 버튼을 잠근다.
  const compactCommand = () => command.options.find((x) => x.id === "session.compact")
  // 레이아웃이 등록한 세션 지우기 커맨드. 세션 밖에서는 disabled 라 버튼도 같이 잠긴다.
  const clearCommand = () => command.options.find((x) => x.id === "session.clear")

  const ratio = () => (props.maxLength > 0 ? props.length / props.maxLength : 0)
  const over = () => props.length > props.maxLength
  // 어느 정도 차면(상한의 80%) 그냥 나타난다 — 글자 수에 따라 서서히 진해지는 램프는 쓰지 않는다.
  const SHOW_AT = 0.8

  // 전송이 막힐 때(props.shake 증가) 초과 글자수를 좌우로 흔들어 시선을 끈다. Web Animations API라
  // 별도 CSS 키프레임 없이 매번 깔끔하게 재생된다.
  createEffect(
    on(
      () => props.shake,
      (v, prev) => {
        if (!v || v === prev) return
        countRef?.animate(
          [
            { transform: "translateX(0)" },
            { transform: "translateX(-3px)" },
            { transform: "translateX(3px)" },
            { transform: "translateX(-2px)" },
            { transform: "translateX(2px)" },
            { transform: "translateX(0)" },
          ],
          { duration: 360, easing: "ease-in-out" },
        )
      },
      { defer: true },
    ),
  )

  const openAttach = () => {
    if (!attachBtnRef) return
    const r = attachBtnRef.getBoundingClientRect()
    setAttachPos({ left: r.left, bottom: window.innerHeight - r.top + 4 })
    setAttachOpen(true)
  }
  const closeAttach = () => { setAttachOpen(false); setAttachPos(null) }
  const pickFiles = async (list: File[]) => {
    const { tooLarge, overflow } = await props.doc.addFiles(list)
    if (tooLarge) {
      showToast({
        title: language.t("prompt.toast.fileTooLarge.title"),
        description: language.t("prompt.toast.fileTooLarge.description"),
      })
      return
    }
    // Files silently dropped for the per-prompt budget. Without this the picker just closes and
    // nothing appears, which reads as the attach button being broken.
    if (overflow) {
      showToast({
        title: language.t("prompt.toast.tooManyAttachments.title"),
        description: language.t("prompt.toast.tooManyAttachments.description", {
          count: MAX_ATTACHMENT_COUNT.toLocaleString(),
          size: Math.round(MAX_ATTACHMENT_TOTAL_BYTES / (1024 * 1024)).toLocaleString(),
        }),
      })
    }
  }
  const history = () => props.doc.history
  const undo = () => props.doc.undo()
  const redo = () => props.doc.redo()
  const label = () => {
    const id = props.doc.docID()
    if (!id) return "—"
    return id.replace(/^doc_/, "").slice(0, 8)
  }
  const copy = async () => {
    const id = props.doc.docID()
    if (!id) return
    if (!(await writeClipboard(id))) return
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  const expandLabel = () => {
    const expand = props.expand
    if (!expand) return ""
    return expand.expanded ? language.t("prompt.action.collapseView") : language.t("prompt.action.expandView")
  }

  return (
    <div
      data-component="prompt-doc-shell"
      class="flex min-h-0 w-full flex-1 flex-col"
    >
      <div
        classList={{
          "relative min-h-0 w-full overflow-hidden": true,
          "flex-1": true,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <PromptDocPanel doc={props.doc} />
        <Show when={!env.productionLayout()}>
          <div
            data-component="prompt-doc-id"
            class="absolute bottom-0 right-0 z-10 max-w-[40%] rounded-tl-[10px] text-text-weaker"
          >
            <Tooltip
              placement="top"
              value={copied() ? language.t("ui.message.copied") : language.t("ui.textField.copyToClipboard")}
            >
              <button
                type="button"
                class="flex max-w-full items-center justify-start rounded-tl-lg rounded-tr-none rounded-br-none rounded-bl-none bg-surface-raised-stronger-non-alpha px-2 py-1 font-mono text-11-regular leading-[13px] text-text-weaker shadow-sm ring-1 ring-border-weaker-base hover:ring-border-base"
                title={props.doc.docID() ?? ""}
                onClick={copy}
                aria-label={copied() ? language.t("ui.message.copied") : language.t("ui.textField.copyToClipboard")}
              >
                <span class="truncate">{label()}</span>
              </button>
            </Tooltip>
          </div>
        </Show>
      </div>
      <div
        data-component="prompt-doc-actions"
        class="relative flex h-11 shrink-0 items-center justify-between gap-2 border-t border-border-weaker-base bg-surface-raised-stronger-non-alpha px-2 py-0"
      >
        <div class="flex items-center gap-0.5">
          {props.modes}

          {/* + Attach — 클릭 시 이미지·파일·미리보기 캡처 메뉴 팝오버 */}
          <div>
            {/* file inputs — 포털 밖에 두어 doc.addFiles 클로저가 작동하도록 */}
            <input
              ref={imageInputRef}
              type="file"
              multiple
              accept={ACCEPTED_IMAGE_TYPES.join(",")}
              hidden
              tabindex={-1}
              aria-hidden="true"
              onChange={(e) => {
                const list = e.currentTarget.files
                if (list?.length) void pickFiles(Array.from(list))
                e.currentTarget.value = ""
              }}
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPTED_FILE_TYPES.join(",")}
              hidden
              tabindex={-1}
              aria-hidden="true"
              onChange={(e) => {
                const list = e.currentTarget.files
                if (list?.length) void pickFiles(Array.from(list))
                e.currentTarget.value = ""
              }}
            />
            <Show when={attachOpen() && attachPos()}>
              <Portal>
                <div
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={closeAttach}
                  class="fixed inset-0 z-[50]"
                />
                <div
                  data-component="prompt-doc-attach-menu"
                  class="oc-attach-menu"
                  role="menu"
                  style={{
                    position: "fixed",
                    left: `${attachPos()!.left}px`,
                    bottom: `${attachPos()!.bottom}px`,
                    "z-index": "51",
                  }}
                >
                  <button
                    class="oc-attach-item"
                    role="menuitem"
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { imageInputRef?.click(); closeAttach() }}
                    aria-label={language.t("prompt.action.attachImage")}
                  >
                    <Icon name="photo" class="size-3.75 shrink-0 text-icon-base" />
                    {language.t("prompt.action.attachImage")}
                  </button>
                  <button
                    class="oc-attach-item"
                    role="menuitem"
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { fileInputRef?.click(); closeAttach() }}
                    aria-label={language.t("prompt.action.attachFile")}
                  >
                    <Icon name="file" class="size-3.75 shrink-0 text-icon-base" />
                    {language.t("prompt.action.attachFile")}
                  </button>
                  <button
                    class="oc-attach-item"
                    role="menuitem"
                    type="button"
                    disabled={props.capturing || !props.canCapture}
                    title={!props.canCapture ? language.t("prompt.action.captureTab.disabledHint") : undefined}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { props.onCapture(); closeAttach() }}
                    aria-label={language.t("prompt.action.captureTab")}
                  >
                    <Icon name="pencil-line" class="size-3.75 shrink-0 text-icon-base" />
                    {language.t("prompt.action.captureTab")}
                  </button>
                </div>
              </Portal>
            </Show>
            <IconButton
              ref={(el) => { attachBtnRef = el }}
              data-action="prompt-doc-attach"
              type="button"
              icon="plus"
              variant="ghost"
              class="size-7.5 oc-attach-btn"
              classList={{ "is-open": attachOpen() }}
              disabled={props.readonly || !props.doc.ready()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => attachOpen() ? closeAttach() : openAttach()}
              aria-label={language.t("prompt.action.attachFile")}
              aria-haspopup="menu"
              aria-expanded={attachOpen()}
            />
          </div>

          {/* | 구분자 */}
          <span class="mx-1 h-4 w-px shrink-0 bg-border-weaker-base" />

          {/* ← → undo/redo */}
          <Tooltip placement="top" value={language.t("prompt.action.docUndo")}>
            <IconButton
              data-action="prompt-doc-undo"
              type="button"
              icon="arrow-left"
              variant="ghost"
              class="size-7.5"
              disabled={!history().undo}
              onClick={undo}
              aria-label={language.t("prompt.action.docUndo")}
            />
          </Tooltip>
          <Tooltip placement="top" value={language.t("prompt.action.docRedo")}>
            <IconButton
              data-action="prompt-doc-redo"
              type="button"
              icon="arrow-right"
              variant="ghost"
              class="size-7.5"
              disabled={!history().redo}
              onClick={redo}
              aria-label={language.t("prompt.action.docRedo")}
            />
          </Tooltip>

          <Show when={props.expand && !env.productionLayout()}>
            <Tooltip placement="top" value={expandLabel()}>
              <IconButton
                data-action={props.expand!.expanded ? "composer-collapse" : "composer-expand"}
                type="button"
                variant="ghost"
                icon={props.expand!.expanded ? "collapse" : "expand"}
                class="size-7.5"
                aria-label={expandLabel()}
                aria-expanded={props.expand!.expanded}
                onClick={() =>
                  props.expand!.expanded ? props.expand!.onCollapse() : props.expand!.onExpand()
                }
              />
            </Tooltip>
          </Show>
          <Show when={props.autoExpand}>
            <span class="mx-1 h-4 w-px shrink-0 bg-border-weaker-base" />
            <Tooltip placement="top" value={language.t("prompt.action.docAutoExpandHint")}>
              <button
                type="button"
                data-action="prompt-doc-auto-expand"
                role="switch"
                aria-checked={props.autoExpand!.enabled}
                aria-label={language.t("prompt.action.docAutoExpand")}
                class="oc-auto-toggle"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => props.autoExpand!.onToggle()}
              >
                <span class="oc-auto-track" classList={{ "is-on": props.autoExpand!.enabled }}>
                  <span class="oc-auto-thumb" />
                </span>
                <span class="oc-auto-label">{language.t("prompt.action.docAutoExpand")}</span>
              </button>
            </Tooltip>
          </Show>

          <span class="mx-1 h-4 w-px shrink-0 bg-border-weaker-base" />

          {/* 컴팩션 — devMode 전용. 슬래시 팝오버는 배포 빌드에서 통째로 꺼져 있어 /compact 로는 닿지 않는다. */}
          <Show when={env.devMode()}>
            <Tooltip placement="top" value={language.t("command.session.compact.description")}>
              <IconButton
                data-action="prompt-doc-compact"
                type="button"
                icon="archive"
                variant="ghost"
                class="size-7.5"
                disabled={compactCommand()?.disabled ?? true}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => command.trigger("session.compact")}
                aria-label={language.t("command.session.compact")}
              />
            </Tooltip>
          </Show>

          {/* 세션 지우기 — 확인창을 거치고, 같이 쓰는 중이면 거기서 동의 투표로 이어진다.
              배포 레이아웃엔 사이드바가 없어 사이드바의 보관 버튼에는 닿을 수 없다. */}
          <Tooltip placement="top" value={language.t("command.session.clear")}>
            <IconButton
              data-action="prompt-doc-clear-session"
              type="button"
              icon="trash"
              variant="ghost"
              class="size-7.5"
              disabled={props.readonly || props.clearDisabled || (clearCommand()?.disabled ?? true)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => command.trigger("session.clear")}
              aria-label={language.t("command.session.clear")}
            />
          </Tooltip>
        </div>
        <div class="flex items-center gap-2">
          {/* 글자 수 카운터 — 상한 80%에 닿는 순간 그냥 나타난다. 초과 시 현재 글자수만 빨간색으로 전환 */}
          <Show when={!props.readonly && ratio() >= SHOW_AT}>
            <span
              data-component="prompt-doc-count"
              class="shrink-0 select-none tabular-nums text-11-regular text-text-weaker"
              aria-live="polite"
            >
              <span ref={(el) => (countRef = el)} class="inline-block" classList={{ "text-icon-critical-base": over() }}>
                {props.length.toLocaleString()}
              </span>
              {" / "}
              {props.maxLength.toLocaleString()}
            </span>
          </Show>
          <Tooltip placement="top" value={props.tip}>
            <IconButton
              data-action="prompt-submit"
              type="submit"
              icon={props.submitIcon}
              variant="primary"
              class="size-7.5"
              disabled={props.submitDisabled}
              aria-label={props.submitLabel}
            />
          </Tooltip>
        </div>
      </div>
    </div>
  )
}
