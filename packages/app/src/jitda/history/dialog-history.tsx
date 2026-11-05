import { useDialog } from "@opencode/ui/context/dialog"
import { showToast } from "@opencode/ui/toast"
import { createMemo, For, Match, onMount, Show, Switch as Branch } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { getRelativeTime } from "@/shell/time"
import { promptDocBridge } from "../composer/bridge"
import { SubmitRequestError } from "../composer/doc-submit"
import { useJitda } from "../context"
import { Button } from "../env/ui/button"
import { Dialog } from "../env/ui/dialog"
import { Icon } from "../env/ui/icon"
import { undoneVersions } from "./undone"
import "./dialog-history.css"

export type HistoryEntry = { sha: string; time: number; subject: string; revert?: string }
export type HistoryChange = { status: "A" | "M" | "D" | "L"; file: string }
export type HistoryStatus = { enabled: boolean; entries: HistoryEntry[] }

const MAX_FILES = 30
// 서버가 되돌리기를 거절하는 사유(서버 HistorySync.REFUSALS 와 같은 이름).
const REFUSALS = ["busy", "missing", "staged"] as const

/** 서버가 되돌리기 투표를 거절한 이유. */
function refusal(err: unknown) {
  if (!(err instanceof SubmitRequestError)) return "failed"
  if (err.body?.name === "DocVoteConflictError") return "conflict"
  return REFUSALS.find((code) => code === err.body?.code) ?? "failed"
}

export function DialogHistory(props: { sessionID: string }) {
  const dialog = useDialog()
  const language = useLanguage()
  const t = (key: string, params?: Record<string, string | number | boolean>) =>
    language.t(key as Parameters<typeof language.t>[0], params)
  const jitda = useJitda()
  const spectator = jitda.readonly()

  const [state, setState] = createStore<{
    status?: HistoryStatus
    failed: boolean
    selected?: string
    changes: Record<string, HistoryChange[] | "loading" | "failed">
  }>({ failed: false, changes: {} })

  const refetch = () =>
    jitda.rpc.history.list({}, jitda.options()).then(
      (value: unknown) => setState({ status: value as HistoryStatus, failed: false }),
      () => setState("failed", true),
    )
  onMount(() => void refetch())

  const select = (sha: string) => {
    setState("selected", sha)
    if (state.changes[sha] && state.changes[sha] !== "failed") return
    setState("changes", sha, "loading")
    void jitda.rpc.history.changes({ sha }, jitda.options()).then(
      (value: unknown) => setState("changes", sha, (value as { changes?: HistoryChange[] }).changes ?? "failed"),
      () => setState("changes", sha, "failed"),
    )
  }

  const current = createMemo(() => state.status?.entries[0]?.sha)
  const undone = createMemo(() => undoneVersions(state.status?.entries ?? []))
  const view = createMemo(() => {
    if (state.failed) return "failed"
    if (!state.status) return "loading"
    if (state.status.entries.length === 0) return "empty"
    return "list"
  })
  const ready = createMemo(() => !spectator && !!state.selected && state.selected !== current())

  const restore = async () => {
    const sha = state.selected
    if (!sha || !ready()) return
    const vote = promptDocBridge.rollback(props.sessionID)
    dialog.close()
    try {
      if (!(await vote?.(sha))) showToast({ title: t("history.error.unavailable") })
    } catch (err) {
      showToast({ title: t(`history.error.${refusal(err)}`) })
    }
  }

  const label = (status: HistoryChange["status"]) => t(`history.change.${status}`)

  return (
    <Dialog
      title={t("history.title")}
      description={t("history.description")}
      action={<span class="sr-only" />}
      transition
      fit
      class="history-dialog hazard-dialog"
    >
      <div class="flex flex-col w-full">
        <div class="flex flex-col gap-3 px-7 pt-[18px] pb-2 w-full">
          <Branch>
            <Match when={view() === "failed"}>
              <div class="flex flex-col items-center gap-2.5 rounded-md border border-border-weaker-base bg-background-base px-5 py-7 text-center">
                <span class="inline-flex size-10 items-center justify-center rounded-lg bg-surface-warning-weak text-text-diff-remove-base">
                  <Icon name="warning" class="size-5" />
                </span>
                <span class="text-13-medium text-text-strong">{t("history.error.load")}</span>
                <Button type="button" size="small" variant="secondary" icon="refresh" onClick={() => void refetch()}>
                  {t("envKeys.error.retry")}
                </Button>
              </div>
            </Match>

            <Match when={view() === "loading"}>
              <div class="history-panel text-12-regular text-text-weak">{t("common.loading")}</div>
            </Match>

            <Match when={view() === "empty"}>
              <div class="history-panel text-12-regular text-text-weak">{t("history.empty")}</div>
            </Match>

            <Match when={view() === "list"}>
              <ul class="history-list" role="listbox" aria-label={t("history.title")}>
                <For each={state.status?.entries}>
                  {(entry) => (
                    <li>
                      <button
                        type="button"
                        role="option"
                        class="history-item"
                        aria-selected={state.selected === entry.sha}
                        data-selected={state.selected === entry.sha ? "" : undefined}
                        data-undone={undone().has(entry.sha) ? "" : undefined}
                        onClick={() => select(entry.sha)}
                      >
                        <span class="history-item-head">
                          <span class="history-subject">{entry.subject}</span>
                          <Show when={entry.sha === current()}>
                            <span class="history-badge" data-tone="now">
                              {t("history.current")}
                            </span>
                          </Show>
                          <Show when={entry.revert}>
                            <span class="history-badge">{t("history.reverted")}</span>
                          </Show>
                          <Show when={undone().has(entry.sha)}>
                            <span class="history-badge" data-tone="undone">
                              {t("history.undone")}
                            </span>
                          </Show>
                        </span>
                        <span class="history-time">
                          {getRelativeTime(new Date(entry.time).toISOString(), language.t)}
                        </span>
                        <Show when={state.selected === entry.sha}>
                          <Branch>
                            <Match when={state.changes[entry.sha] === "loading"}>
                              <span class="history-time">{t("common.loading")}</span>
                            </Match>
                            <Match when={state.changes[entry.sha] === "failed"}>
                              <span class="history-time">{t("history.error.changes")}</span>
                            </Match>
                            <Match when={Array.isArray(state.changes[entry.sha])}>
                              <HistoryFiles
                                list={(state.changes[entry.sha] as HistoryChange[]).filter(visible)}
                                hiddenOnly={
                                  (state.changes[entry.sha] as HistoryChange[]).length > 0 &&
                                  (state.changes[entry.sha] as HistoryChange[]).every((change) => !visible(change))
                                    ? t("history.changes.hidden")
                                    : undefined
                                }
                                label={label}
                                total={(count) => t("history.changes", { count })}
                              />
                            </Match>
                          </Branch>
                        </Show>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Match>
          </Branch>

          <Show when={view() === "list"}>
            <span class="history-hint">{spectator ? t("history.readonly") : t("history.note")}</span>
          </Show>
        </div>

        <div class="hazard-dialog-footer">
          <div class="flex-1" />
          <Button type="button" size="normal" variant="secondary" onClick={() => dialog.close()}>
            {t("common.close")}
          </Button>
          <Show when={!spectator && view() === "list"}>
            <Button type="button" size="normal" variant="primary" disabled={!ready()} onClick={() => void restore()}>
              {t("history.restore")}
            </Button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}

const visible = (change: HistoryChange) => !change.file.split("/").some((part) => part.startsWith("."))

function HistoryFiles(props: {
  list: HistoryChange[]
  hiddenOnly: string | undefined
  label: (status: HistoryChange["status"]) => string
  total: (count: number) => string
}) {
  return (
    <span class="history-files">
      <span>{props.hiddenOnly ?? props.total(props.list.length)}</span>
      <For each={props.list.slice(0, MAX_FILES)}>
        {(change) => (
          <span class="history-file">
            <span class="history-file-status" data-status={change.status}>
              {props.label(change.status)}
            </span>
            <span class="truncate">{change.file}</span>
          </span>
        )}
      </For>
      <Show when={props.list.length > MAX_FILES}>
        <span>… +{props.list.length - MAX_FILES}</span>
      </Show>
    </span>
  )
}
