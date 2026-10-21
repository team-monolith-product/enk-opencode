import {
  createEffect,
  createMemo,
  createSignal,
  ErrorBoundary,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import type { FileSearchHandle } from "@opencode/session-ui/file"
import { useFileComponent } from "@opencode/ui/context/file"
import { cloneSelectedLineRange, previewSelectedLines } from "@opencode/session-ui/pierre/selection-bridge"
import { createLineCommentController } from "@opencode/session-ui/line-comment-annotations"
import { sampledChecksum } from "@opencode/util/encode"
import { Menu } from "@opencode/ui/menu"
import { Tabs } from "@opencode/ui/tabs"
import { ScrollView } from "@opencode/ui/scroll-view"
import { IconButton } from "@/jitda/env/ui/icon-button"
import { showToast } from "@/shell/notifications/toast"
import { useComments } from "@/composer/comments"
import { useComposerState } from "@/composer/persistence"
import { useLanguage } from "@/runtime/i18n/language"
import { selectionFromLines, useFile, type FileSelection, type SelectedLineRange } from "@/workspaces/files/model"
import type { FileContent } from "@opencode/gui-extensions/sdk"
import { useExtensionHost } from "@/runtime/extension/host"
import { sidePanelController } from "./controller"
import { FileViewer, pickFileViewer, viewerBytes } from "./file-viewer"

export function FileCommentMenu(props: {
  moreLabel: string
  editLabel: string
  deleteLabel: string
  onEdit: VoidFunction
  onDelete: VoidFunction
}) {
  return (
    <div onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <Menu gutter={4} placement="bottom-end">
        <Menu.Trigger
          as={IconButton}
          icon="dot-grid"
          variant="ghost"
          size="small"
          class="size-6 rounded-md"
          aria-label={props.moreLabel}
        />
        <Menu.Portal>
          <Menu.Content>
            <Menu.Item onSelect={props.onEdit}>{props.editLabel}</Menu.Item>
            <Menu.Item onSelect={props.onDelete}>{props.deleteLabel}</Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
    </div>
  )
}

type ScrollPos = { x: number; y: number }

// 탭별 스크롤 위치. V1 은 세션 view 에 보관했다(새로고침 시 초기화되는 것까지 같다).
const scrolls = new Map<string, ScrollPos>()

export function createScrollSync(input: { tab: () => string }) {
  let scroll: HTMLDivElement | undefined
  let scrollFrame: number | undefined
  let restoreFrame: number | undefined
  let pending: ScrollPos | undefined
  let code: HTMLElement[] = []

  const getCode = () => {
    const el = scroll
    if (!el) return []

    const host = el.querySelector("diffs-container")
    if (!(host instanceof HTMLElement)) return []

    const root = host.shadowRoot
    if (!root) return []

    return Array.from(root.querySelectorAll("[data-code]")).filter(
      (node): node is HTMLElement => node instanceof HTMLElement && node.clientWidth > 0,
    )
  }

  const save = (next: ScrollPos) => {
    pending = next
    if (scrollFrame !== undefined) return

    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = undefined
      const out = pending
      pending = undefined
      if (!out) return
      scrolls.set(input.tab(), out)
    })
  }

  const onCodeScroll = (event: Event) => {
    const el = scroll
    if (!el) return
    const target = event.currentTarget
    if (!(target instanceof HTMLElement)) return
    save({ x: target.scrollLeft, y: el.scrollTop })
  }

  const sync = () => {
    const next = getCode()
    if (next.length === code.length && next.every((el, i) => el === code[i])) return
    for (const item of code) item.removeEventListener("scroll", onCodeScroll)
    code = next
    for (const item of code) item.addEventListener("scroll", onCodeScroll)
  }

  const restore = () => {
    const el = scroll
    if (!el) return
    const pos = scrolls.get(input.tab())
    if (!pos) return

    sync()

    if (code.length > 0) {
      for (const item of code) {
        if (item.scrollLeft !== pos.x) item.scrollLeft = pos.x
      }
    }

    if (el.scrollTop !== pos.y) el.scrollTop = pos.y
    if (code.length > 0) return
    if (el.scrollLeft !== pos.x) el.scrollLeft = pos.x
  }

  const queueRestore = () => {
    if (restoreFrame !== undefined) return
    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = undefined
      restore()
    })
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    if (code.length === 0) sync()
    save({ x: code[0]?.scrollLeft ?? event.currentTarget.scrollLeft, y: event.currentTarget.scrollTop })
  }

  const setViewport = (el: HTMLDivElement) => {
    scroll = el
    restore()
  }

  onCleanup(() => {
    for (const item of code) item.removeEventListener("scroll", onCodeScroll)
    if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame)
    if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame)
  })

  return { handleScroll, queueRestore, setViewport }
}

// 줄 코멘트를 컴포저 컨텍스트로 보낸다. 문서(doc) 컴포저가 자기 처리기를 등록했으면 그쪽으로 보낸다(V1 addLineContext).
export function createLineContext() {
  const comments = useComments()
  const composer = useComposerState()

  const add = (input: {
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
    origin: "review" | "file"
  }) => {
    const handler = sidePanelController.lineContext()
    if (handler) {
      handler({ file: input.file, selection: input.selection, comment: input.comment, preview: input.preview })
      return
    }
    const saved = comments.add({ file: input.file, selection: input.selection, comment: input.comment })
    composer.context.add({
      type: "file",
      path: input.file,
      selection: selectionFromLines(input.selection),
      comment: input.comment,
      commentID: saved.id,
      commentOrigin: input.origin,
      preview: input.preview,
    })
  }

  const update = (input: { id: string; file: string; comment: string; preview?: string }) => {
    comments.update(input.file, input.id, input.comment)
    composer.context.updateComment(
      input.id,
      input.preview ? { comment: input.comment, preview: input.preview } : { comment: input.comment },
    )
  }

  const remove = (input: { id: string; file: string }) => {
    comments.remove(input.file, input.id)
    composer.context.removeComment(input.id)
  }

  return { comments, add, update, remove }
}

export function FileTabContent(props: { tab: string; path: string; active: boolean }) {
  const file = useFile()
  const language = useLanguage()
  const fileComponent = useFileComponent()
  const host = useExtensionHost()
  const context = createLineContext()
  const comments = context.comments

  let find: FileSearchHandle | null = null

  const search = {
    register: (handle: FileSearchHandle | null) => {
      find = handle
    },
  }

  const path = () => props.path
  const state = createMemo(() => file.get(path()))
  const contents = createMemo(() => state()?.content?.content ?? "")
  const viewer = createMemo(() => {
    const current = state()
    if (!current?.loaded) return undefined
    return pickFileViewer(host.list(FileViewer), path(), current.content)
  })
  const cacheKey = createMemo(() => sampledChecksum(contents()))
  const selectedLines = createMemo<SelectedLineRange | null>(
    () => (file.selectedLines(path()) as SelectedLineRange | undefined) ?? null,
  )
  const scrollSync = createScrollSync({ tab: () => props.tab })

  const buildPreview = (filePath: string, selection: FileSelection) => {
    const source = filePath === path() ? contents() : file.get(filePath)?.content?.content
    if (!source) return undefined
    return previewSelectedLines(source, { start: selection.startLine, end: selection.endLine })
  }

  const fileComments = createMemo(() => comments.list(path()))
  const commentedLines = createMemo(() => fileComments().map((comment) => comment.selection))

  const [note, setNote] = createStore({
    openedComment: null as string | null,
    commenting: null as SelectedLineRange | null,
    selected: null as SelectedLineRange | null,
  })

  const syncSelected = (range: SelectedLineRange | null) => {
    file.setSelectedLines(path(), range ? cloneSelectedLineRange(range) : null)
  }

  const activeSelection = () => note.selected ?? selectedLines()

  const commentsUi = createLineCommentController({
    comments: fileComments,
    label: language.t("ui.lineComment.submit"),
    draftKey: () => path() ?? props.tab,
    state: {
      opened: () => note.openedComment,
      setOpened: (id) => setNote("openedComment", id),
      selected: () => note.selected,
      setSelected: (range) => setNote("selected", range),
      commenting: () => note.commenting,
      setCommenting: (range) => setNote("commenting", range),
      syncSelected,
      hoverSelected: syncSelected,
    },
    getHoverSelectedRange: activeSelection,
    cancelDraftOnCommentToggle: true,
    clearSelectionOnSelectionEndNull: true,
    onSubmit: ({ comment, selection }) => {
      context.add({
        file: path(),
        selection,
        comment,
        preview: buildPreview(path(), selectionFromLines(selection)),
        origin: "file",
      })
    },
    onUpdate: ({ id, comment, selection }) => {
      context.update({ id, file: path(), comment, preview: buildPreview(path(), selectionFromLines(selection)) })
    },
    onDelete: (comment) => context.remove({ id: comment.id, file: path() }),
    editSubmitLabel: language.t("common.save"),
    renderCommentActions: (_, controls) => (
      <FileCommentMenu
        moreLabel={language.t("common.moreOptions")}
        editLabel={language.t("common.edit")}
        deleteLabel={language.t("common.delete")}
        onEdit={controls.edit}
        onDelete={controls.remove}
      />
    ),
  })

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!props.active) return
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== "f") return

      event.preventDefault()
      event.stopPropagation()
      find?.focus()
    }

    window.addEventListener("keydown", onKeyDown, { capture: true })
    onCleanup(() => window.removeEventListener("keydown", onKeyDown, { capture: true }))
  })

  createEffect(on(path, () => commentsUi.note.reset(), { defer: true }))

  createEffect(() => {
    const focus = comments.focus()
    const p = path()
    if (!focus || focus.file !== p || !props.active) return

    const target = fileComments().find((comment) => comment.id === focus.id)
    if (!target) return

    commentsUi.note.openComment(target.id, target.selection, { cancelDraft: true })
    requestAnimationFrame(() => comments.clearFocus())
  })

  let prev = { loaded: false, ready: false, active: false }

  createEffect(() => {
    const loaded = !!state()?.loaded
    const ready = file.ready()
    const active = props.active
    const restore = (loaded && !prev.loaded) || (ready && !prev.ready) || (active && loaded && !prev.active)
    prev = { loaded, ready, active }
    if (!restore) return
    scrollSync.queueRestore()
  })

  const renderFile = (source: string) => (
    <div class="relative overflow-hidden pb-40">
      <Dynamic
        component={fileComponent}
        mode="text"
        file={{
          name: path() ?? "",
          contents: source,
          cacheKey: cacheKey(),
        }}
        enableLineSelection
        enableGutterUtility
        selectedLines={activeSelection()}
        commentedLines={commentedLines()}
        onRendered={() => scrollSync.queueRestore()}
        annotations={commentsUi.annotations()}
        renderAnnotation={commentsUi.renderAnnotation}
        renderGutterUtility={commentsUi.renderGutterUtility}
        onLineSelected={(range: SelectedLineRange | null) => commentsUi.onLineSelected(range)}
        onLineSelectionEnd={(range: SelectedLineRange | null) => commentsUi.onLineSelectionEnd(range)}
        search={search}
        class="select-text"
        media={{
          mode: "auto",
          path: path(),
          current: state()?.content,
          onLoad: scrollSync.queueRestore,
          onError: (args: { kind: string }) => {
            if (args.kind !== "svg") return
            showToast({ variant: "error", title: language.t("toast.file.loadFailed.title") })
          },
        }}
      />
    </div>
  )

  const scrollView = (reason?: string) => (
    <ScrollView class="h-full" viewportRef={scrollSync.setViewport} onScroll={scrollSync.handleScroll}>
      <Switch>
        <Match when={state()?.loaded}>
          <Show when={reason}>
            <div class="px-6 pt-6 text-center text-14-regular text-text-weak">{reason}</div>
          </Show>
          {renderFile(contents())}
        </Match>
        <Match when={state()?.loading}>
          <div class="px-6 py-4 text-text-weak">{language.t("common.loading")}...</div>
        </Match>
        <Match when={state()?.error}>{(err) => <div class="px-6 py-4 text-text-weak">{err()}</div>}</Match>
      </Switch>
    </ScrollView>
  )

  return (
    <Tabs.Content value={props.tab} class="relative h-full">
      <Show when={viewer()} keyed fallback={scrollView()}>
        {(item) => (
          <Show when={state()?.content} keyed>
            {(content) => <FileViewerStage viewer={item} path={path()} content={content} fallback={scrollView} />}
          </Show>
        )}
      </Show>
    </Tabs.Content>
  )
}

// upstream ArtifactViewer 와 같다. 뷰어가 거부하거나 실패한 파일은 이 탭의 바이너리 안내로 돌아간다.
function FileViewerStage(props: {
  viewer: FileViewer
  path: string
  content: FileContent
  fallback: (reason?: string) => JSX.Element
}) {
  const [failed, setFailed] = createSignal<{ reason?: string }>()
  const decoded = createMemo(() => {
    const bytes = viewerBytes(props.content)
    return { bytes, problem: props.viewer.problem?.(bytes) }
  })
  const rejected = () => decoded().problem ?? failed()?.reason

  return (
    <Show when={!decoded().problem && !failed()} fallback={props.fallback(rejected())}>
      <ErrorBoundary fallback={(_) => props.fallback()}>
        <div class="relative flex h-full min-h-0 flex-col">
          <Dynamic
            component={props.viewer.View}
            bytes={decoded().bytes}
            path={props.path}
            onDetails={() => {}}
            onError={(reason) => setFailed({ reason })}
          />
        </div>
      </ErrorBoundary>
    </Show>
  )
}
