import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { useMutation } from "@tanstack/solid-query"
import { batch, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { deleteEnvKey, listEnvKeys, saveEnvKeys } from "@/utils/server"

// 프로젝트 루트 .env 의 API 키 관리 다이얼로그. 서버는 키 이름만 반환하는 write-only 설계라
// 기존 키의 값은 화면에 절대 나타나지 않는다 — 빈 입력이면 유지, 입력하면 덮어쓰기.
const KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/

type NewRow = { key: string; value: string; err?: { key?: string; value?: string } }

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

  // createResource 를 쓰지 않는다: 구버전 서버(라우트 없음)에서 404 가 나면 리소스 읽기가
  // 렌더 중 throw 해 앱 최상위 ErrorBoundary 로 전파된다(전체 화면이 에러 페이지로 교체).
  // 실패는 다이얼로그 안의 안내 문구로만 처리한다.
  const [existing, setExisting] = createSignal<string[]>([])
  const [loadError, setLoadError] = createSignal(false)
  const refetch = async () => {
    const o = opts()
    if (!o) return
    try {
      setExisting(await listEnvKeys(o))
      setLoadError(false)
    } catch {
      setLoadError(true)
    }
  }
  onMount(() => void refetch())

  // 기존 키 덮어쓰기 입력값 (키 이름 → 새 값). 빈 문자열이면 변경 없음.
  const [updates, setUpdates] = createStore<Record<string, string>>({})
  const [rows, setRows] = createStore<NewRow[]>([])
  const [confirmDelete, setConfirmDelete] = createSignal<string>()

  const addRow = () => {
    setRows(produce((list) => list.push({ key: "", value: "" })))
  }

  const removeRow = (index: number) => {
    setRows(produce((list) => list.splice(index, 1)))
  }

  const setRow = (index: number, field: "key" | "value", value: string) => {
    batch(() => {
      setRows(index, field, value)
      setRows(index, "err", (err) => ({ ...err, [field]: undefined }))
    })
  }

  const validate = () => {
    const values: Record<string, string> = {}
    for (const [key, value] of Object.entries(updates)) {
      if (value) values[key] = value
    }
    let ok = true
    const seen = new Set(existing())
    rows.forEach((row, index) => {
      const key = row.key.trim()
      const err: NewRow["err"] = {}
      if (!KEY_REGEX.test(key)) err.key = language.t("envKeys.error.invalidKey")
      else if (seen.has(key)) err.key = language.t("envKeys.error.duplicate")
      if (!row.value) err.value = language.t("envKeys.error.valueRequired")
      if (err.key || err.value) {
        ok = false
        setRows(index, "err", err)
        return
      }
      seen.add(key)
      values[key] = row.value
    })
    if (!ok) return
    return values
  }

  const saveMutation = useMutation(() => ({
    mutationFn: async (values: Record<string, string>) => {
      const o = opts()
      if (!o) throw new Error("no server connection")
      await saveEnvKeys(o, values)
    },
    onSuccess: () => {
      batch(() => {
        setRows(produce((list) => list.splice(0, list.length)))
        for (const key of Object.keys(updates)) setUpdates(key, "")
      })
      void refetch()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("envKeys.toast.saved.title"),
        description: language.t("envKeys.toast.saved.description"),
      })
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("common.requestFailed"), description: message })
    },
  }))

  const deleteMutation = useMutation(() => ({
    mutationFn: async (name: string) => {
      const o = opts()
      if (!o) throw new Error("no server connection")
      await deleteEnvKey(o, name)
    },
    onSuccess: (_, name) => {
      setConfirmDelete(undefined)
      setUpdates(name, "")
      void refetch()
    },
    onError: (err) => {
      setConfirmDelete(undefined)
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("common.requestFailed"), description: message })
    },
  }))

  const requestDelete = (name: string) => {
    if (confirmDelete() !== name) {
      setConfirmDelete(name)
      return
    }
    if (deleteMutation.isPending) return
    deleteMutation.mutate(name)
  }

  const save = (e: SubmitEvent) => {
    e.preventDefault()
    if (saveMutation.isPending) return
    const values = validate()
    if (!values) return
    if (Object.keys(values).length === 0) {
      dialog.close()
      return
    }
    saveMutation.mutate(values)
  }

  // 저장 버튼 활성 조건: 새 행이 있거나 기존 값 덮어쓰기 입력이 하나라도 있을 때.
  const hasChanges = createMemo(() => rows.length > 0 || Object.values(updates).some((v) => v.length > 0))
  const isEmpty = createMemo(() => existing().length === 0 && rows.length === 0)

  return (
    <Dialog title={language.t("envKeys.title")} transition fit>
      <form onSubmit={save} class="flex flex-col">
        <div class="flex flex-col gap-5 px-5 pb-5 overflow-y-auto max-h-[56vh]">
          {/* 안내 — .env 시그니처 칩 + 설명. */}
          <div class="flex flex-col gap-2">
            <span class="font-mono text-11-medium text-text-weak px-1.5 py-0.5 self-start rounded bg-surface-inset-base border border-border-weaker-base">
              .env
            </span>
            <p class="text-13-regular text-text-weak leading-relaxed">{language.t("envKeys.description")}</p>
          </div>

          <Show when={loadError()}>
            <div
              class="flex items-start gap-2 rounded-md px-3 py-2 text-12-regular bg-surface-critical-weak"
              style={{ color: "var(--text-on-critical-base)" }}
            >
              {language.t("envKeys.error.load")}
            </div>
          </Show>

          {/* 저장된 변수 — inset 그룹으로 하나의 목록처럼 읽히게. 이름은 monospace, 값만 편집. */}
          <Show when={existing().length > 0}>
            <section class="flex flex-col gap-2">
              <div class="flex items-center justify-between px-0.5">
                <span class="text-11-medium text-text-weaker">{language.t("envKeys.existing.label")}</span>
                <span class="text-11-regular text-text-weaker tabular-nums">{existing().length}</span>
              </div>
              <div class="rounded-md border border-border-weaker-base bg-surface-inset-base overflow-hidden">
                <For each={existing()}>
                  {(name, i) => (
                    <div
                      class="flex items-center gap-2 h-11 pl-3 pr-2"
                      classList={{ "border-t border-border-weaker-base": i() > 0 }}
                    >
                      <span class="font-mono text-13-medium text-text-strong truncate min-w-0 basis-[38%]" title={name}>
                        {name}
                      </span>
                      <span class="font-mono text-13-regular text-text-weaker shrink-0">=</span>
                      <div class="flex-1 min-w-0">
                        <TextField
                          class="font-mono"
                          variant="ghost"
                          label={language.t("envKeys.field.value.label")}
                          hideLabel
                          type="password"
                          autocomplete="off"
                          placeholder={language.t("envKeys.existing.placeholder")}
                          value={updates[name] ?? ""}
                          onChange={(v) => setUpdates(name, v)}
                        />
                      </div>
                      <Show
                        when={confirmDelete() === name}
                        fallback={
                          <IconButton
                            type="button"
                            icon="trash"
                            variant="ghost"
                            onClick={() => requestDelete(name)}
                            aria-label={language.t("envKeys.delete")}
                          />
                        }
                      >
                        <Button
                          type="button"
                          size="small"
                          variant="secondary"
                          onClick={() => requestDelete(name)}
                          onBlur={() => setConfirmDelete(undefined)}
                          disabled={deleteMutation.isPending}
                        >
                          {language.t("envKeys.delete.confirm")}
                        </Button>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </section>
          </Show>

          {/* 새 변수 — 편집 영역(focal). 이름·값 모두 입력, 사이에 = 글리프로 dotenv 라인처럼. */}
          <section class="flex flex-col gap-2">
            <Show when={!isEmpty()}>
              <span class="text-11-medium text-text-weaker px-0.5">{language.t("envKeys.new.label")}</span>
            </Show>
            <Show when={isEmpty()}>
              <div class="flex flex-col items-center gap-1.5 rounded-md border border-dashed border-border-weak-base py-7 text-center">
                <Icon name="code-lines" class="size-5 text-icon-base opacity-60" />
                <span class="text-12-regular text-text-weak">{language.t("envKeys.empty")}</span>
              </div>
            </Show>
            <For each={rows}>
              {(row, i) => (
                <div class="flex items-start gap-2">
                  <div class="basis-[38%] shrink-0">
                    <TextField
                      class="font-mono"
                      autofocus
                      label={language.t("envKeys.field.key.label")}
                      hideLabel
                      placeholder={language.t("envKeys.field.key.placeholder")}
                      value={row.key}
                      onChange={(v) => setRow(i(), "key", v)}
                      validationState={row.err?.key ? "invalid" : undefined}
                      error={row.err?.key}
                    />
                  </div>
                  <span class="font-mono text-13-regular text-text-weaker pt-2 shrink-0">=</span>
                  <div class="flex-1 min-w-0">
                    <TextField
                      class="font-mono"
                      label={language.t("envKeys.field.value.label")}
                      hideLabel
                      type="password"
                      autocomplete="off"
                      placeholder={language.t("envKeys.field.value.placeholder")}
                      value={row.value}
                      onChange={(v) => setRow(i(), "value", v)}
                      validationState={row.err?.value ? "invalid" : undefined}
                      error={row.err?.value}
                    />
                  </div>
                  <IconButton
                    type="button"
                    icon="trash"
                    variant="ghost"
                    class="mt-0.5 shrink-0"
                    onClick={() => removeRow(i())}
                    aria-label={language.t("envKeys.remove")}
                  />
                </div>
              )}
            </For>
            <Button type="button" size="small" variant="ghost" icon="plus-small" onClick={addRow} class="self-start">
              {language.t("envKeys.add")}
            </Button>
          </section>
        </div>

        {/* 커밋 — sticky 푸터, 주액션 우측 정렬. */}
        <div class="flex items-center justify-end gap-2 px-5 py-3 border-t border-border-weaker-base">
          <Button type="button" size="normal" variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" size="normal" variant="primary" disabled={saveMutation.isPending || !hasChanges()}>
            {saveMutation.isPending ? language.t("common.saving") : language.t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
