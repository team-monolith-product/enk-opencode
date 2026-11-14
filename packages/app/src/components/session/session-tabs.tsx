import { For, Show, createMemo, createSignal } from "solid-js"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { apiUrl } from "@/utils/api-url"
import { errorMessage } from "@/pages/layout/helpers"
import "./session-tabs.css"

export function teamSessions<T extends { parentID?: string; time: { created: number; archived?: number } }>(
  sessions: T[],
) {
  return sessions
    .filter((item) => !item.parentID && !item.time.archived)
    .sort((a, b) => a.time.created - b.time.created)
}

const DEFAULT_TITLE = /^New session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function sessionLabel(
  title: string | undefined,
  index: number,
  t: (key: "session.tabs.numbered", params: { n: number }) => string,
) {
  if (title && !DEFAULT_TITLE.test(title)) return title
  return t("session.tabs.numbered", { n: index + 1 })
}

export function SessionTabs() {
  const sync = useSync()
  const sdk = useSDK()
  const params = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const language = useLanguage()
  const [creating, setCreating] = createSignal(false)

  const limit = () => sync.data.env?.sessionLimit ?? 1
  const sessions = createMemo(() => teamSessions(sync.data.session ?? []))
  const full = () => sessions().length >= limit()

  const open = (id: string) => navigate(`/${params.dir}/session/${id}${location.search}${location.hash}`)

  const add = async () => {
    if (creating() || full()) return
    setCreating(true)
    const url = apiUrl(sdk.url, "/session")
    url.searchParams.set("directory", sdk.directory)
    url.searchParams.set("fresh", "true")
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const info = (await res.json()) as { id?: string }
        if (info.id) open(info.id)
      })
      .catch((err) =>
        showToast({
          title: language.t("session.tabs.createFailed"),
          description: errorMessage(err, language.t("common.requestFailed")),
        }),
      )
      .finally(() => setCreating(false))
  }

  return (
    <Show when={limit() > 1}>
      <div data-component="session-tabs" role="tablist" aria-label={language.t("session.tabs.label")}>
        <For each={sessions()}>
          {(item, index) => (
            <button
              type="button"
              role="tab"
              class="session-tab"
              classList={{ "is-active": item.id === params.id }}
              aria-selected={item.id === params.id}
              onClick={() => open(item.id)}
              title={sessionLabel(item.title, index(), language.t)}
            >
              <span class="session-tab__title">{sessionLabel(item.title, index(), language.t)}</span>
              <Show when={sync.data.session_status?.[item.id]?.type === "busy"}>
                <span class="session-tab__busy" aria-hidden="true" />
              </Show>
            </button>
          )}
        </For>
        <button
          type="button"
          class="session-tab session-tab--add"
          onClick={() => void add()}
          disabled={creating() || full()}
          aria-label={language.t("session.tabs.new")}
          title={full() ? language.t("session.tabs.full", { count: limit() }) : language.t("session.tabs.new")}
        >
          <Icon name="plus-small" size="small" />
        </button>
      </div>
    </Show>
  )
}
