import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { useMutation } from "@tanstack/solid-query"
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { readonlyViewer } from "@/context/parent-params"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { deleteEnvKey, listEnvKeys, restartDevServer, revealEnvKey, saveEnvKeys } from "@/utils/server"
import {
  buildEnvPatch,
  envKeysChanged,
  envKeysSummary,
  envRowStatus,
  focusMounted,
  type EnvErr,
  type EnvPatch,
  type EnvRow,
} from "./dialog-env-keys-form"

// 목록은 이름만 받는다. 등록된 줄은 잠금칩으로 두고, 칩을 눌러야 그 줄의 값을 한 건 받아와
// 입력칸에 펼친다 — 값 보기와 교체가 같은 동작이고, 포커스가 빠지면 다시 잠긴다.
// 값 교체·등록된 줄 삭제는 로컬 표시만 바꾸고, 푸터 [저장]에서만 반영한다.
// 직접 추가(fresh) 줄 삭제는 목록에서 바로 제거한다.

type Row = EnvRow & { err?: EnvErr; revealing?: boolean }

export function DialogEnvKeys() {
  const dialog = useDialog()
  const language = useLanguage()
  const server = useServer()
  const sdk = useSDK()
  const platform = usePlatform()

  const opts = () => {
    const conn = server.current
    if (!conn) return
    return { server: conn.http, directory: sdk.directory, fetch: platform.fetch }
  }

  const [rows, setRows] = createStore<Row[]>([])
  const [loadError, setLoadError] = createSignal(false)
  // 관전자는 남의 키를 열어 볼 이유가 없다. 칩이 값 보기 겸 교체 진입점이라 칩 자체를 잠근다.
  const spectator = readonlyViewer()
  let uid = 0

  const refetch = async () => {
    const o = opts()
    if (!o) return
    try {
      const keys = await listEnvKeys(o)
      setRows(
        keys.map((entry) => ({
          id: entry.name,
          name: entry.name,
          // 이름만 있고 값이 빈 키는 「값 필요」줄로 — 입력칸이 처음부터 열려 있다.
          filled: !entry.empty,
          updated_at: entry.updated_at,
        })),
      )
      setLoadError(false)
    } catch {
      setLoadError(true)
    }
  }
  onMount(() => void refetch())

  // 잠금칩 클릭 — 값을 받아와 입력칸으로 펼친다. 한 번 받아온 값은 다이얼로그가 사는 동안 재요청하지 않는다.
  const openValue = async (index: number) => {
    const row = rows[index]
    if (!row || spectator) return
    if (row.value !== undefined) {
      setRows(index, "editing", true)
      return
    }
    const o = opts()
    if (!o) return
    setRows(index, "revealing", true)
    try {
      const value = await revealEnvKey(o, row.name)
      setRows(index, "value", value)
      setRows(index, "editing", true)
    } catch {
      showToast({ title: language.t("common.requestFailed") })
    } finally {
      setRows(index, "revealing", false)
    }
  }

  const add = () => {
    const id = `new-${uid++}`
    setRows(produce((list) => list.push({ id, name: "", filled: false, fresh: true, draft: "" })))
  }

  const toggleDrop = (index: number) => {
    const row = rows[index]
    if (!row) return
    // 직접 추가 줄은 아직 서버에 없으니 바로 목록에서 뺀다. 등록된 줄만 삭제 예정(취소선) 처리.
    if (row.fresh) {
      setRows(produce((list) => {
        list.splice(index, 1)
      }))
      return
    }
    const next = !row.drop
    setRows(index, "drop", next)
    if (next) {
      setRows(index, "editing", false)
      setRows(index, "err", undefined)
    }
  }

  const stopEdit = (index: number) => {
    setRows(index, "editing", false)
    setRows(index, "err", undefined)
  }

  const validate = () => {
    const result = buildEnvPatch(rows, (key) => language.t(key))
    rows.forEach((row, index) => {
      setRows(index, "err", result.errs[row.id])
    })
    return result.patch
  }

  const saveMutation = useMutation(() => ({
    mutationFn: async (patch: EnvPatch) => {
      const o = opts()
      if (!o) throw new Error("no server connection")
      for (const name of patch.drops) {
        await deleteEnvKey(o, name)
      }
      if (Object.keys(patch.values).length > 0) {
        await saveEnvKeys(o, patch.values)
      }
      // 미리보기 재시작은 보장되지 않음 — 실제로 시작됐을 때만 토스트에 적는다.
      return restartDevServer(o).catch(() => undefined)
    },
    onSuccess: async (restart) => {
      const booted = restart?.status === "started" || restart?.status === "already_starting"
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("envKeys.toast.saved.title"),
        description: booted ? language.t("envKeys.toast.saved.description") : undefined,
      })
      await refetch()
      dialog.close()
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("common.requestFailed"), description: message })
    },
  }))

  const save = (e: SubmitEvent) => {
    e.preventDefault()
    if (saveMutation.isPending) return
    const patch = validate()
    if (!patch) return
    if (Object.keys(patch.values).length === 0 && patch.drops.length === 0) {
      dialog.close()
      return
    }
    saveMutation.mutate(patch)
  }

  const hasChanges = createMemo(() => envKeysChanged(rows))
  const empty = createMemo(() => rows.length === 0)

  // 시안 푸터: "저장하면 [교체 1건 · 삭제 1건] 반영돼요". 바뀐 게 없으면 줄 자체를 감춘다.
  const summaryText = createMemo(() => {
    const { replace, drop } = envKeysSummary(rows)
    const parts: string[] = []
    if (replace > 0) parts.push(language.t("envKeys.summary.replace", { count: replace }))
    if (drop > 0) parts.push(language.t("envKeys.summary.drop", { count: drop }))
    return parts.join(" · ")
  })

  return (
    <Dialog
      title={language.t("envKeys.title")}
      description={language.t("envKeys.description")}
      action={<span class="sr-only" />}
      transition
      fit
      class="env-keys-dialog"
    >
      <form onSubmit={save} class="env-keys-form flex flex-col w-full">
        <div class="flex flex-col gap-4 px-7 pt-[18px] pb-2 overflow-y-auto max-h-[56vh] w-full">
          <Show when={loadError()}>
            <div class="flex flex-col items-center gap-2.5 rounded-md border border-border-weaker-base bg-background-base px-5 py-7 text-center">
              <span class="inline-flex size-10 items-center justify-center rounded-lg bg-surface-warning-weak text-text-diff-remove-base">
                <Icon name="warning" class="size-5" />
              </span>
              <span class="text-13-medium text-text-strong">{language.t("envKeys.error.load")}</span>
              <span class="text-12-regular text-text-weak max-w-80 leading-relaxed">
                {language.t("envKeys.error.load.hint")}
              </span>
              <Button type="button" size="small" variant="secondary" icon="refresh" onClick={() => void refetch()}>
                {language.t("envKeys.error.retry")}
              </Button>
            </div>
          </Show>

          <Show when={!loadError()}>
            <Show
              when={!empty()}
              fallback={
                <div class="flex flex-col items-center gap-1 rounded-md border border-dashed border-border-weak-base bg-background-base px-4 py-6 text-center">
                  <span class="text-13-medium text-text-strong">{language.t("envKeys.empty.title")}</span>
                  <span class="text-12-regular text-text-weaker leading-relaxed">{language.t("envKeys.empty")}</span>
                </div>
              }
            >
              <div class="env-keys-list">
                <For each={rows}>
                  {(row, i) => {
                    // For 콜백은 한 번만 돌아가므로, 분기는 JSX 안에서 store 필드를 읽어야 반응한다.
                    const status = () => envRowStatus(row)
                    const input = () => {
                      const s = status()
                      return s === "fresh" || s === "editing" || s === "needsValue"
                    }
                    return (
                      <div
                        data-env-row={row.id}
                        data-status={status()}
                        class="env-keys-row"
                        onFocusOut={(e) => {
                          // 줄 밖으로 포커스가 나가면 다시 잠근다. TextField 의 onBlur 는 Kobalte Input
                          // 을 못 넘어와서 컨테이너의 focusout 으로 잡는다.
                          const current = rows[i()]
                          if (!current?.editing || !current.filled) return
                          // relatedTarget 으로 바로 판단하면 안 된다 — 포커스를 쥔 칩이 입력칸으로 교체되는
                          // 순간에도 relatedTarget 이 null 인 focusout 이 뜨고, 그걸 "밖으로 나갔다"로 읽으면
                          // 열자마자 도로 잠긴다. 다음 틱에 포커스가 실제로 어디 있는지 보고 정한다
                          // (입력칸 자동 포커스는 마이크로태스크라 이 시점엔 이미 끝나 있다).
                          const rowEl = e.currentTarget
                          setTimeout(() => {
                            const now = rows[i()]
                            if (!now?.editing || !now.filled) return
                            if (rowEl.contains(document.activeElement)) return
                            stopEdit(i())
                          }, 0)
                        }}
                      >
                        <Show
                          when={row.fresh && !row.drop}
                          fallback={
                            <span class="env-keys-name" title={row.name || undefined}>
                              {row.name || "—"}
                            </span>
                          }
                        >
                          <div class="env-keys-name">
                            <TextField
                              class="font-mono"
                              autofocus
                              ref={(el: HTMLInputElement) => {
                                if (el) focusMounted(el)
                              }}
                              label={language.t("envKeys.field.key.label")}
                              hideLabel
                              placeholder={language.t("envKeys.field.key.placeholder")}
                              value={row.name}
                              onChange={(v) => setRows(i(), "name", v)}
                              validationState={row.err?.key ? "invalid" : undefined}
                              error={row.err?.key}
                            />
                          </div>
                        </Show>

                        <Show
                          when={input()}
                          fallback={
                            <div class="env-keys-value">
                              <Show
                                when={status() !== "drop" && !spectator}
                                fallback={
                                  <span class="env-keys-chip">
                                    <Icon name={status() === "drop" ? "trash" : "lock"} class="size-3 shrink-0" />
                                    {language.t(
                                      status() === "drop" ? "envKeys.status.drop" : "envKeys.status.registered",
                                    )}
                                  </span>
                                }
                              >
                                <button
                                  type="button"
                                  class="env-keys-chip"
                                  disabled={saveMutation.isPending || !!row.revealing}
                                  onClick={() => void openValue(i())}
                                >
                                  <Icon
                                    name={status() === "replace" ? "refresh" : "lock"}
                                    class="size-3 shrink-0"
                                  />
                                  {language.t(
                                    status() === "replace" ? "envKeys.status.replace" : "envKeys.status.registered",
                                  )}
                                </button>
                              </Show>
                            </div>
                          }
                        >
                          <div class="env-keys-value">
                            <TextField
                              class="font-mono"
                              autofocus={!!row.editing}
                              ref={(el: HTMLInputElement) => {
                                // 값 교체로 막 열린 칸만 포커스. fresh 줄은 이름 칸이 포커스를 가져간다.
                                if (el && row.editing) focusMounted(el)
                              }}
                              label={language.t("envKeys.field.value.label")}
                              hideLabel
                              autocomplete="off"
                              placeholder={
                                row.filled
                                  ? language.t("envKeys.field.value.replacePlaceholder")
                                  : language.t("envKeys.field.value.placeholder")
                              }
                              value={row.draft ?? row.value ?? ""}
                              onChange={(v) => setRows(i(), "draft", v)}
                              onKeyDown={(e: KeyboardEvent) => {
                                if (e.key !== "Enter") return
                                e.preventDefault()
                                ;(e.target as HTMLElement | null)?.blur?.()
                              }}
                              validationState={row.err?.value ? "invalid" : undefined}
                              error={row.err?.value}
                            />
                          </div>
                        </Show>

                        <Button
                          type="button"
                          size="small"
                          variant="secondary"
                          class="env-keys-action shrink-0"
                          onClick={() => toggleDrop(i())}
                          disabled={saveMutation.isPending}
                        >
                          {row.drop ? language.t("envKeys.delete.undo") : language.t("envKeys.delete")}
                        </Button>
                      </div>
                    )
                  }}
                </For>
              </div>
            </Show>

            <Button type="button" size="small" variant="ghost" icon="plus-small" onClick={add} class="self-start">
              {language.t("envKeys.add")}
            </Button>
          </Show>
        </div>

        <div class="env-keys-footer">
          <Show when={!loadError() && summaryText()}>
            <span class="env-keys-summary">
              {language.t("envKeys.summary.prefix")} <b>{summaryText()}</b> {language.t("envKeys.summary.suffix")}
            </span>
          </Show>
          <div class="flex-1" />
          <Show
            when={!loadError()}
            fallback={
              <Button type="button" size="normal" variant="secondary" onClick={() => dialog.close()}>
                {language.t("common.close")}
              </Button>
            }
          >
            <Button
              type="button"
              size="normal"
              variant="secondary"
              disabled={saveMutation.isPending}
              onClick={() => dialog.close()}
            >
              {language.t("common.cancel")}
            </Button>
            <Button type="submit" size="normal" variant="primary" disabled={saveMutation.isPending || !hasChanges()}>
              {saveMutation.isPending ? language.t("common.saving") : language.t("common.save")}
            </Button>
          </Show>
        </div>
      </form>
    </Dialog>
  )
}
