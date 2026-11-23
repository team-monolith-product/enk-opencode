import { Index, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { useParams } from "@solidjs/router"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { getGitHubStatus, listEnvKeys, type GitHubStatus } from "@/utils/server"
import { isTutorialDirectory } from "@/utils/workspace"

type ChromeAction = {
  icon: IconProps["name"]
  label: string
  title: string
  badge?: { count: number; label: string }
  open: () => void
}

/**
 * 미리보기 주소창 오른쪽의 작업 공간 버튼들(외부 연동·버전 기록·GitHub). 넓을 때는 버튼으로, 좁을 때는 ⋯ 메뉴
 * 항목으로 같은 목록을 그린다. 각 버튼은 서버가 그 기능을 열어 줄 때만 보인다.
 */
export function createChromeActions() {
  const dialog = useDialog()
  const language = useLanguage()
  const server = useServer()
  const sdk = useSDK()
  const platform = usePlatform()
  const params = useParams()

  // 배포 직후 구버전 페이지에서 새 청크 로드가 실패할 수 있다 — 조용히 죽지 말고 토스트로 알린다.
  const show = <T,>(load: () => Promise<T>, render: (mod: T) => JSX.Element, done?: () => void) =>
    load()
      .then((mod) => dialog.show(() => render(mod), done))
      .catch(() => showToast({ title: language.t("common.requestFailed") }))

  const opts = () => {
    const conn = server.current
    if (!conn) return
    return { server: conn.http, directory: sdk.directory, fetch: platform.fetch }
  }

  // 시안: 저장된 연결 수 > 0 일 때만 배지. 값 필요 줄은 세지 않는다.
  const [envCount, setEnvCount] = createSignal(0)
  const refreshEnvCount = () => {
    const o = opts()
    if (!o) return
    void listEnvKeys(o)
      .then((keys) => setEnvCount(keys.length))
      .catch(() => setEnvCount(0))
  }

  // 버전 기록은 본행사 폴더에만 있다. 목록·마감 여부는 창을 열 때 묻고, 버튼은 폴더 규약만으로 띄운다.
  const history = () => !isTutorialDirectory(sdk.directory)
  const historyDialog = () => import("@/components/dialog-history")

  const [github, setGithub] = createSignal<GitHubStatus>()
  let announced: string | undefined
  const track = (status: GitHubStatus) => {
    const first = github() === undefined
    setGithub(status)
    const conflict = status.conflict
    if (!conflict || conflict.resolving) {
      announced = undefined
      return
    }
    if (announced === conflict.branch) return
    announced = conflict.branch
    if (!first) showToast({ title: language.t("github.conflict.toast", { branch: conflict.branch }) })
  }
  const refreshGithub = () => {
    const o = opts()
    if (!o) return
    void getGitHubStatus(o)
      .then(track)
      .catch(() => undefined)
  }
  const globalSDK = useGlobalSDK()
  onMount(() => {
    refreshEnvCount()
    if (history()) void historyDialog().catch(() => undefined)
    refreshGithub()
    void globalSDK.event.start()
    const unsub = globalSDK.event.on(sdk.directory, (event) => {
      if ((event as { type?: string }).type !== "session.idle" || !github()?.enabled) return
      for (const delay of [3_000, 10_000]) setTimeout(refreshGithub, delay)
    })
    onCleanup(unsub)
  })
  const conflicted = () => {
    const conflict = github()?.conflict
    if (!conflict || conflict.resolving) return
    return conflict
  }

  return (): ChromeAction[] => [
    {
      icon: "plug",
      label: language.t("command.env.keys"),
      title: language.t("command.env.keys.description"),
      badge:
        envCount() > 0
          ? { count: envCount(), label: language.t("command.env.keys.badge", { count: envCount() }) }
          : undefined,
      open: () => {
        refreshEnvCount()
        void show(
          () => import("@/components/dialog-env-keys"),
          (x) => <x.DialogEnvKeys />,
          refreshEnvCount,
        )
      },
    },
    ...(history() && params.id
      ? [
          {
            icon: "clock" as const,
            label: language.t("command.history"),
            title: language.t("command.history.description"),
            open: () => void show(historyDialog, (x) => <x.DialogHistory sessionID={params.id!} />),
          },
        ]
      : []),
    ...(github()?.enabled
      ? [
          {
            icon: "github" as const,
            label: language.t("command.github"),
            title: language.t("command.github.description"),
            badge: conflicted()
              ? {
                  count: conflicted()!.files.length,
                  label: language.t("github.conflict.badge", { count: conflicted()!.files.length }),
                }
              : undefined,
            open: () =>
              void show(
                () => import("@/components/dialog-github"),
                (x) => <x.DialogGitHub sessionID={params.id} onChange={track} />,
              ),
          },
        ]
      : []),
  ]
}

export function ChromeActionButtons(props: { actions: ChromeAction[]; class: string }) {
  return (
    <Index each={props.actions}>
      {(action) => (
        <button
          type="button"
          class={props.class}
          onClick={() => action().open()}
          aria-label={action().label}
          title={action().title}
        >
          <Icon name={action().icon} size="small" />
          {/* 라벨은 가장 넓은 요소 — 520px 미만에서 아이콘+배지만 남긴다(aria-label 로 이름은 유지). */}
          <span class="@max-[520px]/chrome:hidden">{action().label}</span>
          <Show when={action().badge}>
            {(badge) => (
              <span
                class="inline-flex items-center justify-center min-w-[15px] h-[15px] px-1 rounded-full bg-surface-success-strong text-white font-mono text-[9.5px] font-bold leading-none"
                aria-label={badge().label}
              >
                {badge().count}
              </span>
            )}
          </Show>
        </button>
      )}
    </Index>
  )
}

export function ChromeActionItems(props: { actions: ChromeAction[] }) {
  return (
    <Index each={props.actions}>
      {(action) => (
        <DropdownMenu.Item onSelect={() => action().open()}>
          <DropdownMenu.ItemLabel>
            {action().label}
            <Show when={action().badge}>{(badge) => <> ({badge().count})</>}</Show>
          </DropdownMenu.ItemLabel>
        </DropdownMenu.Item>
      )}
    </Index>
  )
}
