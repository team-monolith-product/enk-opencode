import { Index, Show, createSignal, onMount, type JSX } from "solid-js"
import { useDialog } from "@opencode/ui/context/dialog"
import { Menu } from "@opencode/ui/menu"
import { Icon, type IconProps } from "@/jitda/env/ui/icon"
import { useJitda } from "@/jitda/context"
import { useLanguage } from "@/runtime/i18n/language"
import { showToast } from "@/shell/notifications/toast"

type ChromeAction = {
  icon: IconProps["name"]
  label: string
  title: string
  badge?: { count: number; label: string }
  open: () => void
}

// 미리보기 주소창 오른쪽의 작업 공간 버튼들(외부 연동·버전 기록·GitHub). 넓을 때는 버튼으로, 좁을 때는 ⋯ 메뉴 항목으로 같은
// 목록을 그린다. 각 버튼은 서버가 그 기능을 열어 줄 때만 보인다.
export function createChromeActions() {
  const jitda = useJitda()
  const dialog = useDialog()
  const language = useLanguage()
  const t = (key: string, params?: Record<string, string | number | boolean>) =>
    language.t(key as Parameters<typeof language.t>[0], params)

  // 배포 직후 구버전 페이지에서 새 청크 로드가 실패할 수 있다 — 조용히 죽지 말고 토스트로 알린다.
  const show = <T,>(load: () => Promise<T>, render: (mod: T) => JSX.Element, done?: () => void) =>
    load()
      .then((mod) => dialog.show(() => render(mod), done))
      .catch(() => showToast({ title: t("common.requestFailed") }))

  // 저장된 연결 수 > 0 일 때만 배지. 값 필요 줄은 세지 않는다.
  const [envCount, setEnvCount] = createSignal(0)
  const refreshEnvCount = () => {
    void jitda.rpc.envFile
      .list({}, jitda.options())
      .then((value: unknown) => setEnvCount(((value as { keys?: string[] }).keys ?? []).length))
      .catch(() => setEnvCount(0))
  }

  // 버전 기록은 본행사 폴더에만 있다. 목록은 창을 열 때 묻고, 버튼은 폴더 규약만으로 띄운다.
  const history = () => !jitda.tutorial()
  const historyDialog = () => import("@/jitda/history/dialog-history")

  const [github, setGithub] = createSignal(false)
  onMount(() => {
    refreshEnvCount()
    if (history()) void historyDialog().catch(() => undefined)
    void jitda.rpc.github
      .status({}, jitda.options())
      .then((value: unknown) => setGithub(!!(value as { enabled?: boolean }).enabled))
      .catch(() => setGithub(false))
  })

  return (): ChromeAction[] => [
    {
      icon: "plug",
      label: t("command.env.keys"),
      title: t("command.env.keys.description"),
      badge:
        envCount() > 0 ? { count: envCount(), label: t("command.env.keys.badge", { count: envCount() }) } : undefined,
      open: () => {
        refreshEnvCount()
        void show(
          () => import("@/jitda/env/dialog-env-keys"),
          (x) => <x.DialogEnvKeys />,
          refreshEnvCount,
        )
      },
    },
    ...(history() && jitda.sessionID
      ? [
          {
            icon: "clock" as const,
            label: t("command.history"),
            title: t("command.history.description"),
            open: () => void show(historyDialog, (x) => <x.DialogHistory sessionID={jitda.sessionID} />),
          },
        ]
      : []),
    ...(github()
      ? [
          {
            icon: "github" as const,
            label: t("command.github"),
            title: t("command.github.description"),
            open: () =>
              void show(
                () => import("@/jitda/github/dialog-github"),
                (x) => <x.DialogGitHub />,
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
        <Menu.Item onSelect={() => action().open()}>
          {action().label}
          <Show when={action().badge}>{(badge) => <> ({badge().count})</>}</Show>
        </Menu.Item>
      )}
    </Index>
  )
}
