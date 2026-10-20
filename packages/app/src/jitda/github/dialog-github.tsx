import { useDialog } from "@opencode/ui/context/dialog"
import { TextField } from "@opencode/ui/text-field"
import { showToast } from "@opencode/ui/toast"
import { createMemo, Match, onCleanup, onMount, Show, Switch as Branch } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { getRelativeTime } from "@/shell/time"
import { useJitda } from "../context"
import { Button } from "../env/ui/button"
import { Dialog } from "../env/ui/dialog"
import { Icon } from "../env/ui/icon"

export type GitHubRepo = { owner: string; name: string; url: string; private?: boolean }
export type GitHubStatus = {
  enabled: boolean
  connectUrl?: string
  login?: string
  linkedBy?: string
  repo?: GitHubRepo
  push?: { sha: string; time: number; by?: string }
}

// createRepo 는 실패를 { error: { code } } 로 돌려준다(RPC 출력이 JSON 이어야 해서).
class GitHubError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export function githubCode(err: unknown) {
  if (typeof err !== "object" || err === null || !("code" in err)) return
  return typeof err.code === "string" ? err.code : undefined
}

const NAME = /^[A-Za-z0-9._-]{1,100}$/

const ERRORS = {
  disabled: "github.error.disabled",
  unlinked: "github.error.unlinked",
  norepo: "github.error.norepo",
  exists: "github.error.exists",
  forbidden: "github.error.forbidden",
  revoked: "github.error.revoked",
  missing: "github.error.missing",
  empty: "github.error.empty",
  remote: "github.error.remote",
} as const

export function DialogGitHub() {
  const dialog = useDialog()
  const language = useLanguage()
  const t = (key: string, params?: Record<string, string | number | boolean>) =>
    language.t(key as Parameters<typeof language.t>[0], params)
  const jitda = useJitda()
  const platform = usePlatform()
  const spectator = jitda.readonly()

  const [state, setState] = createStore<{
    status?: GitHubStatus
    failed: boolean
    busy: boolean
    waiting: boolean
    name: string
  }>({ failed: false, busy: false, waiting: false, name: "" })

  const fail = (err: unknown) => {
    const code = githubCode(err)
    const key = code && code in ERRORS ? ERRORS[code as keyof typeof ERRORS] : undefined
    showToast({ title: key ? t(key) : t("common.requestFailed") })
  }

  const refetch = async () => {
    await jitda.rpc.github.status({}, jitda.options()).then(
      (status) => setState({ status: status as GitHubStatus, failed: false }),
      () => setState("failed", true),
    )
  }
  onMount(() => void refetch())

  const back = () => {
    if (!state.waiting || document.visibilityState !== "visible") return
    setState("waiting", false)
    void refetch()
  }
  window.addEventListener("focus", back)
  document.addEventListener("visibilitychange", back)
  onCleanup(() => {
    window.removeEventListener("focus", back)
    document.removeEventListener("visibilitychange", back)
  })

  const connect = () => {
    const url = state.status?.connectUrl
    if (!url || spectator) return
    setState("waiting", true)
    window.open(url, "_blank", "noopener")
  }

  const run = async <T,>(fn: () => Promise<T>) => {
    setState("busy", true)
    const out = await fn().catch((err) => {
      fail(err)
      return undefined
    })
    setState("busy", false)
    return out
  }

  const nameError = createMemo(() => {
    const name = state.name.trim()
    if (!name || NAME.test(name)) return
    return t("github.repo.name.hint")
  })

  const create = async () => {
    if (spectator) return
    const status = await run(() =>
      jitda.rpc.github.createRepo({ name: state.name.trim() }, jitda.options()).then((out) => {
        const result = out as GitHubStatus | { error: { code: string } }
        if ("error" in result) throw new GitHubError(result.error.code)
        return result
      }),
    )
    if (status) setState("status", status)
  }

  const view = createMemo(() => {
    if (state.failed) return "failed"
    if (!state.status) return "loading"
    if (!state.status.login) return "unlinked"
    if (!state.status.repo) return "choose"
    return "push"
  })

  const ready = createMemo(() => NAME.test(state.name.trim()))

  const pushed = createMemo(() => {
    const last = state.status?.push
    if (!last) return t("github.push.never")
    const time = getRelativeTime(new Date(last.time).toISOString(), language.t)
    if (!last.by) return t("github.push.last", { time })
    return t("github.push.lastBy", { time, name: last.by })
  })

  return (
    <Dialog
      title={t("github.title")}
      description={t(
        view() === "push"
          ? "github.description.linked"
          : view() === "choose"
            ? "github.description.choose"
            : "github.description.unlinked",
      )}
      action={<span class="sr-only" />}
      transition
      fit
      class="github-dialog hazard-dialog"
    >
      <div class="flex flex-col w-full">
        <div class="flex flex-col gap-4 px-7 pt-[18px] pb-2 w-full">
          <Branch>
            <Match when={view() === "failed"}>
              <div class="flex flex-col items-center gap-2.5 rounded-md border border-border-weaker-base bg-background-base px-5 py-7 text-center">
                <span class="inline-flex size-10 items-center justify-center rounded-lg bg-surface-warning-weak text-text-diff-remove-base">
                  <Icon name="warning" class="size-5" />
                </span>
                <span class="text-13-medium text-text-strong">{t("github.error.load")}</span>
                <Button type="button" size="small" variant="secondary" icon="refresh" onClick={() => void refetch()}>
                  {t("envKeys.error.retry")}
                </Button>
              </div>
            </Match>

            <Match when={view() === "loading"}>
              <div class="github-panel text-12-regular text-text-weak">{t("common.loading")}</div>
            </Match>

            <Match when={view() === "unlinked"}>
              <ul class="github-panel github-notes">
                <li>{t("github.intro.team")}</li>
                <li>{t("github.intro.secret")}</li>
              </ul>
              <Show when={state.waiting}>
                <span class="github-hint">{t("github.waiting")}</span>
              </Show>
            </Match>

            <Match when={view() === "choose" || view() === "push"}>
              <div class="github-account">
                <Icon name="github" class="size-5 shrink-0" />
                <div class="flex min-w-0 flex-1 flex-col">
                  <span class="text-13-medium text-text-strong truncate">@{state.status?.login}</span>
                  <Show when={state.status?.linkedBy}>
                    <span class="text-12-regular text-text-weak truncate">
                      {t("github.account.by", { name: state.status?.linkedBy ?? "" })}
                    </span>
                  </Show>
                </div>
              </div>

              <Show when={view() === "choose"}>
                <TextField
                  class="font-mono"
                  label={t("github.repo.name.label")}
                  value={state.name}
                  onChange={(value) => setState("name", value)}
                  autocomplete="off"
                  disabled={spectator}
                  validationState={nameError() ? "invalid" : undefined}
                  error={nameError()}
                />
                <span class="github-hint">{t("github.repo.public.hint")}</span>
              </Show>

              <Show when={view() === "push"}>
                <div class="github-panel flex flex-col gap-1.5">
                  <Show when={state.status?.repo}>
                    {(repo) => (
                      <a
                        href={repo().url}
                        class="text-text-strong underline github-link truncate"
                        onClick={(event) => {
                          event.preventDefault()
                          platform.openExternal(repo().url)
                        }}
                      >
                        {repo().name}
                      </a>
                    )}
                  </Show>
                  <span class="text-12-regular text-text-weak">{pushed()}</span>
                </div>
              </Show>
            </Match>
          </Branch>

          <Show when={spectator}>
            <span class="github-hint">{t("github.readonly")}</span>
          </Show>
        </div>

        <div class="hazard-dialog-footer">
          <div class="flex-1" />
          <Button type="button" size="normal" variant="secondary" onClick={() => dialog.close()}>
            {t("common.close")}
          </Button>
          <Branch>
            <Match when={view() === "unlinked"}>
              <Button
                type="button"
                size="normal"
                variant="primary"
                icon="github"
                disabled={spectator || !state.status?.connectUrl}
                onClick={connect}
              >
                {t("github.connect")}
              </Button>
            </Match>
            <Match when={view() === "choose"}>
              <Button
                type="button"
                size="normal"
                variant="primary"
                disabled={spectator || state.busy || !ready()}
                onClick={() => void create()}
              >
                {t("github.repo.create")}
              </Button>
            </Match>
          </Branch>
        </div>
      </div>
    </Dialog>
  )
}
