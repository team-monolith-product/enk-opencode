import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { showToast } from "@opencode-ai/ui/toast"
import { createMemo, Match, onCleanup, onMount, Show, Switch as Branch } from "solid-js"
import { createStore } from "solid-js/store"
import { Link } from "@/components/link"
import { useLanguage } from "@/context/language"
import { readonlyViewer } from "@/context/parent-params"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { getRelativeTime } from "@/utils/time"
import { createVercelProject, getVercelStatus, githubCode, type VercelStatus } from "@/utils/server"

const APP = "https://github.com/apps/vercel"

const ERRORS = {
  disabled: "vercel.error.disabled",
  unlinked: "vercel.error.unlinked",
  norepo: "vercel.error.norepo",
  repo: "vercel.error.repo",
  revoked: "vercel.error.revoked",
  missing: "vercel.error.remote",
  remote: "vercel.error.remote",
} as const

const STATES = {
  READY: "vercel.state.ready",
  ERROR: "vercel.state.error",
  CANCELED: "vercel.state.canceled",
  BLOCKED: "vercel.state.blocked",
} as const

export function VercelPanel() {
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
    status?: VercelStatus
    failed: boolean
    busy: boolean
    waiting: boolean
    repo: boolean
  }>({ failed: false, busy: false, waiting: false, repo: false })

  const refetch = async () => {
    const o = opts()
    if (!o) return
    await getVercelStatus(o).then(
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

  const create = async () => {
    const o = opts()
    if (!o || spectator) return
    setState({ busy: true, repo: false })
    const status = await createVercelProject(o).catch((err) => {
      const code = githubCode(err)
      const key = code && code in ERRORS ? ERRORS[code as keyof typeof ERRORS] : undefined
      showToast({ title: key ? language.t(key) : language.t("common.requestFailed") })
      setState("repo", code === "repo")
      return undefined
    })
    setState("busy", false)
    if (status) setState("status", status)
  }

  const view = createMemo(() => {
    if (state.failed) return "failed"
    if (!state.status) return "loading"
    if (!state.status.enabled) return "off"
    if (!state.status.username) return "unlinked"
    if (!state.status.project) return "ready"
    return "live"
  })

  const site = createMemo(() => state.status?.project?.url ?? state.status?.deployment?.url)

  const deployed = createMemo(() => {
    const last = state.status?.deployment
    if (!last) return language.t("vercel.state.none")
    const time = getRelativeTime(new Date(last.time).toISOString(), language.t)
    const key = last.state in STATES ? STATES[last.state as keyof typeof STATES] : "vercel.state.building"
    return language.t(key, { time })
  })

  const account = () => (
    <div class="github-account">
      <ProviderIcon id="vercel" class="size-5 shrink-0" />
      <div class="flex min-w-0 flex-1 flex-col">
        <span class="text-13-medium text-text-strong truncate">@{state.status?.username}</span>
        <Show when={state.status?.linkedBy}>
          <span class="text-12-regular text-text-weak truncate">
            {language.t("vercel.account.by", { name: state.status?.linkedBy ?? "" })}
          </span>
        </Show>
      </div>
    </div>
  )

  return (
    <Show when={view() !== "off"}>
      <div class="flex flex-col gap-2.5 border-t border-border-weaker-base pt-4">
        <span class="text-13-medium text-text-strong">{language.t("vercel.title")}</span>
        <Branch>
          <Match when={view() === "failed"}>
            <div class="flex items-center gap-2">
              <span class="github-hint">{language.t("vercel.error.load")}</span>
              <Button type="button" size="small" variant="ghost" icon="refresh" onClick={() => void refetch()}>
                {language.t("envKeys.error.retry")}
              </Button>
            </div>
          </Match>

          <Match when={view() === "loading"}>
            <span class="github-hint">{language.t("common.loading")}</span>
          </Match>

          <Match when={view() === "unlinked"}>
            <ul class="github-panel github-notes">
              <li>{language.t("vercel.intro.age")}</li>
              <li>{language.t("vercel.intro.github")}</li>
              <li>{language.t("vercel.intro.team")}</li>
            </ul>
            <Show when={state.waiting}>
              <span class="github-hint">{language.t("vercel.waiting")}</span>
            </Show>
            <div>
              <Button
                type="button"
                size="normal"
                variant="secondary"
                disabled={spectator || !state.status?.connectUrl}
                onClick={connect}
              >
                {language.t("vercel.connect")}
              </Button>
            </div>
          </Match>

          <Match when={view() === "ready"}>
            {account()}
            <span class="github-hint">{language.t("vercel.deploy.hint")}</span>
            <Show when={state.repo}>
              <span class="github-hint">
                {language.t("vercel.repo.hint")} <Link href={APP}>{language.t("vercel.repo.link")}</Link>
              </span>
            </Show>
            <div>
              <Button
                type="button"
                size="normal"
                variant="primary"
                disabled={spectator || state.busy}
                onClick={() => void create()}
              >
                {language.t("vercel.deploy.start")}
              </Button>
            </div>
          </Match>

          <Match when={view() === "live"}>
            {account()}
            <div class="github-panel flex items-start gap-2">
              <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                <Show when={site()}>
                  {(url) => (
                    <Link class="github-link truncate" href={url()}>
                      {url().replace(/^https:\/\//, "")}
                    </Link>
                  )}
                </Show>
                <span class="text-12-regular text-text-weak">{deployed()}</span>
              </div>
              <IconButton
                type="button"
                size="small"
                variant="ghost"
                icon="refresh"
                aria-label={language.t("vercel.refresh")}
                title={language.t("vercel.refresh")}
                onClick={() => void refetch()}
              />
            </div>
            <Show when={state.status?.deployment?.state === "BLOCKED"}>
              <span class="github-hint">{language.t("vercel.blocked.hint")}</span>
            </Show>
            <Show when={state.status?.backend}>
              <span class="github-hint">{language.t("vercel.backend.hint")}</span>
            </Show>
            <Show when={state.status?.exposed?.length}>
              <span class="github-hint">
                {language.t("vercel.exposed.hint", { keys: state.status?.exposed?.join(", ") ?? "" })}
              </span>
            </Show>
            <span class="github-hint">{language.t("vercel.auto")}</span>
          </Match>
        </Branch>
      </div>
    </Show>
  )
}
