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
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { deleteEnvKey, listEnvKeys, restartDevServer, saveEnvKeys } from "@/utils/server"
import {
  buildEnvPatch,
  envKeysChanged,
  focusMounted,
  formatSavedAt,
  type EnvErr,
  type EnvPatch,
  type EnvRow,
} from "./dialog-env-keys-form"

// 서버는 값 write-only. 목록은 이름·등록시각만. filled 줄은 시각 + [값 교체].
// 값 교체·등록된 줄 삭제는 로컬 표시만 바꾸고, 푸터 [저장]에서만 반영한다.
// 직접 추가(fresh) 줄 삭제는 목록에서 바로 제거한다.

type Row = EnvRow & { err?: EnvErr }

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
          filled: true,
          updated_at: entry.updated_at,
        })),
      )
      setLoadError(false)
    } catch {
      setLoadError(true)
    }
  }
  onMount(() => void refetch())

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
              <div class="rounded-md border border-border-weaker-base bg-background-base overflow-hidden">
                <For each={rows}>
                  {(row, i) => {
                    // For 콜백은 한 번만 돌아가므로, 분기는 JSX 안에서 store 필드를 읽어야 반응한다.
                    const input = () => (!row.filled || !!row.editing) && !row.drop
                    const pending = () => !row.filled && !row.editing && !row.drop
                    return (
                      <div
                        data-env-row={row.id}
                        class="flex items-center gap-2.5 px-3 py-2.5"
                        classList={{
                          "border-t border-border-weaker-base": i() > 0,
                          "bg-surface-warning-weak": pending(),
                          "opacity-60": !!row.drop,
                        }}
                      >
                        <Show
                          when={row.fresh && !row.drop}
                          fallback={
                            <span
                              class="basis-[40%] shrink-0 min-w-0 truncate font-mono text-13-medium text-text-strong"
                              classList={{ "line-through text-text-weaker": !!row.drop }}
                              title={row.name || undefined}
                            >
                              {row.name || "—"}
                            </span>
                          }
                        >
                          <div class="basis-[40%] shrink-0 min-w-0">
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
                            <div class="flex-1 min-w-0 flex items-center justify-end gap-2">
                              <span
                                class="min-w-0 inline-flex items-center gap-1.5 text-12-regular text-text-weaker truncate"
                                classList={{ "line-through": !!row.drop }}
                              >
                                <Icon name="clock" class="size-3 shrink-0" />
                                {formatSavedAt(row.updated_at, (key, vars) => language.t(key, vars))}
                              </span>
                              <Show when={!row.drop}>
                                <Button
                                  type="button"
                                  size="small"
                                  variant="secondary"
                                  class="shrink-0"
                                  onClick={() => setRows(i(), "editing", true)}
                                >
                                  {language.t("envKeys.replace")}
                                </Button>
                              </Show>
                            </div>
                          }
                        >
                          <div class="flex-1 min-w-0">
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
                              value={row.draft ?? ""}
                              onChange={(v) => setRows(i(), "draft", v)}
                              onBlur={() => {
                                // filled 줄은 포커스가 빠지면 「등록됨」으로 돌리고 초안은 남긴다.
                                // 같은 줄을 다시 누르면 계속 교체할 수 있다.
                                if (!row.filled) return
                                const id = row.id
                                setTimeout(() => {
                                  if (!rows[i()]?.editing) return
                                  const root = document.querySelector(`[data-env-row="${CSS.escape(id)}"]`)
                                  if (root?.contains(document.activeElement)) return
                                  stopEdit(i())
                                }, 0)
                              }}
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
                          variant="ghost"
                          class={
                            row.drop
                              ? "shrink-0"
                              : "text-text-diff-remove-base hover:text-text-diff-remove-base shrink-0"
                          }
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

        <div class="flex items-center justify-end gap-2.5 px-7 py-3.5 pb-5 w-full">
          <Show
            when={!loadError()}
            fallback={
              <Button type="button" size="normal" variant="secondary" onClick={() => dialog.close()}>
                {language.t("common.close")}
              </Button>
            }
          >
            <Button type="button" size="normal" variant="secondary" onClick={() => dialog.close()}>
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
