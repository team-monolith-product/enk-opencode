import { For, Match, Show, Switch, createMemo, createSignal } from "solid-js"
import { Portal } from "solid-js/web"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DockShellForm } from "@opencode-ai/ui/dock-surface"
import { createAutoScroll } from "@opencode-ai/ui/hooks"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ImagePreview } from "@opencode-ai/ui/image-preview"
import { SessionTurn } from "@opencode-ai/ui/session-turn"
import { showToast } from "@opencode-ai/ui/toast"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { PromptImageAttachments } from "@/components/prompt-input/image-attachments"
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENT_TOTAL_BYTES,
} from "@/constants/file-picker"
import { ACCEPTED_FILE_TYPES, attachmentMime } from "@/components/prompt-input/files"
import { useLanguage } from "@/context/language"
import type { ImageAttachmentPart } from "@/context/prompt"
import { useSettings } from "@/context/settings"
import { Identifier } from "@/utils/id"
import { useSideChat, type SideAttachment } from "./context"

// 메인 컴포저와 달리 첨부 저장소에 올리지 않고 data url 로 싣는다 — 사이드 세션에는 프롬프트 doc 이 없다.
// mime 은 메인과 같은 attachmentMime 판정값으로 바꿔 끼운다(브라우저가 비워 두는 .ts·.md 등).
function readDataUrl(file: File, mime: string) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(`data:${mime};base64,${String(reader.result).split(",")[1] ?? ""}`)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

// 같은 이름("image.png")으로 여러 번 붙여도 handoff 가 하나를 정확히 가리키도록 이름을 겹치지 않게 만든다.
function uniqueName(file: File, mime: string) {
  const dot = file.name.lastIndexOf(".")
  const ext = dot > 0 ? file.name.slice(dot) : `.${mime.split("/")[1] ?? "bin"}`
  const base = (dot > 0 ? file.name.slice(0, dot) : file.name || "image").replace(/[^\p{L}\p{N}_-]+/gu, "-") || "image"
  return `${base}-${Identifier.ascending("part").slice(-6)}${ext}`
}

export function SideChatPanel() {
  const side = useSideChat()
  const language = useLanguage()
  const settings = useSettings()
  const dialog = useDialog()

  // 초안은 세션 레벨(context)에 둔다 — 다른 탭을 보고 돌아와 패널이 다시 마운트돼도 남는다.
  const text = () => side.draft().text
  const images = () => side.draft().attachments
  const [sending, setSending] = createSignal(false)
  const [menu, setMenu] = createSignal<{ left: number; bottom: number }>()
  let input: HTMLTextAreaElement | undefined
  let imagePicker: HTMLInputElement | undefined
  let filePicker: HTMLInputElement | undefined
  let attachButton: HTMLButtonElement | undefined

  // 메인 컴포저의 + 메뉴(doc-shell.tsx)와 같은 팝오버 — 버튼 바로 위로 연다.
  const openMenu = () => {
    if (!attachButton) return
    const rect = attachButton.getBoundingClientRect()
    setMenu({ left: rect.left, bottom: window.innerHeight - rect.top + 4 })
  }
  const closeMenu = () => setMenu(undefined)

  const attachments = createMemo(() =>
    images().map(
      (image): ImageAttachmentPart => ({
        type: "image",
        id: image.id,
        filename: image.name,
        mime: image.mime,
        url: image.url,
        size: image.size,
      }),
    ),
  )

  // 포크로 복사된 메인 기록은 메인 화면에 이미 있다 — 사이드에서 오간 턴만 보여 준다.
  // 복사된 메시지는 원래 생성 시각을 그대로 갖는다(Session.fork 가 info 를 펼쳐 복사).
  const since = createMemo(() => side.session()?.time.created ?? Number.POSITIVE_INFINITY)
  const turns = createMemo(() =>
    (side.messages() ?? []).filter((message) => message.role === "user" && message.time.created >= since()),
  )
  // 처음엔 최근 80개만 받는다. 받은 것 중 가장 오래된 메시지도 사이드에서 오간 것이면 그 앞에 사이드 턴이
  // 더 있을 수 있다 — 복사된 메인 기록까지 내려왔다면 더 볼 사이드 턴이 없다.
  const olderTurns = createMemo(() => side.history.more() && (side.messages()?.[0]?.time.created ?? 0) >= since())
  const lastTurn = createMemo(() => turns().at(-1)?.id)

  const autoScroll = createAutoScroll({ working: side.busy, overflowAnchor: "dynamic" })

  // 메인 컴포저와 같은 규칙: 한 장 10MB, 한 번에 10개·합계 25MB, 이미지·PDF·텍스트만.
  // 붙여넣기·드롭이 연달아 와도 한 번에 하나씩 — 각자 같은 "현재 개수"를 보고 한도를 같이 넘지 않게.
  let adding = Promise.resolve()
  // 파일을 고른 시점의 초안에 붙인다 — 읽는 사이 다른 메인 세션으로 옮겨도 그 세션 초안에 섞이지 않게.
  const addFiles = (files: File[]) => {
    const target = side.draftKey()
    adding = adding.then(() => addNow(files, target)).catch(() => undefined)
    return adding
  }

  const addNow = async (files: File[], target: string | undefined) => {
    if (files.length === 0 || !target) return
    const current = side.draftFor(target).attachments
    let count = current.length
    let bytes = current.reduce((sum, item) => sum + item.size, 0)
    const rejected = new Set<"size" | "type" | "overflow">()
    const next: SideAttachment[] = []
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        rejected.add("size")
        continue
      }
      const mime = await attachmentMime(file)
      if (!mime) {
        rejected.add("type")
        continue
      }
      if (count + 1 > MAX_ATTACHMENT_COUNT || bytes + file.size > MAX_ATTACHMENT_TOTAL_BYTES) {
        rejected.add("overflow")
        continue
      }
      count += 1
      bytes += file.size
      next.push({
        id: Identifier.ascending("part"),
        name: uniqueName(file, mime),
        mime,
        url: await readDataUrl(file, mime),
        size: file.size,
      })
    }
    side.setDraftAttachments((list) => [...list, ...next], target)
    if (rejected.has("size"))
      showToast({
        title: language.t("prompt.toast.fileTooLarge.title"),
        description: language.t("prompt.toast.fileTooLarge.description"),
      })
    if (rejected.has("type"))
      showToast({
        title: language.t("prompt.toast.pasteUnsupported.title"),
        description: language.t("prompt.toast.pasteUnsupported.description"),
      })
    if (rejected.has("overflow"))
      showToast({
        title: language.t("prompt.toast.tooManyAttachments.title"),
        description: language.t("prompt.toast.tooManyAttachments.description", {
          count: MAX_ATTACHMENT_COUNT.toLocaleString(),
          size: Math.round(MAX_ATTACHMENT_TOTAL_BYTES / (1024 * 1024)).toLocaleString(),
        }),
      })
  }

  const submit = async () => {
    if (sending() || side.busy()) return
    if (!text().trim() && images().length === 0) return
    const { draft, restore } = side.takeDraft()
    setSending(true)
    const ok = await side.send(draft.text, draft.attachments)
    setSending(false)
    if (!ok) return restore()
    autoScroll.forceScrollToBottom()
    input?.focus()
  }

  return (
    <div data-component="side-chat" class="flex flex-col h-full min-h-0">
      <div ref={autoScroll.scrollRef} onScroll={autoScroll.handleScroll} class="flex-1 min-h-0 overflow-y-auto">
        <div ref={autoScroll.contentRef} class="flex flex-col gap-4 py-4">
          <Show when={olderTurns()}>
            <div class="flex justify-center">
              <Button
                size="small"
                variant="ghost"
                disabled={side.history.loading()}
                onClick={() => side.history.loadMore()}
              >
                {language.t("sideChat.history.loadMore")}
              </Button>
            </div>
          </Show>
          <Switch>
            <Match when={!side.sessionID()}>
              <div class="flex flex-col items-center gap-3 px-6 pt-16 text-center">
                <div class="text-14-medium text-text-strong">{language.t("sideChat.empty.title")}</div>
                <div class="text-12-regular text-text-weak max-w-72">{language.t("sideChat.empty.description")}</div>
                <Button size="normal" variant="primary" disabled={side.creating()} onClick={() => void side.open()}>
                  {language.t("sideChat.start")}
                </Button>
              </div>
            </Match>
            <Match when={turns().length === 0}>
              <div class="px-6 pt-16 text-center text-12-regular text-text-weak">{language.t("sideChat.ready")}</div>
            </Match>
            <Match when={true}>
              <For each={turns()}>
                {(message) => (
                  <SessionTurn
                    sessionID={side.sessionID()!}
                    messageID={message.id}
                    messages={side.messages()}
                    active={side.busy() && message.id === lastTurn()}
                    showReasoningSummaries={settings.general.showReasoningSummaries()}
                    shellToolDefaultOpen={false}
                    editToolDefaultOpen={false}
                    classes={{
                      root: "min-w-0 w-full relative",
                      content: "flex flex-col justify-between !overflow-visible",
                      container: "w-full px-3",
                    }}
                  />
                )}
              </For>
            </Match>
          </Switch>
        </div>
      </div>

      <Show when={side.sessionID()}>
        {/* 메인 컴포저와 같은 부품을 쓴다 — DockShellForm(카드·포커스 링), 44px 액션바, 원형 + 버튼,
            PromptImageAttachments 썸네일, 32px primary 전송 버튼. */}
        <div
          class="shrink-0 px-3 pb-4 pt-1"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            const files = Array.from(e.dataTransfer?.files ?? [])
            if (files.length === 0) return
            e.preventDefault()
            void addFiles(files)
          }}
        >
          <DockShellForm
            class="flex flex-col"
            onSubmit={(e) => {
              e.preventDefault()
              if (side.busy()) side.abort()
              else void submit()
            }}
          >
            <PromptImageAttachments
              attachments={attachments()}
              src={(attachment) => attachment.url}
              onOpen={(attachment) =>
                dialog.show(() => <ImagePreview src={attachment.url} alt={attachment.filename} />)
              }
              onRemove={(id) => side.setDraftAttachments((list) => list.filter((item) => item.id !== id))}
              removeLabel={language.t("sideChat.image.remove")}
            />
            <textarea
              ref={input}
              data-component="side-chat-input"
              rows={2}
              value={text()}
              placeholder={language.t("sideChat.placeholder")}
              class="block w-full resize-none bg-transparent px-3.5 py-3 text-14-regular text-text-strong placeholder:text-text-weak outline-none max-h-40"
              onInput={(e) => side.setDraftText(e.currentTarget.value)}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData?.files ?? [])
                if (files.length === 0) return
                e.preventDefault()
                void addFiles(files)
              }}
              onKeyDown={(e) => {
                // 한글 조합 중 Enter 는 글자 확정이다 — 전송하면 마지막 글자가 잘린다.
                if (e.isComposing || e.key !== "Enter" || e.shiftKey) return
                e.preventDefault()
                void submit()
              }}
            />
            <div
              data-component="side-chat-actions"
              class="relative flex h-11 shrink-0 items-center justify-between gap-2 border-t border-border-weaker-base bg-surface-raised-stronger-non-alpha px-2 py-0"
            >
              <div class="flex items-center gap-0.5">
                <input
                  ref={imagePicker}
                  type="file"
                  accept={ACCEPTED_IMAGE_TYPES.join(",")}
                  multiple
                  hidden
                  tabindex={-1}
                  aria-hidden="true"
                  onChange={(e) => {
                    void addFiles(Array.from(e.currentTarget.files ?? []))
                    e.currentTarget.value = ""
                  }}
                />
                <input
                  ref={filePicker}
                  type="file"
                  accept={ACCEPTED_FILE_TYPES.join(",")}
                  multiple
                  hidden
                  tabindex={-1}
                  aria-hidden="true"
                  onChange={(e) => {
                    void addFiles(Array.from(e.currentTarget.files ?? []))
                    e.currentTarget.value = ""
                  }}
                />
                <Show when={menu()}>
                  {(pos) => (
                    <Portal>
                      <div onMouseDown={(e) => e.preventDefault()} onClick={closeMenu} class="fixed inset-0 z-[50]" />
                      <div
                        class="oc-attach-menu"
                        role="menu"
                        style={{
                          position: "fixed",
                          left: `${pos().left}px`,
                          bottom: `${pos().bottom}px`,
                          "z-index": "51",
                        }}
                      >
                        <button
                          class="oc-attach-item"
                          role="menuitem"
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            imagePicker?.click()
                            closeMenu()
                          }}
                        >
                          <Icon name="photo" class="size-3.75 shrink-0 text-icon-base" />
                          {language.t("prompt.action.attachImage")}
                        </button>
                        <button
                          class="oc-attach-item"
                          role="menuitem"
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            filePicker?.click()
                            closeMenu()
                          }}
                        >
                          <Icon name="file" class="size-3.75 shrink-0 text-icon-base" />
                          {language.t("prompt.action.attachFile")}
                        </button>
                      </div>
                    </Portal>
                  )}
                </Show>
                <IconButton
                  ref={(el) => (attachButton = el)}
                  type="button"
                  icon="plus"
                  variant="ghost"
                  class="size-7.5 oc-attach-btn"
                  classList={{ "is-open": !!menu() }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => (menu() ? closeMenu() : openMenu())}
                  aria-label={language.t("prompt.action.attachFile")}
                  aria-haspopup="menu"
                  aria-expanded={!!menu()}
                />

                <span class="mx-1 h-4 w-px shrink-0 bg-border-weaker-base" />

                {/* 탭 위 헤더 줄을 없애면서 옮겨 왔다 — 메인 액션바의 지우기 버튼 자리와 같은 결. */}
                <Tooltip placement="top" value={language.t("sideChat.restart")}>
                  <IconButton
                    type="button"
                    icon="reset"
                    variant="ghost"
                    class="size-7.5"
                    disabled={side.creating() || side.busy()}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void side.restart()}
                    aria-label={language.t("sideChat.restart")}
                  />
                </Tooltip>
              </div>
              <Tooltip placement="top" value={language.t(side.busy() ? "sideChat.stop" : "sideChat.send")}>
                <IconButton
                  type="submit"
                  icon={side.busy() ? "stop" : "arrow-up-bold"}
                  variant="primary"
                  class="size-7.5"
                  disabled={!side.busy() && (sending() || (!text().trim() && images().length === 0))}
                  aria-label={language.t(side.busy() ? "sideChat.stop" : "sideChat.send")}
                />
              </Tooltip>
            </div>
          </DockShellForm>
        </div>
      </Show>
    </div>
  )
}
