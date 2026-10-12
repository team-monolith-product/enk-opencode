import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { createMemo, For, Match, onMount, Show, Switch as Branch } from "solid-js"
import { createStore } from "solid-js/store"
import type { HistoryChange, HistoryStatus } from "@opencode-ai/sdk/v2/client"
import { SubmitRequestError } from "@/components/prompt-input/doc-submit"
import { useLanguage } from "@/context/language"
import { readonlyViewer } from "@/context/parent-params"
import { useSDK } from "@/context/sdk"
import { getRelativeTime } from "@/utils/time"
import { SessionVote } from "@/utils/session-vote"

const MAX_FILES = 30
const REFUSALS = ["closed", "busy", "missing"] as const

/** 서버가 되돌리기 투표를 거절한 이유. */
function refusal(err: unknown) {
  if (!(err instanceof SubmitRequestError)) return "failed"
  if (err.body?.name === "DocVoteConflictError") return "conflict"
  return REFUSALS.find((code) => code === err.body?.code) ?? "failed"
}

export function DialogHistory(props: { sessionID: string }) {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useSDK()
  const spectator = readonlyViewer()

  const [state, setState] = createStore<{
    status?: HistoryStatus
    failed: boolean
    selected?: string
    changes: Record<string, HistoryChange[] | "loading" | "failed">
  }>({ failed: false, changes: {} })

  const refetch = () =>
    sdk.client.history.list().then(
      (res) => setState({ status: res.data, failed: false }),
      () => setState("failed", true),
    )
  onMount(() => void refetch())

  const select = (sha: string) => {
    setState("selected", sha)
    if (state.changes[sha] && state.changes[sha] !== "failed") return
    setState("changes", sha, "loading")
    void sdk.client.history.changes({ sha }).then(
      (res) => setState("changes", sha, res.data ?? []),
      () => setState("changes", sha, "failed"),
    )
  }

  const current = createMemo(() => state.status?.entries[0]?.sha)
  const view = createMemo(() => {
    if (state.failed) return "failed"
    if (!state.status) return "loading"
    if (state.status.entries.length === 0) return "empty"
    return "list"
  })
  const ready = createMemo(
    () => !spectator && state.status?.open === true && !!state.selected && state.selected !== current(),
  )

  const restore = async () => {
    const sha = state.selected
    if (!sha || !ready()) return
    const vote = SessionVote.get(props.sessionID)
    dialog.close()
    try {
      if (!(await vote?.rollback(sha))) showToast({ title: language.t("history.error.unavailable") })
    } catch (err) {
      showToast({ title: language.t(`history.error.${refusal(err)}`) })
    }
  }

  const label = (status: HistoryChange["status"]) => language.t(`history.change.${status}`)

  return (
    <Dialog
      title={language.t("history.title")}
      description={language.t("history.description")}
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
                <span class="text-13-medium text-text-strong">{language.t("history.error.load")}</span>
                <Button type="button" size="small" variant="secondary" icon="refresh" onClick={() => void refetch()}>
                  {language.t("envKeys.error.retry")}
                </Button>
              </div>
            </Match>

            <Match when={view() === "loading"}>
              <div class="github-panel text-12-regular text-text-weak">{language.t("common.loading")}</div>
            </Match>

            <Match when={view() === "empty"}>
              <div class="github-panel text-12-regular text-text-weak">{language.t("history.empty")}</div>
            </Match>

            <Match when={view() === "list"}>
              <ul class="history-list" role="listbox" aria-label={language.t("history.title")}>
                <For each={state.status?.entries}>
                  {(entry) => (
                    <li>
                      <button
                        type="button"
                        role="option"
                        class="history-item"
                        aria-selected={state.selected === entry.sha}
                        data-selected={state.selected === entry.sha ? "" : undefined}
                        onClick={() => select(entry.sha)}
                      >
                        <span class="history-item-head">
                          <span class="history-subject">{entry.subject}</span>
                          <Show when={entry.sha === current()}>
                            <span class="history-badge" data-tone="now">
                              {language.t("history.current")}
                            </span>
                          </Show>
                          <Show when={entry.revert}>
                            <span class="history-badge">{language.t("history.reverted")}</span>
                          </Show>
                        </span>
                        <span class="history-time">
                          {getRelativeTime(new Date(entry.time).toISOString(), language.t)}
                        </span>
                        <Show when={state.selected === entry.sha}>
                          <Branch>
                            <Match when={state.changes[entry.sha] === "loading"}>
                              <span class="history-time">{language.t("common.loading")}</span>
                            </Match>
                            <Match when={state.changes[entry.sha] === "failed"}>
                              <span class="history-time">{language.t("history.error.changes")}</span>
                            </Match>
                            <Match when={Array.isArray(state.changes[entry.sha])}>
                              <HistoryFiles
                                list={state.changes[entry.sha] as HistoryChange[]}
                                label={label}
                                total={(count) => language.t("history.changes", { count })}
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
            <span class="github-hint">
              {spectator
                ? language.t("history.readonly")
                : state.status?.open
                  ? language.t("history.note")
                  : language.t("history.closed")}
            </span>
          </Show>
        </div>

        <div class="hazard-dialog-footer">
          <div class="flex-1" />
          <Button type="button" size="normal" variant="secondary" onClick={() => dialog.close()}>
            {language.t("common.close")}
          </Button>
          <Show when={!spectator && view() === "list"}>
            <Button type="button" size="normal" variant="primary" disabled={!ready()} onClick={() => void restore()}>
              {language.t("history.restore")}
            </Button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}

function HistoryFiles(props: {
  list: HistoryChange[]
  label: (status: HistoryChange["status"]) => string
  total: (count: number) => string
}) {
  return (
    <span class="history-files">
      <span>{props.total(props.list.length)}</span>
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
