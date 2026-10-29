import { Show, createEffect, createMemo, onCleanup, onMount, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { useSpring } from "@opencode/ui/motion-spring"
import { useData } from "@/runtime/server/current"
import { useLanguage } from "@/runtime/i18n/language"
import { useJitda } from "../context"
import { createSessionRequestModel } from "@/session/requests/model"
import { SessionPermissionDock } from "@/session/requests/session-permission-dock"
import { SessionRunningMenu } from "@/session/header/session-running-menu"
import type { SessionQueueView } from "@/session/composer/queue"
import { sessionTreeIDs } from "@/session/requests/session-request-tree"
import type { SessionModel } from "@/session/model"
import { EnvRequestDock, createEnvRequests } from "../env/env-request-dock"
import { registerJitdaDocView } from "../timeline/host"
import { DocMessage } from "./blocksuite/doc-message"
import { JitdaPromptInput } from "./prompt/composer"
import { SessionQuestionDock } from "./question-dock"
import { JitdaQueuePanel } from "./queue-panel"
import { createPromptDocSession, PromptDocSessionProvider } from "./session"

registerJitdaDocView(DocMessage)

export { DocMessage as JitdaDocMessage }

const shellMin = 200

function shellMax(anchorBottom: number) {
  if (typeof window === "undefined") return 600
  return Math.min(window.innerHeight * 0.7, window.innerHeight - anchorBottom)
}

function sessionRow(shell?: HTMLElement | null) {
  const session = shell?.closest('[data-component="codle-session"]')
  if (!session) return undefined
  for (const child of session.children) {
    if (child instanceof HTMLElement && child.classList.contains("flex-1")) return child
  }
  return undefined
}

function layoutRowRect(shell?: HTMLElement | null) {
  const row = sessionRow(shell)
  if (row) return row.getBoundingClientRect()
  const session = shell?.closest('[data-component="codle-session"]')
  if (session) return session.getBoundingClientRect()
  return undefined
}

/** 확대된 입력창의 오른쪽 끝: 세션 행(대화 + 간격 + 미리보기). */
function layoutRight(shell?: HTMLElement | null) {
  if (typeof window === "undefined") return 0
  return layoutRowRect(shell)?.right ?? window.innerWidth
}

function shellWidth(left: number, shell?: HTMLElement | null) {
  if (typeof window === "undefined") return 480
  return Math.max(shellMin, layoutRight(shell) - left)
}

function clampShell(value: number, anchorBottom: number) {
  return Math.min(shellMax(anchorBottom), Math.max(shellMin, value))
}

function SessionComposerShell(
  props: ParentProps<{
    expanded: boolean
    centered?: boolean
    anchorLeft: number
    anchorBottom: number
    shellWidth?: number
    shellHeight?: number
    shellMin: number
    shellRef?: (el: HTMLDialogElement) => void
  }>,
) {
  let dialog: HTMLDialogElement | undefined

  // show() 는 top layer 를 쓰지 않는다(showModal 만 쓴다).
  createEffect(() => {
    const el = dialog
    if (!el) return
    if (props.expanded) {
      if (!el.open) {
        // dialog 의 focusing steps 가 show() 때 내부 에디터의 포커스를 빼앗는다. 그러면 곧바로 다시 접히므로 되돌린다.
        const prev = document.activeElement
        el.show()
        if (prev instanceof HTMLElement && prev !== document.activeElement && el.contains(prev)) {
          prev.focus({ preventScroll: true })
        }
      }
      return
    }
    if (el.open) el.close()
  })

  onCleanup(() => {
    if (dialog?.open) dialog.close()
  })

  const width = () => `${props.shellWidth ?? Math.max(props.shellMin, window.innerWidth - props.anchorLeft)}px`

  return (
    <dialog
      ref={(el) => {
        dialog = el
        props.shellRef?.(el)
      }}
      data-component={props.expanded ? "session-composer-expanded" : "session-composer-shell"}
      classList={{
        "pointer-events-auto": true,
        "relative w-full px-3": !props.expanded,
        "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": props.centered && !props.expanded,
        "fixed flex flex-col px-3": props.expanded,
      }}
      style={
        props.expanded
          ? {
              left: `${props.anchorLeft}px`,
              bottom: `${props.anchorBottom}px`,
              width: width(),
              height: `${props.shellHeight ?? props.shellMin}px`,
            }
          : undefined
      }
    >
      {props.children}
    </dialog>
  )
}

/**
 * 짓다 협업 컴포저(타임라인 아래 왼쪽 열 전체). V1 SessionComposerRegion 운영 경로.
 *
 * - `session`: V2 세션 화면 모델. 세션 id·실행 중 여부(`data.working`)를 읽는다.
 * - `centered`: 대화 열이 가운데 정렬일 때(V1 centered). 운영 레이아웃은 false.
 * - `scroller`: 타임라인 스크롤 요소. 질문 도크가 화면을 넘지 않게 높이를 잴 때 쓴다.
 * - `onSubmit`: 프롬프트를 혼자 보낼 때(V1 resumeScroll). `onResponseSubmit`: 질문·권한·값 요청에 답했을 때.
 * - `setPromptDockRef`: 도크 루트(V2 timeline.view.setDockRef). `onExpandedChange`: 입력창 확대 여부(V1 composerLift).
 *
 * JitdaProvider 안에서 렌더해야 한다.
 */
export function JitdaComposerRegion(props: {
  session: SessionModel
  centered?: boolean
  scroller?: () => HTMLElement | undefined
  onSubmit?: () => void
  onResponseSubmit?: () => void
  setPromptDockRef?: (el: HTMLDivElement) => void
  onExpandedChange?: (expanded: boolean) => void
  queue?: SessionQueueView
}) {
  const data = useData()
  const jitda = useJitda()
  const language = useLanguage()
  const requests = createSessionRequestModel()
  const env = createEnvRequests()
  const promptDoc = createPromptDocSession({ session: props.session })

  const sessionID = () => props.session.identity.sessionID()
  const responded = () => props.onResponseSubmit?.()

  const questionRequest = requests.questionRequest
  const permissionRequest = requests.permissionRequest
  const envRequest = createMemo(() => env.pick(sessionTreeIDs(data.session.list(), sessionID())))
  const blocked = createMemo(() => !!sessionID() && (!!questionRequest() || !!permissionRequest() || !!envRequest()))

  const [store, setStore] = createStore({
    expanded: false,
    shellHeight: undefined as number | undefined,
    anchorLeft: 0,
    anchorBottom: 0,
    shellWidth: undefined as number | undefined,
    shellRight: undefined as number | undefined,
    fromWidth: 0,
    fromHeight: 0,
  })
  let shell: HTMLDialogElement | undefined
  let input: HTMLDivElement | undefined

  // 확대/축소 300ms. relative↔fixed 전환은 CSS 로 보간되지 않아 진행도로 폭·높이를 직접 보간한다.
  const expandSpring = useSpring(() => (store.expanded ? 1 : 0), { visualDuration: 0.3, bounce: 0 })
  const expandValue = createMemo(() => Math.max(0, Math.min(1, expandSpring())))
  const floating = createMemo(() => store.expanded || expandValue() > 0.001)
  const targetWidth = () => {
    const right = store.shellRight ?? (typeof window === "undefined" ? store.anchorLeft + shellMin : window.innerWidth)
    return Math.max(shellMin, right - store.anchorLeft)
  }
  const targetHeight = () => store.shellHeight ?? shellMin
  const animWidth = createMemo(() => store.fromWidth + (targetWidth() - store.fromWidth) * expandValue())
  const animHeight = createMemo(() => store.fromHeight + (targetHeight() - store.fromHeight) * expandValue())

  const measure = () => {
    const el = shell
    if (!el) return { height: shellMin, left: 0, bottom: 0, width: shellMin }
    const rect = el.getBoundingClientRect()
    return {
      height: rect.height,
      left: rect.left,
      bottom: typeof window === "undefined" ? 0 : window.innerHeight - rect.bottom,
      width: rect.width,
    }
  }

  const syncShellBounds = () => {
    const right = layoutRight(shell)
    setStore({ shellRight: right, shellWidth: shellWidth(store.anchorLeft, shell) })
  }

  const expand = (opts?: { initialScale?: number }) => {
    // 질문·권한 도크에는 확대 레이아웃이 없다.
    if (blocked()) return
    const box = measure()
    const right = layoutRight(shell)
    const initial = box.height * (opts?.initialScale ?? 1)
    setStore({
      expanded: true,
      fromWidth: box.width,
      fromHeight: box.height,
      shellHeight: clampShell(store.shellHeight ?? initial, box.bottom),
      anchorLeft: box.left,
      anchorBottom: box.bottom,
      shellRight: right,
      shellWidth: Math.max(shellMin, right - box.left),
    })
  }

  const collapse = () => {
    // shellHeight 는 다음 확대 높이로 기억해 둔다.
    setStore({ expanded: false, shellRight: undefined, shellWidth: undefined })
  }

  createEffect(() => {
    if (blocked() && store.expanded) collapse()
  })

  const resize = (height: number) => {
    setStore("shellHeight", clampShell(height, store.anchorBottom))
  }

  createEffect(() => {
    if (!store.expanded) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      collapse()
    }
    document.addEventListener("keydown", onKey, true)
    onCleanup(() => document.removeEventListener("keydown", onKey, true))
  })

  createEffect(() => {
    if (!store.expanded) return
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => input?.focus())
    })
    onCleanup(() => cancelAnimationFrame(id))
  })

  onMount(() => {
    const onWindowResize = () => {
      if (!store.expanded) return
      syncShellBounds()
      if (!store.shellHeight) return
      setStore("shellHeight", (h) => (h === undefined ? h : clampShell(h, store.anchorBottom)))
    }
    window.addEventListener("resize", onWindowResize)
    onCleanup(() => window.removeEventListener("resize", onWindowResize))
  })

  createEffect(() => {
    if (!store.expanded) return
    syncShellBounds()
    const observer = new ResizeObserver(() => syncShellBounds())
    const column =
      shell?.closest('[data-component="codle-session-column"]') ?? shell?.closest('[data-slot="session-chat-panel"]')
    const row = sessionRow(shell)
    const side = document.getElementById("review-panel")
    if (column) observer.observe(column)
    if (row) observer.observe(row)
    if (side) observer.observe(side)
    onCleanup(() => observer.disconnect())
  })

  createEffect(() => {
    props.onExpandedChange?.(store.expanded)
  })

  onCleanup(() => props.onExpandedChange?.(false))

  const actor = promptDocSessionActor(promptDoc)

  return (
    <PromptDocSessionProvider value={promptDoc}>
      <div
        ref={props.setPromptDockRef}
        data-component="session-prompt-dock"
        data-variant="codle"
        data-expanded={store.expanded ? "true" : "false"}
        class="shrink-0 w-full pb-4 flex flex-col justify-center items-center pointer-events-none"
      >
        <Show when={floating()}>
          <div
            data-component="session-composer-spacer"
            class="w-full px-3 pointer-events-none"
            classList={{
              "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": props.centered,
            }}
            aria-hidden="true"
            style={{ height: `${animHeight()}px` }}
          />
        </Show>

        <SessionComposerShell
          expanded={floating()}
          centered={props.centered}
          anchorLeft={store.anchorLeft}
          anchorBottom={store.anchorBottom}
          shellWidth={animWidth()}
          shellHeight={animHeight()}
          shellMin={shellMin}
          shellRef={(el) => {
            shell = el
          }}
        >
          <div classList={{ "relative flex min-h-0 flex-1 flex-col": floating() }}>
            <Show when={questionRequest()} keyed>
              {(request) => (
                <div>
                  <SessionQuestionDock request={request} onSubmit={responded} scroller={props.scroller} />
                </div>
              )}
            </Show>

            <Show when={envRequest()} keyed>
              {(request) => (
                <div>
                  <EnvRequestDock
                    request={request}
                    actorID={actor.id}
                    actorName={actor.name}
                    actorColor={actor.color}
                    onSubmit={responded}
                  />
                </div>
              )}
            </Show>

            <Show when={permissionRequest()} keyed>
              {(request) => (
                <div>
                  <SessionPermissionDock
                    request={request}
                    responding={requests.permissionResponding()}
                    onDecide={(response) => {
                      responded()
                      requests.decide(response)
                    }}
                  />
                </div>
              )}
            </Show>

            <Show when={!floating()}>
              <div data-component="jitda-running" class="pointer-events-auto flex justify-end empty:hidden">
                <SessionRunningMenu
                  sessionID={sessionID()}
                  owner={requests.background.running.sessionID()}
                  blocking={requests.background.running.blocking()}
                  tasks={requests.background.running.tasks()}
                />
              </div>
              <JitdaQueuePanel queue={props.queue} />
              <Show when={props.session.data.revertMessageID() && !jitda.readonly()}>
                <div data-component="jitda-revert-banner" class="pointer-events-auto">
                  <span>{language.t("jitda.revert.banner")}</span>
                  <button
                    type="button"
                    data-action="jitda-revert-redo"
                    disabled={promptDoc.votePending()}
                    onClick={() => void promptDoc.requestRevert({ redo: true })}
                  >
                    {language.t("jitda.revert.redo")}
                  </button>
                </div>
              </Show>
            </Show>

            <Show when={!blocked()}>
              <div classList={{ "flex min-h-0 flex-1 flex-col": floating() }}>
                <div
                  classList={{
                    relative: !floating(),
                    "flex min-h-0 flex-1 flex-col": floating(),
                  }}
                >
                  <JitdaPromptInput
                    ref={(el) => {
                      input = el
                    }}
                    expanded={floating()}
                    onComposerExpand={expand}
                    onComposerCollapse={collapse}
                    composerShell={
                      floating()
                        ? {
                            size: store.shellHeight ?? shellMin,
                            min: shellMin,
                            max: shellMax(store.anchorBottom),
                            onResize: resize,
                          }
                        : undefined
                    }
                    onSubmit={props.onSubmit}
                  />
                </div>
              </div>
            </Show>
          </div>
        </SessionComposerShell>
      </div>
    </PromptDocSessionProvider>
  )
}

function promptDocSessionActor(session: ReturnType<typeof createPromptDocSession>) {
  return {
    id: () => session.doc.actorID(),
    name: () => session.doc.actorName(),
    color: () => session.doc.actorColor(),
  }
}
