import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { createEffect, createMemo, For, Match, onCleanup, onMount, Show, Switch as Branch } from "solid-js"
import { createStore } from "solid-js/store"
import { Link } from "@/components/link"
import { useLanguage } from "@/context/language"
import { readonlyViewer } from "@/context/parent-params"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { promptLocale } from "@/utils/prompt-locale"
import { getRelativeTime } from "@/utils/time"
import {
  createGitHubRepo,
  getGitHubRepositories,
  getGitHubStatus,
  githubCode,
  selectGitHubRepo,
  type GitHubRepo,
  type GitHubStatus,
} from "@/utils/server"

const NAME = /^[A-Za-z0-9._-]{1,100}$/
const NEW_REPOSITORY_URL = "https://github.com/new?name=jitda-project"

const ERRORS = {
  disabled: "github.error.disabled",
  unlinked: "github.error.unlinked",
  norepo: "github.error.norepo",
  exists: "github.error.exists",
  forbidden: "github.error.forbidden",
  revoked: "github.error.revoked",
  app: "github.error.app",
  missing: "github.error.missing",
  empty: "github.error.empty",
  remote: "github.error.remote",
} as const

export function DialogGitHub() {
  const dialog = useDialog()
  const language = useLanguage()
  const server = useServer()
  const sdk = useSDK()
  const platform = usePlatform()
  const spectator = readonlyViewer()

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
    name: string
    repos?: GitHubRepo[]
    reposFailed: boolean
    reposLoading: boolean
    picked?: string
  }>({ failed: false, busy: false, waiting: false, name: "", reposFailed: false, reposLoading: false })

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

  const loadRepos = async () => {
    const o = opts()
    if (!o || state.reposLoading) return
    setState({ reposLoading: true, reposFailed: false })
    await getGitHubRepositories(o).then(
      (repos) => setState({ repos, reposLoading: false }),
      () => setState({ reposFailed: true, reposLoading: false }),
    )
  }

  const back = () => {
    if (document.visibilityState !== "visible") return
    if (view() === "choose" && state.status?.app) void loadRepos()
    if (!state.waiting) return
    setState("waiting", false)
    void refetch()
  }
  window.addEventListener("focus", back)
  document.addEventListener("visibilitychange", back)
  onCleanup(() => {
    window.removeEventListener("focus", back)
    document.removeEventListener("visibilitychange", back)
  })

  const reloadRepos = () => {
    setState("picked", undefined)
    void loadRepos()
  }

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
    return language.t("github.repo.name.hint")
  })

  const create = async () => {
    const o = opts()
    if (!o || spectator) return
    const status = await run(() =>
      createGitHubRepo(o, { name: state.name.trim(), locale: promptLocale(language.locale()) }),
    )
    if (!status) return
    setState("status", status)
    const first = status.firstPush
    if (first) showToast({ title: language.t("github.firstPush.failed", { count: first.attempts }) })
  }

  const pick = async () => {
    const o = opts()
    const repo = state.repos?.find((item) => `${item.owner}/${item.name}` === state.picked)
    if (!o || !repo || spectator) return
    const status = await run(() =>
      selectGitHubRepo(o, { owner: repo.owner, name: repo.name, locale: promptLocale(language.locale()) }),
    )
    if (!status) return
    setState("status", status)
    const first = status.firstPush
    if (first) showToast({ title: language.t("github.firstPush.failed", { count: first.attempts }) })
  }

  const firstFailure = createMemo(() => {
    const first = state.status?.firstPush
    if (!first) return
    const code = first.code in ERRORS ? language.t(ERRORS[first.code as keyof typeof ERRORS]) : undefined
    return {
      attempts: first.attempts,
      reason: [code, first.reason === first.code ? undefined : first.reason].filter(Boolean).join(" · "),
    }
  })

  const view = createMemo(() => {
    if (state.failed) return "failed"
    if (!state.status) return "loading"
    if (!state.status.login) return "unlinked"
    if (!state.status.repo) return "choose"
    return "push"
  })

  const ready = createMemo(() => NAME.test(state.name.trim()))

  createEffect(() => {
    if (view() === "choose" && state.status?.app && !state.repos && !state.reposFailed) void loadRepos()
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
            ? state.status?.app
              ? "github.description.select"
              : "github.description.choose"
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

              <Show when={view() === "choose" && state.status?.app}>
                <Branch>
                  <Match when={state.reposFailed}>
                    <div class="github-panel flex flex-col items-start gap-2">
                      <span class="text-12-regular text-text-weak">{language.t("github.error.repos")}</span>
                      <Button type="button" size="small" variant="secondary" icon="refresh" onClick={reloadRepos}>
                        {language.t("envKeys.error.retry")}
                      </Button>
                    </div>
                  </Match>
                  <Match when={!state.repos}>
                    <div class="github-panel text-12-regular text-text-weak">{language.t("common.loading")}</div>
                  </Match>
                  <Match when={state.repos?.length === 0}>
                    <div class="github-panel text-12-regular text-text-weak">{language.t("github.repo.empty")}</div>
                  </Match>
                  <Match when={state.repos}>
                    <span class="github-hint">{language.t("github.repo.select.hint")}</span>
                    <div class="github-repos" role="radiogroup" aria-label={language.t("github.repo.select.title")}>
                      <For each={state.repos}>
                        {(repo) => {
                          const key = `${repo.owner}/${repo.name}`
                          return (
                            <button
                              type="button"
                              role="radio"
                              class="github-repo"
                              aria-checked={state.picked === key}
                              disabled={spectator || state.busy}
                              onClick={() => setState("picked", key)}
                            >
                              <span class="truncate font-mono">{key}</span>
                              <Show when={repo.private}>
                                <span class="github-badge">{language.t("github.repo.private")}</span>
                              </Show>
                            </button>
                          )
                        }}
                      </For>
                    </div>
                  </Match>
                </Branch>
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Link class="github-link text-12-regular" href={NEW_REPOSITORY_URL}>
                    {language.t("github.repo.new")}
                  </Link>
                  <button type="button" class="github-link text-12-regular" onClick={reloadRepos}>
                    {language.t("github.repo.reload")}
                  </button>
                </div>
                <span class="github-hint">{language.t("github.repo.new.hint")}</span>
              </Show>

              <Show when={view() === "choose" && !state.status?.app}>
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

              <Show when={view() === "push"}>
                <div class="github-panel flex flex-col gap-1.5">
                  <Show when={state.status?.repo}>
                    {(repo) => (
                      <Link class="github-link truncate" href={repo().url}>
                        {repo().name}
                      </Link>
                    )}
                  </Show>
                  <span class="text-12-regular text-text-weak">{pushed()}</span>
                </div>
                <Show when={firstFailure()}>
                  {(failure) => (
                    <div class="github-panel flex flex-col gap-1">
                      <span class="text-12-medium text-text-diff-remove-base">
                        {language.t("github.firstPush.failed", { count: failure().attempts })}
                      </span>
                      <Show when={failure().reason}>
                        <span class="text-12-regular text-text-weak break-all">
                          {language.t("github.firstPush.reason", { reason: failure().reason })}
                        </span>
                      </Show>
                      <span class="text-12-regular text-text-weak">{language.t("github.firstPush.retry")}</span>
                    </div>
                  )}
                </Show>
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
            <Match when={view() === "choose" && state.status?.app}>
              <Button
                type="button"
                size="normal"
                variant="primary"
                icon="github"
                disabled={spectator || state.busy || !state.picked}
                onClick={() => void pick()}
              >
                {language.t("github.repo.push")}
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
                {language.t("github.repo.create")}
              </Button>
            </Match>
          </Branch>
        </div>
      </div>
    </Dialog>
  )
}
