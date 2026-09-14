import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { createMemo, For, Match, onCleanup, onMount, Show, Switch as Branch } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { parentUser, readonlyViewer } from "@/context/parent-params"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { getRelativeTime } from "@/utils/time"
import {
  bindGitHubRepo,
  createGitHubRepo,
  getGitHubStatus,
  githubCode,
  listGitHubRepos,
  pushGitHub,
  type GitHubRepo,
  type GitHubStatus,
} from "@/utils/server"

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

const today = () => {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `jitda-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
}

export function DialogGitHub() {
  const dialog = useDialog()
  const language = useLanguage()
  const server = useServer()
  const sdk = useSDK()
  const platform = usePlatform()
  const spectator = readonlyViewer()
  const user = parentUser()
  const member = user ? { id: user.id, name: user.name } : undefined

  const opts = () => {
    const conn = server.current
    if (!conn) return
    return { server: conn.http, directory: sdk.directory, fetch: platform.fetch }
  }

  const [state, setState] = createStore<{
    status?: GitHubStatus
    failed: boolean
    busy: boolean
    waiting: boolean
    mode: "new" | "existing"
    name: string
    repos?: GitHubRepo[]
    pick?: GitHubRepo
    message: string
    choosing: boolean
  }>({ failed: false, busy: false, waiting: false, mode: "new", name: today(), message: "", choosing: false })

  const fail = (err: unknown) => {
    const code = githubCode(err)
    const key = code && code in ERRORS ? ERRORS[code as keyof typeof ERRORS] : undefined
    showToast({ title: key ? language.t(key) : language.t("common.requestFailed") })
  }

  const refetch = async () => {
    const o = opts()
    if (!o) return
    await getGitHubStatus(o).then(
      (status) => setState({ status, failed: false }),
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

  const browse = async (mode: "new" | "existing") => {
    setState("mode", mode)
    if (mode === "new" || state.repos?.length) return
    const o = opts()
    if (!o) return
    const repos = await run(() => listGitHubRepos(o))
    setState("repos", repos ?? [])
  }

  const nameError = createMemo(() => {
    const name = state.name.trim()
    if (!name || NAME.test(name)) return
    return language.t("github.repo.name.hint")
  })

  const choose = async () => {
    const o = opts()
    if (!o || spectator) return
    const pick = state.pick
    const status = await run(() => {
      if (state.mode === "existing" && pick) return bindGitHubRepo(o, { owner: pick.owner, name: pick.name })
      return createGitHubRepo(o, { name: state.name.trim() })
    })
    if (status) setState({ status, choosing: false })
  }

  const change = () => {
    if (spectator) return
    setState({ choosing: true, pick: undefined })
  }

  const push = async () => {
    const o = opts()
    if (!o || spectator) return
    const message = state.message.trim() || language.t("github.push.defaultMessage")
    const result = await run(() => pushGitHub(o, { message, member }))
    if (!result) return void refetch()
    setState("message", "")
    showToast({
      variant: result.sha ? "success" : "default",
      icon: result.sha ? "circle-check" : undefined,
      title: language.t(result.sha ? "github.push.done" : "github.push.unchanged"),
      description: result.skipped.length
        ? language.t("github.push.skipped", { files: result.skipped.join(", ") })
        : undefined,
      actions: result.sha
        ? [{ label: language.t("github.push.open"), onClick: () => window.open(result.url, "_blank", "noopener") }]
        : undefined,
    })
    void refetch()
  }

  const view = createMemo(() => {
    if (state.failed) return "failed"
    if (!state.status) return "loading"
    if (!state.status.login) return "unlinked"
    if (!state.status.repo || state.choosing) return "choose"
    return "push"
  })

  const ready = createMemo(() => {
    if (state.mode === "existing") return !!state.pick
    return NAME.test(state.name.trim())
  })

  const pushed = createMemo(() => {
    const last = state.status?.push
    if (!last) return language.t("github.push.never")
    const time = getRelativeTime(new Date(last.time).toISOString(), language.t)
    if (!last.by) return language.t("github.push.last", { time })
    return language.t("github.push.lastBy", { time, name: last.by })
  })

  return (
    <Dialog
      title={language.t("github.title")}
      description={language.t(
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
                <span class="text-13-medium text-text-strong">{language.t("github.error.load")}</span>
                <Button type="button" size="small" variant="secondary" icon="refresh" onClick={() => void refetch()}>
                  {language.t("envKeys.error.retry")}
                </Button>
              </div>
            </Match>

            <Match when={view() === "loading"}>
              <div class="github-panel text-12-regular text-text-weak">{language.t("common.loading")}</div>
            </Match>

            <Match when={view() === "unlinked"}>
              <ul class="github-panel github-notes">
                <li>{language.t("github.intro.team")}</li>
                <li>{language.t("github.intro.secret")}</li>
              </ul>
              <Show when={state.waiting}>
                <span class="github-hint">{language.t("github.waiting")}</span>
              </Show>
            </Match>

            <Match when={view() === "choose" || view() === "push"}>
              <div class="github-account">
                <Icon name="github" class="size-5 shrink-0" />
                <div class="flex min-w-0 flex-1 flex-col">
                  <span class="text-13-medium text-text-strong truncate">@{state.status?.login}</span>
                  <Show when={state.status?.linkedBy}>
                    <span class="text-12-regular text-text-weak truncate">
                      {language.t("github.account.by", { name: state.status?.linkedBy ?? "" })}
                    </span>
                  </Show>
                </div>
              </div>

              <Show when={view() === "choose"}>
                <div class="github-seg" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={state.mode === "new"}
                    disabled={spectator}
                    onClick={() => void browse("new")}
                  >
                    {language.t("github.repo.new")}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={state.mode === "existing"}
                    disabled={spectator}
                    onClick={() => void browse("existing")}
                  >
                    {language.t("github.repo.existing")}
                  </button>
                </div>
                <Show
                  when={state.mode === "new"}
                  fallback={
                    <div class="github-repos">
                      <Show
                        when={state.repos}
                        fallback={<span class="github-empty">{language.t("common.loading")}</span>}
                      >
                        <Show
                          when={state.repos?.length}
                          fallback={<span class="github-empty">{language.t("github.repo.empty")}</span>}
                        >
                          <For each={state.repos}>
                            {(repo) => (
                              <button
                                type="button"
                                class="github-repo"
                                aria-pressed={state.pick?.url === repo.url}
                                disabled={spectator}
                                onClick={() => setState("pick", repo)}
                              >
                                <span class="truncate">{repo.name}</span>
                                <span class="github-pill" data-private={!!repo.private}>
                                  {language.t(repo.private ? "github.repo.private.badge" : "github.repo.public.badge")}
                                </span>
                              </button>
                            )}
                          </For>
                        </Show>
                      </Show>
                    </div>
                  }
                >
                  <TextField
                    class="font-mono"
                    label={language.t("github.repo.name.label")}
                    value={state.name}
                    onChange={(value) => setState("name", value)}
                    autocomplete="off"
                    disabled={spectator}
                    validationState={nameError() ? "invalid" : undefined}
                    error={nameError()}
                  />
                  <span class="github-hint">{language.t("github.repo.public.hint")}</span>
                </Show>
              </Show>

              <Show when={view() === "push"}>
                <div class="github-panel flex flex-col gap-1.5">
                  <div class="flex items-center gap-2 min-w-0">
                    <a
                      class="github-link truncate"
                      href={state.status?.repo?.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {state.status?.repo?.owner}/{state.status?.repo?.name}
                    </a>
                    <span class="github-pill" data-private={!!state.status?.repo?.private}>
                      {language.t(
                        state.status?.repo?.private ? "github.repo.private.badge" : "github.repo.public.badge",
                      )}
                    </span>
                    <div class="flex-1" />
                    <Show when={!spectator}>
                      <Button
                        type="button"
                        size="small"
                        variant="ghost"
                        disabled={state.busy}
                        onClick={() => void change()}
                      >
                        {language.t("github.repo.change")}
                      </Button>
                    </Show>
                  </div>
                  <span class="text-12-regular text-text-weak">{pushed()}</span>
                </div>
                <TextField
                  label={language.t("github.push.message.label")}
                  placeholder={language.t("github.push.message.placeholder")}
                  value={state.message}
                  onChange={(value) => setState("message", value)}
                  autocomplete="off"
                  maxLength={500}
                  disabled={spectator}
                />
              </Show>
            </Match>
          </Branch>

          <Show when={spectator}>
            <span class="github-hint">{language.t("github.readonly")}</span>
          </Show>
        </div>

        <div class="hazard-dialog-footer">
          <div class="flex-1" />
          <Button type="button" size="normal" variant="secondary" onClick={() => dialog.close()}>
            {language.t("common.close")}
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
                {language.t("github.connect")}
              </Button>
            </Match>
            <Match when={view() === "choose"}>
              <Show when={state.status?.repo}>
                <Button type="button" size="normal" variant="secondary" onClick={() => setState("choosing", false)}>
                  {language.t("common.cancel")}
                </Button>
              </Show>
              <Button
                type="button"
                size="normal"
                variant="primary"
                disabled={spectator || state.busy || !ready()}
                onClick={() => void choose()}
              >
                {language.t(state.mode === "new" ? "github.repo.create" : "github.repo.use")}
              </Button>
            </Match>
            <Match when={view() === "push"}>
              <Button
                type="button"
                size="normal"
                variant="primary"
                icon="cloud-upload"
                disabled={spectator || state.busy}
                onClick={() => void push()}
              >
                {state.busy ? language.t("github.push.pending") : language.t("github.push.submit")}
              </Button>
            </Match>
          </Branch>
        </div>
      </div>
    </Dialog>
  )
}
