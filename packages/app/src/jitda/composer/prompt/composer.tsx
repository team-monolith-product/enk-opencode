import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, type Component } from "solid-js"
import { DockShellForm } from "@opencode/ui/dock-surface"
import { useDialog } from "@opencode/ui/context/dialog"
import { showToast } from "@opencode/ui/toast"
import { encodeFilePath, getFilename } from "@opencode/util/path"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { useData } from "@/runtime/server/current"
import { useJitda } from "../../context"
import { Flags } from "../../flags"
import { previewCapture } from "../../side-panel/preview-capture"
import { Icon } from "../../env/ui/icon"
import { promptDocBridge as bridge } from "../bridge"
import { startSubmit, type DocPrompt } from "../doc-submit"
import { usePromptDocSession } from "../session"
import { formatKeybind } from "../util/keybind"
import { attachmentBudgetParams, MAX_ATTACHMENT_COUNT, MAX_ATTACHMENT_TOTAL_BYTES } from "../util/file-picker"
import { MAX_PROMPT_DOC_CHARS } from "../util/prompt"
import { createDocDrop } from "./attachments"
import { dataUrlToPngFile } from "./capture"
import { CaptureEditDialog } from "./capture-edit-dialog"
import { PromptDocShell } from "./doc-shell"
import { createImageGeneration } from "./image-toggle"
import { DialogClearSession } from "./clear-dialog"

export type JitdaPromptInputProps = {
  ref?: (el: HTMLDivElement) => void
  expanded?: boolean
  onComposerExpand?: (opts?: { initialScale?: number }) => void
  onComposerCollapse?: () => void
  composerShell?: {
    size: number
    min: number
    max: number
    onResize: (height: number) => void
  }
  onSubmit?: () => void
}

const DOC_MIN = 150
const DOC_HEIGHT = 300
const DOC_RATIO = 0.8
const AUTO_EXPAND_KEY = "prompt.doc.autoExpand"

const parseModel = (raw?: string) => {
  if (!raw) return undefined
  const slash = raw.indexOf("/")
  if (slash <= 0 || slash === raw.length - 1) return undefined
  return { providerID: raw.slice(0, slash), id: raw.slice(slash + 1) }
}

const promptLocale = (value?: string | null) => (value === "ko" || value === "en" ? value : undefined)

// V1 components/prompt-input.tsx 의 운영 경로(문서 모드 전용). 운영 빌드는 모드 전환 버튼·하단 바·트리거가 꺼져 있어
// 일반/셸 입력창은 화면에 나오지 않는다.
export const JitdaPromptInput: Component<JitdaPromptInputProps> = (props) => {
  const jitda = useJitda()
  const serverSDK = useServerSDK()
  const data = useData()
  const dialog = useDialog()
  const language = useLanguage()
  const session = usePromptDocSession()
  const doc = session.doc
  const working = session.working
  const readonly = jitda.readonly()

  const attachmentLimitMessage = () =>
    language.t("prompt.toast.tooManyAttachments.description", attachmentBudgetParams())

  let rootRef: HTMLDivElement | undefined

  const composerExpand = () => {
    if (!props.onComposerExpand || !props.onComposerCollapse) return
    return {
      expanded: !!props.expanded,
      onExpand: props.onComposerExpand,
      onCollapse: props.onComposerCollapse,
    }
  }

  const [height, setHeight] = createSignal(DOC_HEIGHT)
  const [draggingType, setDraggingType] = createSignal<"image" | "@mention" | null>(null)
  const [autoExpand, setAutoExpand] = createSignal(
    (() => {
      try {
        return localStorage.getItem(AUTO_EXPAND_KEY) === "1"
      } catch {
        return false
      }
    })(),
  )
  const [focusWithin, setFocusWithin] = createSignal(false)
  const capturing = previewCapture.capturing
  const setCapturing = previewCapture.setCapturing
  // 컴포저 안에서 시작된 클릭(포커스 못 받는 컨트롤 포함)으로 포커스가 body 로 빠지는 걸 이탈로 보지 않는다.
  let pointerDownInside = false
  // 마운트 직후 자동 포커스만으로는 확대하지 않는다. 문서 본문을 실제로 누르거나 타이핑한 뒤부터 자동 확대.
  const [interacted, setInteracted] = createSignal(false)
  const toggleAutoExpand = () => {
    const next = !autoExpand()
    setAutoExpand(next)
    try {
      localStorage.setItem(AUTO_EXPAND_KEY, next ? "1" : "0")
    } catch {}
  }
  createEffect(() => {
    if (!props.onComposerExpand || !props.onComposerCollapse) return
    // 캡처 중엔 확대된 입력창이 캡처 화면을 가리므로 축소하고, 끝날 때까지 재확대하지 않는다.
    if (capturing()) {
      if (props.expanded) props.onComposerCollapse()
      return
    }
    if (!autoExpand()) {
      if (props.expanded) props.onComposerCollapse()
      return
    }
    if (focusWithin() && interacted() && !props.expanded) props.onComposerExpand({ initialScale: 2 })
    else if (!focusWithin() && props.expanded) props.onComposerCollapse()
  })
  onMount(() => {
    const el = rootRef
    if (!el) return
    const mark = (e: Event) => {
      const t = e.target
      if (t instanceof Element && t.closest('[data-component="prompt-doc"]')) setInteracted(true)
    }
    const trackPointer = (e: PointerEvent) => {
      const t = e.target
      pointerDownInside = t instanceof Node && el.contains(t)
    }
    const clearPointer = () => {
      pointerDownInside = false
    }
    // doc 패널이 pointerdown 전파를 막으므로 캡처 단계로 듣는다.
    el.addEventListener("pointerdown", mark, true)
    el.addEventListener("keydown", mark, true)
    window.addEventListener("pointerdown", trackPointer, true)
    el.addEventListener("keydown", clearPointer, true)
    onCleanup(() => {
      el.removeEventListener("pointerdown", mark, true)
      el.removeEventListener("keydown", mark, true)
      window.removeEventListener("pointerdown", trackPointer, true)
      el.removeEventListener("keydown", clearPointer, true)
    })
  })

  const max = () => Math.max(DOC_MIN, Math.floor(window.innerHeight * DOC_RATIO))
  const clamp = (value: number) => Math.min(max(), Math.max(DOC_MIN, value))
  const fit = () => setHeight((value) => clamp(value))

  const drag = (event: PointerEvent, start: number, apply: (y: number) => void) => {
    event.preventDefault()
    event.stopPropagation()
    const y = event.clientY
    const html = document.documentElement
    const body = document.body
    const cursor = html.style.cursor
    const select = body.style.userSelect
    html.style.cursor = "ns-resize"
    body.style.userSelect = "none"
    const move = (event: PointerEvent) => apply(start + y - event.clientY)
    const up = () => {
      html.style.cursor = cursor
      body.style.userSelect = select
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
  }

  const shellResize = (event: PointerEvent) => {
    const bounds = props.composerShell
    if (!bounds || event.button !== 0) return
    drag(event, bounds.size, (value) => bounds.onResize(Math.min(bounds.max, Math.max(bounds.min, value))))
  }

  const resize = (event: PointerEvent) => {
    if (event.button !== 0) return
    drag(event, height(), (value) => setHeight(clamp(value)))
  }

  window.addEventListener("resize", fit)
  onCleanup(() => window.removeEventListener("resize", fit))
  createEffect(fit)

  const relPath = (path: string) => {
    const dir = jitda.directory.replace(/\/+$/, "")
    if (path.startsWith(dir) && (path === dir || path[dir.length] === "/")) {
      return path.slice(dir.length).replace(/^\/+/, "")
    }
    return path
  }

  createEffect(() => {
    bridge.setMode(session.mode())
  })
  createEffect(() => {
    bridge.setAddReference((path, nodeType) => doc.addReference(relPath(path), nodeType ?? "file"))
    bridge.setAddLineReference((input) => {
      const range = input.selection
      return doc.addLineReference({
        path: relPath(input.path),
        start: range.start,
        end: range.end,
        side: range.side,
        endSide: range.endSide,
        additionStart: range.additionStart,
        additionEnd: range.additionEnd,
        deletionStart: range.deletionStart,
        deletionEnd: range.deletionEnd,
        label: input.label,
        comment: input.comment,
        preview: input.preview,
      })
    })
    onCleanup(() => {
      bridge.setAddReference(undefined)
      bridge.setAddLineReference(undefined)
      bridge.setMode("normal")
    })
  })

  // 초과 전송이 막힐 때마다 올려 글자 수 카운터를 다시 흔든다.
  const [countShake, setCountShake] = createSignal(0)

  const hasDraft = createMemo(() => doc.filled())
  const submitAction = createMemo(() => (!working() ? "send" : "stop"))
  const submitIcon = createMemo(() => (submitAction() === "stop" ? ("stop" as const) : ("arrow-up-bold" as const)))
  const submitLabel = createMemo(() =>
    submitAction() === "stop" ? language.t("prompt.action.stop") : language.t("prompt.action.send"),
  )
  const keyLabel = (config: string) => {
    const label = formatKeybind(config, (key) => language.t(key))
    if (!label) return null
    return <span class="text-icon-base text-12-medium text-[10px]!">{label}</span>
  }
  const tip = createMemo(() => {
    const action = submitAction()
    if (action !== "stop" && doc.uploading()) return <span>{language.t("prompt.action.docUploading")}</span>
    if (action !== "stop" && doc.missing().length > 0) return <span>{language.t("prompt.action.docMissingAsset")}</span>
    if (action === "stop") {
      return (
        <div class="flex items-center gap-2">
          <span>{language.t("prompt.action.stop")}</span>
          {keyLabel("escape")}
        </div>
      )
    }
    return (
      <div class="flex items-center gap-2">
        <span>{language.t("prompt.action.send")}</span>
        {keyLabel(Flags.promptSubmitKey)}
      </div>
    )
  })

  const captureTab = async () => {
    if (capturing()) return
    setCapturing(true)
    let file: File | null = null
    try {
      const dataUrl = await previewCapture.capture()
      if (dataUrl) file = await dataUrlToPngFile(dataUrl)
    } catch {}
    if (!file) {
      showToast({
        title: language.t("prompt.toast.captureFailed.title"),
        description: language.t("prompt.toast.captureFailed.description"),
      })
      setCapturing(false)
      return
    }
    // 편집 모달에서 "추가" 를 눌러야 입력창에 들어간다. capturing 은 모달이 닫힐 때만 푼다.
    dialog.show(
      () => (
        <CaptureEditDialog
          file={file!}
          onAdd={async (edited) => {
            try {
              const { tooLarge, overflow } = await doc.addFiles([edited])
              if (tooLarge) {
                showToast({
                  title: language.t("prompt.toast.fileTooLarge.title"),
                  description: language.t("prompt.toast.fileTooLarge.description"),
                })
              } else if (overflow) {
                showToast({
                  title: language.t("prompt.toast.tooManyAttachments.title"),
                  description: attachmentLimitMessage(),
                })
              }
            } catch {
              showToast({ title: language.t("common.requestFailed") })
            }
          }}
        />
      ),
      () => setCapturing(false),
    )
  }

  createDocDrop({
    enabled: () => !readonly,
    isDialogActive: () => !!dialog.active,
    setDraggingType,
    focusEditor: () => doc.refocus(),
    dropPath: (path) => {
      const ok = doc.addReference(relPath(path))
      if (ok) session.setDropped([...session.dropped().filter((item) => item !== path), path])
      return ok
    },
    dropFiles: async (list) => {
      const { added, tooLarge, overflow } = await doc.addFiles(list)
      if (tooLarge) {
        showToast({
          title: language.t("prompt.toast.fileTooLarge.title"),
          description: language.t("prompt.toast.fileTooLarge.description"),
        })
      } else if (overflow) {
        showToast({
          title: language.t("prompt.toast.tooManyAttachments.title"),
          description: attachmentLimitMessage(),
        })
      } else if (!added && list.length > 0) {
        showToast({ title: language.t("common.requestFailed") })
      }
      return true
    },
  })

  const imageGeneration = createImageGeneration({ jitda, working })

  const model = () => {
    const env = jitda.env()
    const pin = parseModel(env.aiModel) ?? parseModel(Flags.modelPin)
    if (!pin) return undefined
    const variant = env.aiModelVariant ?? Flags.modelPinVariant
    return { ...pin, ...(variant ? { variant } : {}) }
  }

  const absolute = (path: string) => (path.startsWith("/") ? path : `${jitda.directory.replace(/[\\/]+$/, "")}/${path}`)

  const buildPrompt = (text: string, docID: string | undefined, assets: { uri: string; filename: string }[]) => {
    const pinned = model()
    const files = [
      ...session
        .dropped()
        .map((path) => ({ uri: `file://${encodeFilePath(absolute(path))}`, name: getFilename(path) })),
      ...assets.map((asset) => ({ uri: asset.uri, name: asset.filename })),
    ]
    const actorID = doc.actorID()
    return {
      text,
      ...(files.length > 0 ? { files } : {}),
      ...(pinned ? { model: pinned } : {}),
      metadata: {
        format: "markdown",
        source: "doc",
        ...(promptLocale(jitda.locale() ?? language.locale())
          ? { locale: promptLocale(jitda.locale() ?? language.locale()) }
          : {}),
        imageGeneration: imageGeneration.request(),
        ...(docID ? { jitda: { docID, ...(actorID ? { actorID } : {}) } } : {}),
      },
    } satisfies DocPrompt
  }

  // 같이 쓰는 문서면 합의 투표로 보낸다. 혼자로 보이면(awareness 기준) 투표 없이 바로 보낸다 — 실제 투표 인원은 서버가 정한다.
  const approve = async (sessionID: string, prompt: DocPrompt) => {
    const docID = doc.docID()
    const actorID = doc.actorID()
    if (!docID || !actorID) return false
    const list = doc.actors()
    const ids = Array.from(new Set([actorID, ...list.map((item) => item.actorID)]))
    if (ids.length <= 1) return false
    const names: Record<string, string> = {}
    for (const item of list) {
      const name = item.name?.trim()
      if (name && name !== item.actorID) names[item.actorID] = name
    }
    try {
      const state = await startSubmit({ api: jitda.doc, sessionID, docID, actorID, names, prompt })
      session.setApprovalSession(sessionID)
      session.showApproval(state)
      return true
    } catch {
      session.setApprovalSession(sessionID)
      showToast({
        title: language.t("docSubmit.toast.requestFailed"),
        description: language.t("common.requestFailed"),
      })
      return true
    }
  }

  const abort = async () => {
    const sessionID = session.sessionID()
    if (!sessionID) return
    await serverSDK.api.session.interrupt({ sessionID }).catch(() => {})
  }

  const send = async (sessionID: string, prompt: DocPrompt) => {
    const { model: pinned, metadata, ...rest } = prompt
    if (pinned) {
      await serverSDK.api.session
        .switchModel({
          sessionID,
          model: {
            id: pinned.id,
            providerID: pinned.providerID,
            ...(pinned.variant ? { variant: pinned.variant } : {}),
          },
        })
        .catch(() => undefined)
    }
    await data.session.prompt({
      sessionID,
      text: rest.text,
      ...(rest.files ? { files: rest.files } : {}),
      metadata: metadata as Record<string, never>,
    })
  }

  async function submit() {
    if (readonly) return
    if (submitAction() === "stop") {
      await session.requestStop()
      return
    }
    // 상한 초과: 버튼은 살려 둬서 누르면 반응한다 — 카운터를 흔들고 알리되 보내지 않는다.
    if (doc.length() > MAX_PROMPT_DOC_CHARS) {
      setCountShake((n) => n + 1)
      showToast({
        title: language.t("prompt.toast.docTooLong.title"),
        description: language.t("prompt.toast.docTooLong.description", {
          max: MAX_PROMPT_DOC_CHARS.toLocaleString(),
        }),
      })
      return
    }
    // 아직 올라가는 첨부는 내보내기에서 비어 버린다.
    if (doc.uploading()) {
      showToast({
        title: language.t("prompt.toast.docUploading.title"),
        description: language.t("prompt.toast.docUploading.description"),
      })
      return
    }
    // 바이트가 끝내 안 올라간 첨부(전송 중 탭이 닫힘)는 빈 링크로 나가 첨부가 조용히 사라진다.
    const stranded = doc.missing()
    if (stranded.length > 0) {
      showToast({
        title: language.t("prompt.toast.docMissingAsset.title"),
        description: language.t("prompt.toast.docMissingAsset.description", { name: stranded[0]!.name }),
      })
      return
    }
    // 첨부 예산의 마지막 방어선. BlockSuite 자체 붙여넣기·드래그는 addFiles 를 거치지 않는다.
    const usage = doc.assets()
    if (usage.count > MAX_ATTACHMENT_COUNT || usage.bytes > MAX_ATTACHMENT_TOTAL_BYTES) {
      showToast({
        title: language.t("prompt.toast.tooManyAttachments.title"),
        description: attachmentLimitMessage(),
      })
      return
    }
    const next = await doc.commitMarkdown()
    if (next?.missing.length) {
      showToast({
        title: language.t("prompt.toast.docMissingAsset.title"),
        description: language.t("prompt.toast.docMissingAsset.description", { name: next.missing[0]!.name }),
      })
      return
    }
    const text = next?.text
    if (!text) {
      if (working()) {
        await abort()
        return
      }
      showToast({
        title: language.t("prompt.toast.docEmpty.title"),
        description: language.t("prompt.toast.docEmpty.description"),
      })
      return
    }
    const sessionID = session.sessionID()
    if (!sessionID) {
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: language.t("prompt.toast.promptSendFailed.description"),
      })
      return
    }
    const docID = (await doc.refresh(sessionID).catch(() => undefined)) ?? doc.docID()
    const prompt = buildPrompt(text, docID, next?.assets ?? [])
    session.setApprovalSession(undefined)
    if (await approve(sessionID, prompt)) return
    props.onSubmit?.()
    const dropped = session.dropped()
    session.setDropped([])
    try {
      await send(sessionID, prompt)
    } catch (err) {
      session.setDropped(dropped)
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: err instanceof Error && err.message ? err.message : language.t("common.requestFailed"),
      })
      return
    }
    if (session.approvalSession() === sessionID) return
    try {
      await doc.advance(sessionID)
    } catch {
      showToast({
        title: language.t("prompt.toast.docAdvanceFailed.title"),
        description: language.t("prompt.toast.docAdvanceFailed.description"),
      })
    }
  }

  const clearSession = () =>
    dialog.show(() => (
      <DialogClearSession
        onClear={async () => {
          // 같이 쓰는 중이면 동의부터 구하고, 물어볼 상대가 없을 때만 바로 지운다.
          if (await session.requestClear()) return
          await session.clear()
        }}
      />
    ))

  session.setHandlers({
    submit: () => void submit(),
    abort,
  })
  onCleanup(() => session.setHandlers({}))

  return (
    <div
      ref={(el) => {
        rootRef = el
        props.ref?.(el)
      }}
      classList={{
        "relative flex w-full flex-col gap-0": true,
        "flex-1 min-h-0": props.expanded,
        relative: props.expanded,
      }}
      style={
        !props.expanded
          ? {
              height: `${height()}px`,
              "min-height": `${DOC_MIN}px`,
              "max-height": `${max()}px`,
            }
          : undefined
      }
      on:focusin={() => setFocusWithin(true)}
      on:focusout={() => {
        // 다음 틱에 실제 활성 요소가 컴포저 밖일 때만 이탈로 본다(에디터 내부 이동 깜빡임 방지).
        setTimeout(() => {
          if (!rootRef) return
          if (rootRef.contains(document.activeElement)) return
          const toIframe = document.activeElement instanceof HTMLIFrameElement
          if (pointerDownInside && !toIframe) return
          setFocusWithin(false)
        }, 0)
      }}
    >
      <Show when={!props.expanded}>
        <div
          data-component="prompt-doc-resize-handle"
          class="group absolute -top-2.5 left-8 right-8 z-30 flex h-3 cursor-ns-resize touch-none items-center justify-center"
          onPointerDown={resize}
        >
          <div class="h-0.5 w-18 rounded-none bg-border-weaker-base transition-colors group-hover:bg-border-strong-base" />
        </div>
      </Show>
      <Show when={props.expanded && props.composerShell}>
        <div
          data-component="prompt-composer-resize-handle"
          class="group absolute -top-2.5 left-8 right-8 z-30 flex h-3 cursor-ns-resize touch-none items-center justify-center"
          onPointerDown={shellResize}
        >
          <div class="h-0.5 w-18 rounded-none bg-border-weaker-base transition-colors group-hover:bg-border-strong-base" />
        </div>
      </Show>
      <DockShellForm
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
        classList={{
          "group/prompt-input": true,
          "border-icon-info-active border-dashed": draggingType() !== null,
          "flex min-h-0 flex-1 flex-col": true,
        }}
      >
        <Show when={draggingType() !== null}>
          <div class="absolute inset-0 z-10 flex items-center justify-center bg-surface-raised-stronger-non-alpha/90 pointer-events-none">
            <div class="flex flex-col items-center gap-2 text-text-weak">
              <Icon name={draggingType() === "@mention" ? "link" : "photo"} class="size-8" />
              <span class="text-14-regular">
                {language.t(draggingType() === "@mention" ? "prompt.dropzone.file.label" : "prompt.dropzone.label")}
              </span>
            </div>
          </div>
        </Show>
        <div data-component="prompt-body" classList={{ relative: true, "flex min-h-0 flex-1 flex-col": true }}>
          <PromptDocShell
            imageToggle={<imageGeneration.Toggle />}
            doc={doc}
            readonly={readonly}
            submitIcon={submitIcon()}
            submitLabel={submitLabel()}
            length={doc.length()}
            maxLength={MAX_PROMPT_DOC_CHARS}
            shake={countShake()}
            submitDisabled={
              readonly || (submitAction() === "send" && (!hasDraft() || doc.uploading() || doc.missing().length > 0))
            }
            tip={tip()}
            onCapture={captureTab}
            capturing={capturing()}
            canCapture={previewCapture.canCapture()}
            clearDisabled={session.votePending()}
            onClear={clearSession}
            expand={composerExpand()}
            autoExpand={{ enabled: autoExpand(), onToggle: toggleAutoExpand }}
          />
        </div>
      </DockShellForm>
    </div>
  )
}
