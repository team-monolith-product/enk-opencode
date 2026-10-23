import { useFileComponent } from "@opencode/ui/context/file"
import { createLineCommentController } from "@opencode/session-ui/line-comment-annotations"
import { cloneSelectedLineRange, previewSelectedLines } from "@opencode/session-ui/pierre/selection-bridge"
import type { SelectedLineRange } from "@/workspaces/files/model"
import { normalize, text, type ViewDiff } from "@opencode/session-ui/session-diff"
import { mediaKindFromPath } from "@opencode/session-ui/pierre/media"
import { ScrollView } from "@opencode/ui/scroll-view"
import { Tabs } from "@opencode/ui/tabs"
import type { FileDiffInfo } from "@opencode/client/promise"
import { createEffect, createMemo, Match, on, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { Button } from "@/jitda/env/ui/button"
import { useLanguage } from "@/runtime/i18n/language"
import { useFile } from "@/workspaces/files/model"
import { createLineContext, createScrollSync, FileCommentMenu } from "./file-tabs"

const MAX_DIFF_CHANGED_LINES = 500

function selectionSide(range: SelectedLineRange) {
  return range.endSide ?? range.side ?? "additions"
}

function selectionPreview(diff: ViewDiff, range: SelectedLineRange) {
  const contents = text(diff, selectionSide(range))
  if (contents.length === 0) return undefined
  return previewSelectedLines(contents, range)
}

export function DiffTabContent(props: {
  tab: string
  path: string
  active: boolean
  diffs: readonly FileDiffInfo[]
  loaded: boolean
}) {
  const file = useFile()
  const language = useLanguage()
  const fileComponent = useFileComponent()
  const context = createLineContext()
  const comments = context.comments

  const path = () => props.path
  const item = createMemo(() => {
    const found = props.diffs.find((diff) => file.normalize(diff.file) === file.normalize(path()))
    if (!found) return
    return normalize(found)
  })

  const scrollSync = createScrollSync({ tab: () => props.tab })

  const fileComments = createMemo(() => comments.list(path()))
  const commentedLines = createMemo(() => fileComments().map((comment) => comment.selection))

  const [note, setNote] = createStore({
    openedComment: null as string | null,
    commenting: null as SelectedLineRange | null,
    selected: null as SelectedLineRange | null,
    force: false,
  })

  const syncSelected = (range: SelectedLineRange | null) => {
    file.setSelectedLines(path(), range ? cloneSelectedLineRange(range) : null)
  }

  const selectedLines = createMemo(
    () => note.selected ?? (file.selectedLines(path()) as SelectedLineRange | undefined) ?? null,
  )

  const buildPreview = (selection: SelectedLineRange) => {
    const diff = item()
    if (!diff) return
    return selectionPreview(diff, selection)
  }

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
    getHoverSelectedRange: selectedLines,
    getSide: selectionSide,
    clearSelectionOnSelectionEndNull: false,
    onSubmit: ({ comment, selection }) => {
      if (!item()) return
      context.add({ file: path(), selection, comment, preview: buildPreview(selection), origin: "review" })
    },
    onUpdate: ({ id, comment, selection }) => {
      context.update({ id, file: path(), comment, preview: buildPreview(selection) })
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

  const changedLines = () => (item()?.additions ?? 0) + (item()?.deletions ?? 0)
  const mediaKind = createMemo(() => mediaKindFromPath(path()))
  const tooLarge = createMemo(() => {
    if (note.force) return false
    if (mediaKind()) return false
    return changedLines() > MAX_DIFF_CHANGED_LINES
  })

  return (
    <Tabs.Content value={props.tab} class="relative h-full">
      <ScrollView class="h-full" viewportRef={scrollSync.setViewport} onScroll={scrollSync.handleScroll}>
        <Switch>
          <Match when={!path()}>
            <div class="px-6 py-4 text-text-weak">{language.t("session.files.selectToOpen")}</div>
          </Match>
          <Match when={!item()}>
            <div class="px-6 py-4 text-text-weak">
              {!props.loaded
                ? `${language.t("common.loading")}${language.t("common.loading.ellipsis")}`
                : language.t("session.review.noChanges")}
            </div>
          </Match>
          <Match when={item()}>
            {(diff) => (
              <div class="relative overflow-hidden px-3 pb-40">
                <Show when={tooLarge()}>
                  <div data-slot="session-review-large-diff" class="py-4">
                    <div data-slot="session-review-large-diff-title">
                      {language.t("ui.sessionReview.largeDiff.title")}
                    </div>
                    <div data-slot="session-review-large-diff-meta">
                      {language.t("ui.sessionReview.largeDiff.meta", {
                        limit: MAX_DIFF_CHANGED_LINES.toLocaleString(),
                        current: changedLines().toLocaleString(),
                      })}
                    </div>
                    <div data-slot="session-review-large-diff-actions" class="mt-3">
                      <Button size="normal" variant="secondary" onClick={() => setNote("force", true)}>
                        {language.t("ui.sessionReview.largeDiff.renderAnyway")}
                      </Button>
                    </div>
                  </div>
                </Show>
                <Show when={!tooLarge()}>
                  <Dynamic
                    component={fileComponent}
                    mode="diff"
                    diffStyle="split"
                    fileDiff={diff().fileDiff}
                    hunkSeparators={diff().fileDiff.isPartial ? "simple" : "line-info-basic"}
                    onRendered={() => scrollSync.queueRestore()}
                    enableLineSelection
                    enableGutterUtility
                    onLineSelected={commentsUi.onLineSelected}
                    onLineSelectionEnd={commentsUi.onLineSelectionEnd}
                    annotations={commentsUi.annotations()}
                    renderAnnotation={commentsUi.renderAnnotation}
                    renderGutterUtility={commentsUi.renderGutterUtility}
                    selectedLines={selectedLines()}
                    commentedLines={commentedLines()}
                    media={{
                      mode: "auto",
                      path: path(),
                      before: text(diff(), "deletions"),
                      after: text(diff(), "additions"),
                      deleted: diff().status === "deleted",
                    }}
                    class="select-text"
                  />
                </Show>
              </div>
            )}
          </Match>
        </Switch>
      </ScrollView>
    </Tabs.Content>
  )
}
