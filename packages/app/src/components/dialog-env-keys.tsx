import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { useMutation } from "@tanstack/solid-query"
import { batch, createResource, createSignal, For, Show } from "solid-js"
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

  const [existing, { refetch }] = createResource(
    async () => {
      const o = opts()
      if (!o) return []
      return listEnvKeys(o)
    },
    { initialValue: [] },
  )

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

  return (
    <Dialog title={language.t("envKeys.title")} transition>
      <div class="flex flex-col gap-6 px-2.5 pb-3 overflow-y-auto max-h-[60vh]">
        <form onSubmit={save} class="px-2.5 pb-6 flex flex-col gap-6">
          <p class="text-14-regular text-text-base">{language.t("envKeys.description")}</p>

          <Show when={existing().length > 0}>
            <div class="flex flex-col gap-3">
              <label class="text-12-medium text-text-weak">{language.t("envKeys.existing.label")}</label>
              <For each={existing()}>
                {(name) => (
                  <div class="flex gap-2 items-start">
                    <div class="flex-1">
                      <TextField label={name} hideLabel value={name} readOnly />
                    </div>
                    <div class="flex-1">
                      <TextField
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
                          class="mt-1.5"
                          onClick={() => requestDelete(name)}
                          aria-label={language.t("envKeys.delete")}
                        />
                      }
                    >
                      <Button
                        type="button"
                        size="small"
                        variant="secondary"
                        class="mt-1"
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
          </Show>

          <div class="flex flex-col gap-3">
            <label class="text-12-medium text-text-weak">{language.t("envKeys.new.label")}</label>
            <For each={rows}>
              {(row, i) => (
                <div class="flex gap-2 items-start">
                  <div class="flex-1">
                    <TextField
                      label={language.t("envKeys.field.key.label")}
                      hideLabel
                      placeholder={language.t("envKeys.field.key.placeholder")}
                      value={row.key}
                      onChange={(v) => setRow(i(), "key", v)}
                      validationState={row.err?.key ? "invalid" : undefined}
                      error={row.err?.key}
                    />
                  </div>
                  <div class="flex-1">
                    <TextField
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
                    class="mt-1.5"
                    onClick={() => removeRow(i())}
                    aria-label={language.t("envKeys.remove")}
                  />
                </div>
              )}
            </For>
            <Button type="button" size="small" variant="ghost" icon="plus-small" onClick={addRow} class="self-start">
              {language.t("envKeys.add")}
            </Button>
          </div>

          <Button
            class="w-auto self-start"
            type="submit"
            size="large"
            variant="primary"
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? language.t("common.saving") : language.t("common.submit")}
          </Button>
        </form>
      </div>
    </Dialog>
  )
}
