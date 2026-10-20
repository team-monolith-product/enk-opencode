import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { ErrorEntry } from "./preview-bridge-protocol"
import { Menu } from "@opencode/ui/menu"
import { useDialog } from "@opencode/ui/context/dialog"
import { Icon } from "@/jitda/env/ui/icon"
import { IconButton } from "@/jitda/env/ui/icon-button"
import { TooltipKeybind } from "@/jitda/env/ui/tooltip"
import { writeClipboard } from "@/jitda/env/ui/clipboard"
import { showToast } from "@/shell/notifications/toast"
import { useLanguage } from "@/runtime/i18n/language"
import { useCommand } from "@/shell/commands/command"
import { useWorkspaceLocation } from "@/workspaces/location"
import { useJitda } from "@/jitda/context"
import { Flags } from "@/jitda/flags"
import type { DevServerLogsResult, DevServerRestartResult, DevServerStatusResult } from "./dev-server"
import { SessionPreviewFallback } from "./preview-fallback"
import { createPreviewBridge, type PreviewBridge } from "./preview-bridge"
import { formatBaseHost, formatEditablePath, resolveNavigatePath } from "./preview-address"
import { needsReachabilityProbe, resolvePreviewState } from "./preview-state"

// session.idle 리로드 뒤 자가치유(브릿지 주입) 파일 쓰기가 도착하길 기다리는 유예 시간.
const HEAL_RELOAD_GRACE_MS = 1500

// "다시 시도" 연타 방어용 쿨다운 — 재시작 왕복이 끝난 뒤 이 시간 동안 재클릭을 무시한다.
const RETRY_COOLDOWN_MS = 1500

const STARTING_POLL_MS = 2000

// 대기/오류 화면에 흘려 보여 줄 dev 서버 로그 줄 수.
const PREVIEW_LOG_LINES = 24

// startable 재폴링 간격. 부팅 replay 처럼 우리가 띄우지 않은 경로로 dev 서버가 늦게 떠도 미리보기가 뜨게 한다.
const STARTABLE_POLL_MS = 5000

// 서버 self-probe(127.0.0.1)는 배포 환경에서 CHP 라우팅과 어긋날 수 있어 클라가 직접 닿는지도 본다.
// cors 로 상태 코드를 읽어 >=500(프록시가 돌려준 결과물 서버 다운)은 닿지 않은 것으로 본다. throw 면 false.
async function previewReachable(url: string | undefined): Promise<boolean> {
  if (!url) return false
  try {
    const res = await fetch(url, { cache: "no-store", mode: "cors" })
    return res.status < 500
  } catch {
    return false
  }
}

export function createSessionPreview() {
  const jitda = useJitda()
  const location = useWorkspaceLocation()
  const language = useLanguage()

  // VITE_PREVIEW_URL 로 미리보기 URL 을 덮어쓴다(개발·레이아웃 확인용). iframe 삽입을 허용하는 사이트여야 한다.
  const previewOverride = Flags.previewUrl?.trim() || undefined

  const previewUrl = createMemo(() => {
    if (previewOverride) return previewOverride
    const env = jitda.env()
    const domain = env.serveDomain
    const user = env.jupyterhubUser
    if (!domain || !user) return undefined
    // 튜토리얼 디렉토리는 CHP 가 {user}-tutorial 을 :3001 로 라우팅한다(서버 ServeTargets 와 같은 규약).
    const suffix = jitda.tutorial() ? "-tutorial" : ""
    return `https://${user}${suffix}.${domain}`
  })

  const [previewStatus, setPreviewStatus] = createSignal<DevServerStatusResult>({ state: "starting" })
  const previewReady = () => previewStatus().state === "ready"
  const [previewLogs, setPreviewLogs] = createSignal<DevServerLogsResult>({ lines: [] })
  const [dirty, setDirty] = createSignal(false)
  const [reloadCount, setReloadCount] = createSignal(0)

  let recheck: () => void = () => {}

  createEffect(() => {
    if (previewOverride) {
      setPreviewStatus({ state: "ready" })
      recheck = () => {}
      return
    }

    const events = location().event
    let disposed = false
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    // startable 을 처음 만나면 "다시 시도"를 대신 눌러준다(pod 재스폰 직후 버튼을 눌러야만 살아나던 문제). 연결당 1회.
    let autoRetried = false
    const poll = async () => {
      if (disposed) return
      const server = await jitda.rpc.devServer
        .status({}, jitda.options())
        .then((value: unknown) => value as DevServerStatusResult)
        .catch(() => undefined)
      if (disposed) return

      const reachable = needsReachabilityProbe(server) ? await previewReachable(previewUrl()) : false
      if (disposed) return
      const next = resolvePreviewState(server, reachable)

      setPreviewStatus(next)
      if (next.state === "ready") {
        setPreviewLogs({ lines: [] })
      } else {
        void jitda.rpc.devServer
          .logs({ tail: PREVIEW_LOG_LINES }, jitda.options())
          .then((logs: unknown) => {
            if (!disposed)
              setPreviewLogs({ ...(logs as DevServerLogsResult), lines: (logs as DevServerLogsResult).lines ?? [] })
          })
          .catch(() => {})
      }
      const repollMs =
        next.state === "starting" ? STARTING_POLL_MS : next.state === "startable" ? STARTABLE_POLL_MS : undefined
      if (repollMs !== undefined) {
        if (pollTimer) clearTimeout(pollTimer)
        pollTimer = setTimeout(() => void poll(), repollMs)
      }
      if (next.state === "startable" && !autoRetried) {
        autoRetried = true
        void restart({ silent: true })
      }
    }
    recheck = () => void poll()

    void poll()
    // session.idle 때 서버 플러그인이 결과물 HTML 에 브릿지를 주입하는데, 그 파일 쓰기 이벤트는 idle 리로드 직후에 온다.
    // 잠깐 기다렸다가 dirty 가 다시 섰으면 1회 더 리로드해 첫 미리보기부터 브릿지가 실린 페이지를 로드한다.
    let healReloadTimer: ReturnType<typeof setTimeout> | undefined
    const reloadIfDirty = () => {
      if (dirty()) {
        setReloadCount((n) => n + 1)
        setDirty(false)
      }
    }
    const unsubIdle = events.on("session.idle", () => {
      void poll()
      reloadIfDirty()
      if (healReloadTimer) clearTimeout(healReloadTimer)
      healReloadTimer = setTimeout(reloadIfDirty, HEAL_RELOAD_GRACE_MS)
    })
    const unsubFile = events.on("filesystem.changed", (event) => {
      const file = event.data.file
      if (file.startsWith(".git/") || file.includes("/.git/")) return
      setDirty(true)
    })

    onCleanup(() => {
      disposed = true
      if (pollTimer) clearTimeout(pollTimer)
      recheck = () => {}
      unsubIdle()
      unsubFile()
      if (healReloadTimer) clearTimeout(healReloadTimer)
    })
  })

  const previewSrc = createMemo(() => {
    if (!previewReady()) return undefined
    const url = previewUrl()
    if (!url) return undefined
    const count = reloadCount()
    if (count === 0) return url
    // src 의 쿼리만 바꿔 기존 iframe 을 재탐색시킨다(DOM remount 없음).
    const composed = new URL(url)
    composed.searchParams.set("reloadCount", String(count))
    return composed.toString()
  })

  const reload = () => setReloadCount((n) => n + 1)

  // 연타 방어: in-flight 잠금 + 완료 후 쿨다운. 서버가 실제로 떠 있을 때만 recheck + reload 한다.
  const [restarting, setRestarting] = createSignal(false)
  let restartCooldownUntil = 0
  let restartInflight: Promise<void> | undefined
  const restart = (opts?: { silent?: boolean }) => {
    if (restartInflight) return restartInflight
    if (Date.now() < restartCooldownUntil) return Promise.resolve()
    const notifyError = (title: string, description?: string) => {
      if (opts?.silent) return
      showToast({ variant: "error", title, description })
    }
    setRestarting(true)
    restartInflight = jitda.rpc.devServer
      .restart({}, jitda.options())
      .then((value: unknown) => {
        const res = value as DevServerRestartResult
        if (res.status === "started" || res.status === "already_running") {
          recheck()
          setReloadCount((n) => n + 1)
        } else if (res.status === "already_starting") {
          recheck()
        } else if (res.status === "no_command") {
          notifyError(language.t("session.preview.retry.noServer"))
        } else {
          notifyError(language.t("session.preview.retry.failed"), res.reason)
        }
      })
      .catch(() => {
        notifyError(language.t("session.preview.retry.failed"))
      })
      .finally(() => {
        restartInflight = undefined
        restartCooldownUntil = Date.now() + RETRY_COOLDOWN_MS
        setRestarting(false)
      })
    return restartInflight
  }

  const bridge = createPreviewBridge({ origin: previewUrl })

  // HTTP 는 정상(ready)인데 JS 가 터져 백지가 되는 경우는 브릿지가 받은 클라 에러로만 알 수 있다.
  const [errorDismissed, setErrorDismissed] = createSignal(false)
  const errorCount = () => bridge.errors().length
  const latestError = () => bridge.errors().at(-1)
  const hasClientError = () => previewReady() && errorCount() > 0
  const showErrorOverlay = () => hasClientError() && !errorDismissed()
  const showErrorButton = () => hasClientError()
  const dismissError = () => setErrorDismissed(true)
  const reopenError = () => setErrorDismissed(false)
  const toggleError = () => setErrorDismissed((d) => !d)
  const clearClientErrors = () => {
    bridge.clearLogs()
    setErrorDismissed(false)
  }
  let skipFirstErrorClear = true
  createEffect(() => {
    reloadCount()
    if (skipFirstErrorClear) {
      skipFirstErrorClear = false
      return
    }
    clearClientErrors()
  })

  // 뒤로/앞으로 활성 판단용 자식 history 미러. 진실원은 자식 history 이고, 스택/커서는 일반 변수로 둬
  // 자기참조 재실행을 피한다.
  let stack: string[] = []
  let cursor = -1
  const [canGoBack, setCanGoBack] = createSignal(false)
  const [canGoForward, setCanGoForward] = createSignal(false)

  createEffect(() => {
    const loc = bridge.location()
    if (!loc) return
    const href = loc.href
    if (loc.type === "replace") {
      if (cursor < 0) {
        stack = [href]
        cursor = 0
      } else stack[cursor] = href
    } else if (loc.type === "pop") {
      const found = stack.indexOf(href)
      if (found >= 0) cursor = found
      else {
        stack = stack.slice(0, cursor + 1)
        stack.push(href)
        cursor = stack.length - 1
      }
    } else {
      if (!(cursor >= 0 && stack[cursor] === href)) {
        stack = stack.slice(0, cursor + 1)
        stack.push(href)
        cursor = stack.length - 1
      }
    }
    setCanGoBack(cursor > 0)
    setCanGoForward(cursor < stack.length - 1)
  })

  const host = createMemo(() => {
    const loc = bridge.location()
    const src = loc?.href ?? previewUrl()
    if (!src) return undefined
    return formatBaseHost(src)
  })
  const path = createMemo(() => {
    const loc = bridge.location()
    if (!loc) return ""
    return formatEditablePath(loc)
  })
  const currentUrl = createMemo(() => bridge.location()?.href ?? previewUrl())

  const goBack = () => void bridge.child()?.back()
  const goForward = () => void bridge.child()?.forward()
  // 홈 — 리로드 없이 "/" 로 소프트 라우팅. 미연결이면 src 재로드로 폴백.
  const goHome = () => {
    clearClientErrors()
    const child = bridge.child()
    if (child) void child.routeTo("/")
    else reload()
  }
  const hardReload = () => {
    clearClientErrors()
    const child = bridge.child()
    if (child) void child.reload()
    else reload()
  }
  const navigatePath = (p: string) => {
    const base = previewUrl()
    if (!base) return
    clearClientErrors()
    try {
      void bridge.child()?.navigate(resolveNavigatePath(base, p))
    } catch {
      /* 잘못된 경로 입력 무시 */
    }
  }

  return {
    previewUrl,
    previewReady,
    previewStatus,
    previewLogs,
    previewSrc,
    reload,
    restart,
    restarting,
    goHome,
    hardReload,
    bridge,
    host,
    path,
    currentUrl,
    canGoBack,
    canGoForward,
    goBack,
    goForward,
    navigatePath,
    showErrorOverlay,
    showErrorButton,
    errorCount,
    errors: bridge.errors,
    latestError,
    dismissError,
    reopenError,
    toggleError,
  }
}

export function SessionPreviewPanel(props: {
  src?: string
  bridge?: PreviewBridge
  onRetry?: () => void
  retrying?: boolean
  state?: DevServerStatusResult["state"]
  httpStatus?: number
  loopbackOnly?: boolean
  logs?: string[]
  logCmd?: string
  showError?: boolean
  errors?: ErrorEntry[]
  errorCount?: number
  onErrorReload?: () => void
  onErrorDismiss?: () => void
}) {
  const language = useLanguage()

  // "AI에게 요청" 입력 — 비어 있으면 플레이스홀더 문구가 기본값. 복사 시 (이 문구 + 에러 목록)이 클립보드로.
  const [askText, setAskText] = createSignal("")
  const [copied, setCopied] = createSignal(false)
  let copyTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => copyTimer && clearTimeout(copyTimer))
  const formatError = (e: ErrorEntry) => {
    const loc =
      e.source != null
        ? ` (${e.source}${e.line != null ? `:${e.line}${e.column != null ? `:${e.column}` : ""}` : ""})`
        : ""
    return `- ${e.message}${loc}`
  }
  const copyForAi = () => {
    const ask = askText().trim() || language.t("session.preview.clientError.placeholder")
    const list = (props.errors ?? []).map(formatError).join("\n")
    void writeClipboard(list ? `${ask}\n\n${list}` : ask)
    setCopied(true)
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div data-component="codle-preview-panel" class="relative size-full min-w-0 overflow-hidden rounded-none">
      <Show
        when={props.src}
        fallback={
          <SessionPreviewFallback
            state={props.state}
            httpStatus={props.httpStatus}
            loopbackOnly={props.loopbackOnly}
            logs={props.logs}
            logCmd={props.logCmd}
            onRetry={props.onRetry}
            retrying={props.retrying}
          />
        }
      >
        {(src) => (
          <iframe
            ref={(el) => props.bridge?.attach(el)}
            src={src()}
            class="w-full h-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            allow="camera; microphone; geolocation"
          />
        )}
      </Show>

      {/* 클라이언트 런타임 에러 카드 — iframe(흰 화면일 수 있음) 위 가운데. 렌더된 화면은 그대로 두고 덧씌운다.
          × 로 내리면 헤더의 경고 버튼으로 옮겨가고, 그 버튼을 누르면 다시 이 카드가 뜬다. */}
      <Show when={props.showError}>
        {/* 스크림 클릭 = 카드 닫기(미리보기 안에서만). 카드 내부 클릭은 stopPropagation 으로 유지. */}
        <div
          class="absolute inset-0 z-10 flex items-center justify-center p-5"
          style={{ background: "rgba(0,0,0,0.38)" }}
          onClick={() => props.onErrorDismiss?.()}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            class="flex w-full max-w-[470px] max-h-[330px] flex-col overflow-hidden rounded-xl border border-critical-base bg-background-base shadow-lg"
          >
            {/* 헤더 — 오류 개수 + 새로고침(리로드) + 닫기 */}
            <div class="flex shrink-0 items-center gap-2 px-3.5 py-2.5 border-b border-border-weak-base">
              <Icon name="warning" size="small" class="shrink-0 text-icon-critical-base" />
              <span class="text-12-medium text-text-base">
                {language.t("session.preview.clientError.title", { count: props.errorCount ?? 0 })}
              </span>
              <span class="flex-1" />
              <button
                type="button"
                onClick={() => props.onErrorReload?.()}
                class="inline-flex items-center gap-1 h-6 px-2.5 rounded-md border border-border-weak-base text-12-medium text-text-base hover:bg-surface-raised-base-hover transition-colors"
              >
                <Icon name="refresh" size="small" />
                {language.t("session.preview.clientError.reload")}
              </button>
              <button
                type="button"
                onClick={() => props.onErrorDismiss?.()}
                aria-label={language.t("session.preview.clientError.dismiss")}
                class="inline-flex size-6 items-center justify-center rounded-md border border-border-weak-base text-icon-base hover:bg-surface-raised-base-hover transition-colors"
              >
                <Icon name="close-small" size="small" />
              </button>
            </div>

            {/* 오류 목록(스크롤) — 각 항목: 메시지(최대 3줄) + source:line:col(줄바꿈) + 스택.
                본문 배경은 채팅창(background-stronger)과 동일하게 — 헤더/푸터(background-base)와 대비. */}
            <div class="min-h-0 flex-1 overflow-y-auto bg-background-stronger">
              <For each={props.errors}>
                {(e) => (
                  <div class="px-3.5 py-2.5 border-b border-border-weak-base last:border-b-0">
                    <div class="text-12-medium text-icon-critical-base line-clamp-3" style={{ "line-height": "1.4" }}>
                      {e.message}
                    </div>
                    <Show when={e.source}>
                      <div
                        class="mt-0.5 break-all text-text-weak"
                        style={{ "font-family": "var(--font-family-mono)", "font-size": "11.5px" }}
                      >
                        {e.source}
                        {e.line != null ? `:${e.line}` : ""}
                        {e.column != null ? `:${e.column}` : ""}
                      </div>
                    </Show>
                    <Show when={e.stack}>
                      <pre
                        class="mt-1.5 overflow-x-auto rounded-md bg-background-base px-2 py-1.5 text-text-weak"
                        style={{
                          "font-family": "var(--font-family-mono)",
                          "font-size": "11.5px",
                          "white-space": "pre",
                        }}
                      >
                        {e.stack}
                      </pre>
                    </Show>
                  </div>
                )}
              </For>
            </div>

            {/* AI에게 요청 — 입력(플레이스홀더 기본값) + 에러와 함께 복사 */}
            <div class="flex shrink-0 items-center gap-2 px-3.5 py-2 border-t border-border-weak-base">
              <span class="shrink-0 text-12-regular text-text-weak">
                {language.t("session.preview.clientError.askAi")}
              </span>
              <input
                type="text"
                value={askText()}
                onInput={(e) => setAskText(e.currentTarget.value)}
                placeholder={language.t("session.preview.clientError.placeholder")}
                class="min-w-0 flex-1 h-7 rounded-md text-12-regular text-text-base bg-background-stronger outline-none"
                style={{ border: "1px solid var(--border-weak-base)", padding: "0 10px" }}
              />
              <button
                type="button"
                onClick={copyForAi}
                aria-label={language.t("session.preview.clientError.copy")}
                classList={{ "text-icon-success-base": copied() }}
                class="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border-weak-base text-icon-base hover:bg-surface-raised-base-hover transition-colors"
              >
                <Icon name={copied() ? "check-small" : "copy"} size="small" />
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}

// 미리보기 브라우저 chrome 바 — 시안(SafariChrome) 참고. 좌: 트래픽 라이트 + 파일 탐색기 토글 + 뒤로/앞으로,
// 중앙: 주소 pill(홈·주소·새로고침), 우: 새 탭에서 열기 + 주소 복사. 앱 디자인 토큰으로 테마 대응.
export function SessionBrowserChrome(props: {
  /** 고정 베이스 호스트(미리보기). 파일 탭 모드에서는 비움. */
  host?: string
  /** 표시·편집 대상 경로(미리보기) 또는 파일 경로(파일 탭 모드). */
  path?: string
  /** true 면 경로 입력 가능(미리보기). false 면 읽기 전용 표시. */
  editablePath?: boolean
  onNavigatePath?: (path: string) => void
  canGoBack?: boolean
  canGoForward?: boolean
  onBack?: () => void
  onForward?: () => void
  url?: string
  onReload: () => void
  onHome?: () => void
  previewReady?: boolean
  /** 현재 보이는 뷰가 미리보기인지. false 면(파일/컨텍스트/리뷰 탭) 미리보기 전용 컨트롤(뒤/앞/새로고침)을 흐리게. */
  previewActive?: boolean
  /** 클라 에러가 있으면 항상 노출되는 경고 버튼 — 누르면 에러 카드를 토글한다. */
  showErrorButton?: boolean
  errorCount?: number
  /** 에러 카드가 현재 열려 있는지(버튼 active 표시·aria-expanded 용). */
  errorOpen?: boolean
  onToggleError?: () => void
  fileTreeOpen: boolean
  onToggleFileTree: () => void
}) {
  const jitda = useJitda()
  const language = useLanguage()
  const command = useCommand()
  const dialog = useDialog()
  const [copied, setCopied] = createSignal(false)

  // 저장된 연결 수 > 0 일 때만 배지. 값 필요 줄은 세지 않는다.
  const [envCount, setEnvCount] = createSignal(0)
  const refreshEnvCount = () => {
    void jitda.rpc.envFile
      .list({}, jitda.options())
      .then((value: unknown) => setEnvCount(((value as { keys?: string[] }).keys ?? []).length))
      .catch(() => setEnvCount(0))
  }
  onMount(() => refreshEnvCount())

  const openEnvKeys = () => {
    refreshEnvCount()
    // 배포 직후 구버전 페이지에서 새 청크 로드가 실패할 수 있다 — 조용히 죽지 말고 토스트로 알린다.
    import("@/jitda/env/dialog-env-keys")
      .then((x) => dialog.show(() => <x.DialogEnvKeys />, refreshEnvCount))
      .catch(() => showToast({ title: language.t("common.requestFailed") }))
  }

  const [github, setGithub] = createSignal(false)
  onMount(() => {
    void jitda.rpc.github
      .status({}, jitda.options())
      .then((value: unknown) => setGithub(!!(value as { enabled?: boolean }).enabled))
      .catch(() => setGithub(false))
  })

  const openGitHub = () => {
    import("@/jitda/github/dialog-github")
      .then((x) => dialog.show(() => <x.DialogGitHub />))
      .catch(() => showToast({ title: language.t("common.requestFailed") }))
  }
  let copyTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => copyTimer && clearTimeout(copyTimer))

  const previewBlocked = () => props.previewReady === false
  // 미리보기가 지금 보이는 뷰가 아니면(파일/컨텍스트/리뷰 탭) 미리보기 전용 컨트롤(뒤/앞/새로고침)을 흐리게 —
  // "이 바는 지금 화면과 별개"임을 시각적으로 알린다. 동작은 그대로 두고 표시만 흐리게 한다.
  const previewInactive = () => props.previewActive === false

  // 주소 입력 — 편집 중에는 draft 를, 아니면 항상 props.path 를 표시(자식 라우팅 따라 갱신).
  let inputEl: HTMLInputElement | undefined
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const displayValue = () => (editing() ? draft() : (props.path ?? ""))
  const commit = () => {
    if (!editing() || previewBlocked()) return
    setEditing(false)
    props.onNavigatePath?.(draft().trim())
  }

  // 편집 불가 상태로 바뀌면(파일 탭 활성으로 editablePath=false, 또는 미리보기 차단) editing 을 강제로 내린다.
  // 안 그러면 input 이 포커스를 유지한 채 editing 만 남아 displayValue 가 draft 에 고정 → 외부 경로 갱신이
  // 안 보이고 타이핑·삭제가 먹지 않는 것처럼 보인다.
  createEffect(() => {
    if ((!props.editablePath || previewBlocked()) && editing()) setEditing(false)
  })

  const openInNewTab = () => {
    if (previewBlocked() || !props.url) return
    window.open(props.url, "_blank", "noopener")
  }
  const copyAddress = () => {
    if (previewBlocked() || !props.url) return
    void writeClipboard(props.url)
    setCopied(true)
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => setCopied(false), 1500)
  }

  const ghostBtn =
    "inline-flex items-center justify-center size-6 shrink-0 rounded-md text-icon-base " +
    "enabled:hover:bg-surface-raised-base-hover enabled:active:bg-surface-base-active " +
    "transition-colors disabled:opacity-40 disabled:cursor-default disabled:pointer-events-none"

  // 호스트(span)와 경로(input)가 폰트·크기·줄높이·색이 완전히 같도록 인라인으로 고정한다.
  // input 은 폼 요소 UA 스타일·레이어 순서 때문에 클래스만으로는 span 과 색/폰트가 달라지므로(인라인이 이긴다).
  const addressTextStyle = {
    "font-family": "var(--font-family-sans)",
    "font-size": "var(--font-size-small)",
    "font-weight": "var(--font-weight-regular)",
    "line-height": "var(--line-height-large)",
    "letter-spacing": "var(--letter-spacing-normal)",
    color: "var(--color-text-base)",
  }

  // 좁아질 때 절대 2줄이 되지 않게 flex-nowrap 을 명시하고, 넘치면 잘리는 대신 컨테이너 쿼리
  // 티어(@max-[…]/chrome)로 우선순위가 낮은 요소부터 덜어낸다. 기준은 뷰포트가 아니라 이 바의 폭 —
  // 패널이 드래그로 리사이즈되므로(session-side-panel) 뷰포트 미디어 쿼리로는 판정할 수 없다.
  //   <520px: 「외부 연동」 라벨 숨김(아이콘+배지만)
  //   <440px: 트래픽 라이트 숨김
  //   <380px: 연동·새 탭·복사를 ⋯ 메뉴로 접음
  return (
    <div
      data-component="codle-browser-chrome"
      class="@container/chrome flex flex-nowrap items-center gap-2.5 px-3 h-9 shrink-0 overflow-hidden border-b border-border-weaker-base bg-background-base"
    >
      {/* 좌 그룹 — 트래픽 라이트 + 파일 탐색기 토글 + 뒤로/앞으로 */}
      <div class="flex shrink-0 items-center gap-2.5">
        {/* 순수 장식이라 가장 먼저 덜어낸다(440px 미만) */}
        <div class="flex items-center gap-1.5 shrink-0 @max-[440px]/chrome:hidden">
          <span class="size-2.5 rounded-full" style={{ background: "#ff5f57" }} />
          <span class="size-2.5 rounded-full" style={{ background: "#febc2e" }} />
          <span class="size-2.5 rounded-full" style={{ background: "#28c840" }} />
        </div>
        <TooltipKeybind
          title={language.t("session.header.open.fileExplorer")}
          keybind={command.keybind("fileTree.toggle")}
        >
          <IconButton
            icon={props.fileTreeOpen ? "sidebar-active" : "sidebar"}
            variant="ghost"
            size="small"
            onClick={() => props.onToggleFileTree()}
            aria-label={language.t("session.header.open.fileExplorer")}
            aria-expanded={props.fileTreeOpen}
            aria-controls="file-tree-panel"
          />
        </TooltipKeybind>
        <div class="flex items-center shrink-0">
          {/* 뒤로/앞으로 — 자식 history 미러로 활성 판단, 클릭 시 자식 history 이동 */}
          <button
            type="button"
            class={ghostBtn}
            classList={{ "opacity-50": previewInactive() }}
            aria-label={language.t("common.back")}
            disabled={previewBlocked() || !props.canGoBack}
            onClick={() => props.onBack?.()}
          >
            <Icon name="chevron-left" size="small" />
          </button>
          {/* 구분선 — 뒤로/앞으로 버튼 사이 세퍼레이터(디자인 시안: 1×13, 여백 없음) */}
          <span aria-hidden="true" class="h-[13px] w-px shrink-0 bg-border-weak-base" />
          <button
            type="button"
            class={ghostBtn}
            classList={{ "opacity-50": previewInactive() }}
            aria-label={language.t("common.forward")}
            disabled={previewBlocked() || !props.canGoForward}
            onClick={() => props.onForward?.()}
          >
            <Icon name="chevron-right" size="small" />
          </button>
        </div>
      </div>

      {/* 중앙 — 주소 pill (홈 · 주소 · 새로고침), 360px 고정·좁은 크롬에서는 max-w-full 로 축소.
          min-w 가 없으면 pill 테두리만 0 까지 줄고 안의 홈/새로고침 버튼(shrink-0)이 테두리 밖으로
          삐져나온다 — 하한을 두고 overflow-hidden 으로 넘치는 텍스트를 pill 안에서 자른다. */}
      <div class="flex flex-1 min-w-0 items-center justify-center">
        <div class="flex h-6 w-[360px] max-w-full min-w-[88px] items-center gap-1 overflow-hidden px-1 rounded-md border border-border-weak-base bg-background-stronger">
          <button
            type="button"
            class={ghostBtn + " !size-5"}
            aria-label={language.t("session.tab.preview")}
            disabled={previewBlocked()}
            onClick={() => props.onHome?.()}
          >
            <Icon name="home" size="small" />
          </button>
          {/* 베이스(host/) + path suffix — 한 덩어리로 pill 가운데 정렬 */}
          <div
            class="flex flex-1 min-w-0 items-center justify-center overflow-hidden"
            classList={{ "cursor-text": !!props.editablePath && !previewBlocked() }}
            onMouseDown={(e) => {
              if (!props.editablePath || previewBlocked()) return
              if (e.target === inputEl) return
              e.preventDefault()
              inputEl?.focus()
            }}
          >
            <div class="flex min-w-0 max-w-full items-center overflow-hidden">
              <Show when={props.host}>
                {/* 호스트는 경로보다 우선(shrink-0)이지만 pill 을 넘어서면 말줄임 —
                    max-w-full 이 없으면 shrink-0 때문에 truncate 가 영영 발동하지 않는다. */}
                <span class="shrink-0 max-w-full truncate" style={addressTextStyle}>
                  {props.host}
                </span>
              </Show>
              <input
                ref={(el) => {
                  inputEl = el
                  el.style.setProperty("field-sizing", "content")
                }}
                type="text"
                spellcheck={false}
                class="min-w-0 max-w-full p-0 bg-transparent outline-none"
                classList={{ "cursor-text": !!props.editablePath && !previewBlocked() }}
                style={{
                  ...addressTextStyle,
                  // 0 1 auto — 폭이 모자라면 호스트보다 경로가 먼저 줄고, 넘치는 만큼 말줄임된다.
                  // 0 0 auto 면 긴 경로가 pill 을 그대로 밀어내 양끝이 잘린 채 보인다.
                  flex: "0 1 auto",
                  "min-width": "1ch",
                  "text-overflow": "ellipsis",
                }}
                value={displayValue()}
                readOnly={!props.editablePath || previewBlocked()}
                aria-label={language.t("common.address")}
                onFocus={(e) => {
                  if (!props.editablePath || previewBlocked()) return
                  setDraft(props.path ?? "")
                  setEditing(true)
                  e.currentTarget.select()
                }}
                onInput={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    commit()
                    inputEl?.blur()
                  } else if (e.key === "Escape") {
                    e.preventDefault()
                    setEditing(false)
                    inputEl?.blur()
                  }
                }}
                onBlur={() => setEditing(false)}
              />
            </div>
          </div>
          <button
            type="button"
            class={ghostBtn + " !size-5"}
            classList={{ "opacity-50": previewInactive() }}
            aria-label={language.t("common.refresh")}
            disabled={previewBlocked()}
            onClick={() => props.onReload()}
          >
            <Icon name="refresh" size="small" />
          </button>
        </div>
      </div>

      {/* 우 그룹 — 시안 SafariChrome: 외부 연동 + (에러 시)오류 + 새 탭 + 주소 복사.
          380px 미만에서는 오류 버튼만 남기고 나머지를 ⋯ 메뉴로 접는다(오류는 중요도상 항상 밖에). */}
      <div class="flex shrink-0 items-center justify-end gap-1">
        <button
          type="button"
          class={
            ghostBtn +
            " !w-auto gap-1.5 px-2 text-11-medium text-text-strong whitespace-nowrap @max-[380px]/chrome:hidden"
          }
          onClick={openEnvKeys}
          aria-label={language.t("command.env.keys")}
          title={language.t("command.env.keys.description")}
        >
          <Icon name="plug" size="small" />
          {/* 라벨은 가장 넓은 요소 — 520px 미만에서 아이콘+배지만 남긴다(aria-label 로 이름은 유지). */}
          <span class="@max-[520px]/chrome:hidden">{language.t("command.env.keys")}</span>
          <Show when={envCount() > 0}>
            <span
              class="inline-flex items-center justify-center min-w-[15px] h-[15px] px-1 rounded-full bg-surface-success-strong text-white font-mono text-[9.5px] font-bold leading-none"
              aria-label={language.t("command.env.keys.badge", { count: envCount() })}
            >
              {envCount()}
            </span>
          </Show>
        </button>
        <Show when={github()}>
          <button
            type="button"
            class={
              ghostBtn +
              " !w-auto gap-1.5 px-2 text-11-medium text-text-strong whitespace-nowrap @max-[380px]/chrome:hidden"
            }
            onClick={openGitHub}
            aria-label={language.t("command.github")}
            title={language.t("command.github.description")}
          >
            <Icon name="github" size="small" />
            <span class="@max-[520px]/chrome:hidden">{language.t("command.github")}</span>
          </button>
        </Show>
        <Show when={props.showErrorButton}>
          <button
            type="button"
            aria-label={language.t("session.preview.clientError.reopen")}
            aria-expanded={props.errorOpen}
            onClick={() => props.onToggleError?.()}
            class="inline-flex h-6 items-center gap-1 rounded-md border border-critical-base bg-surface-critical-base px-1.5 text-icon-critical-base transition-colors hover:border-critical-hover"
          >
            <Icon name="warning" size="small" class="text-icon-critical-base" />
            <Show when={(props.errorCount ?? 0) > 1}>
              <span class="text-12-regular">{props.errorCount}</span>
            </Show>
          </button>
        </Show>
        <button
          type="button"
          class={ghostBtn + " @max-[380px]/chrome:hidden"}
          disabled={previewBlocked()}
          aria-label={language.t("common.openInNewTab")}
          onClick={openInNewTab}
        >
          <Icon name="external-link" size="small" />
        </button>
        <button
          type="button"
          class={ghostBtn + " @max-[380px]/chrome:hidden"}
          classList={{ "text-icon-success-base": copied() }}
          disabled={previewBlocked()}
          aria-label={language.t("common.copy")}
          onClick={copyAddress}
        >
          <Icon name={copied() ? "check-small" : "copy"} size="small" />
        </button>
        {/* 좁을 때만 나타나는 오버플로 메뉴 — 위 세 버튼과 같은 동작을 담는다.
            메뉴 내용은 Portal 로 빠져나가 컨테이너 쿼리가 닿지 않으므로, 트리거 쪽만 티어로 토글한다. */}
        <div class="hidden @max-[380px]/chrome:block">
          <Menu gutter={4} placement="bottom-end">
            <Menu.Trigger
              as={IconButton}
              icon="dot-grid"
              variant="ghost"
              size="small"
              class="size-6 rounded-md"
              aria-label={language.t("common.moreOptions")}
            />
            <Menu.Portal>
              <Menu.Content>
                <Menu.Item onSelect={openEnvKeys}>
                  {language.t("command.env.keys")}
                  <Show when={envCount() > 0}> ({envCount()})</Show>
                </Menu.Item>
                <Show when={github()}>
                  <Menu.Item onSelect={openGitHub}>{language.t("command.github")}</Menu.Item>
                </Show>
                <Menu.Item disabled={previewBlocked() || !props.url} onSelect={openInNewTab}>
                  {language.t("common.openInNewTab")}
                </Menu.Item>
                <Menu.Item disabled={previewBlocked() || !props.url} onSelect={copyAddress}>
                  {language.t("common.copy")}
                </Menu.Item>
              </Menu.Content>
            </Menu.Portal>
          </Menu>
        </div>
      </div>
    </div>
  )
}
