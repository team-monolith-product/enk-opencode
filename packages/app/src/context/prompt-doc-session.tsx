import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js"
import { createStore } from "solid-js/store"
import { showToast } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useSDK } from "@/context/sdk"
import { useGlobalSDK } from "@/context/global-sdk"
import { useSync } from "@/context/sync"
import { usePrompt } from "@/context/prompt"
import { useSettings } from "@/context/settings"
import { useClientEnv } from "@/context/client-env"
import { useLanguage } from "@/context/language"
import { useParentParams } from "@/context/parent-params"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createPromptDoc, type PromptDocConfig } from "@/components/prompt-input/doc"
import { attachmentUsage } from "@/components/prompt-input/attachments"
import { sessionBusy } from "@/components/prompt-input/composer-state"
import {
  connectSubmit,
  respondSubmit,
  startClearSubmit,
  startStopSubmit,
  type DocSubmitState,
} from "@/components/prompt-input/doc-submit"
import { DialogDocSubmit } from "@/components/doc-submit/dialog-doc-submit"
import { startRtcKeepalive } from "@/utils/rtc-keepalive"
import { SessionClearVote } from "@/utils/session-clear-vote"

export type PromptMode = "normal" | "shell" | "doc"

/**
 * Session-scoped owner of the collaborative prompt doc.
 *
 * Everything that decides "who is taking part in this session" lives here rather than in the
 * composer: the doc handle (sync + awareness + undo history), the actor identity, the consent
 * vote socket, and the consent dialog itself. The composer unmounts whenever a question or a
 * permission request takes over the dock — if it owned these, every question would drop this
 * client out of the participant set, and whoever pressed 전송/중지 first after answering would be
 * judged "alone" and skip the consent vote entirely. Hoisting them to the session keeps the
 * participant set honest across docks, and lets a participant still watching a question receive
 * (and answer) someone else's consent dialog.
 */
export type PromptDocSession = {
  doc: ReturnType<typeof createPromptDoc>
  /** Composer mode. Owned here so switching docks (question/permission) never resets it. */
  mode: Accessor<PromptMode>
  setMode: (mode: PromptMode) => void
  /** True while a run is in flight — the same signal the composer's stop affordance uses. */
  working: Accessor<boolean>
  /** Start (or fall back to a direct abort of) the shared stop of the in-flight response. */
  requestStop: () => Promise<void>
  /**
   * 세션 지우기 합의를 시작한다. 지우기는 되돌릴 수 없고 함께 보던 사람들의 대화까지 사라지므로,
   * 전송·중지와 같은 동의를 거친다. 혼자면 투표할 상대가 없으니 false 를 돌려주고, 호출한 쪽이
   * 기존 확인창 경로로 지운다.
   */
  requestClear: () => Promise<boolean>
  /** 진행 중인 합의가 있는지. 투표가 도는 동안에는 다른 합의를 시작할 수 없다. */
  votePending: Accessor<boolean>
  /** Render/refresh the consent dialog for a vote state received from the server. */
  showApproval: (state: DocSubmitState) => void
  /** Session whose send is currently owned by a consent vote (composer skips its local finish). */
  approvalSession: Accessor<string | undefined>
  setApprovalSession: (sessionID: string | undefined) => void
  /**
   * The composer registers what it alone can do: build+send a prompt (the doc editor's submit key
   * routes here) and run the local abort side effects (queued followups, todos).
   */
  setHandlers: (handlers: { submit?: () => void; abort?: () => void | Promise<void> }) => void
}

const PromptDocSessionContext = createContext<PromptDocSession>()

export function usePromptDocSession() {
  const value = useContext(PromptDocSessionContext)
  if (!value) throw new Error("usePromptDocSession must be used within PromptDocSessionProvider")
  return value
}

export function createPromptDocSession(): PromptDocSession {
  const sdk = useSDK()
  const globalSDK = useGlobalSDK()
  const sync = useSync()
  const prompt = usePrompt()
  const settings = useSettings()
  const env = useClientEnv()
  const language = useLanguage()
  const dialog = useDialog()
  const parentParams = useParentParams()
  const { params } = useSessionLayout()

  // `?readonly=true` makes this client a pure observer (captured once at module load, so it is stable).
  const readonly = parentParams.readonly
  const submitConfig = () => settings.keybinds.get("prompt.submit") ?? env.promptSubmitKey()
  const stopConfig = () => settings.keybinds.get("prompt.stop") ?? "escape"

  const [mode, setMode] = createSignal<PromptMode>("doc")
  const handlers: { submit?: () => void; abort?: () => void | Promise<void> } = {}

  const status = createMemo(() => sync.data.session_status[params.id ?? ""] ?? { type: "idle" as const })
  const working = createMemo(() => {
    const id = params.id
    return sessionBusy(status(), id ? sync.data.message[id] : undefined)
  })

  const [docConfig, setDocConfig] = createStore<PromptDocConfig>({
    sessionID: params.id,
    url: sdk.url,
    directory: sdk.directory,
    submitKey: submitConfig(),
    stopKey: stopConfig(),
    user: parentParams.user[0],
    readonly,
  })
  createEffect(() => {
    setDocConfig({
      sessionID: params.id,
      url: sdk.url,
      directory: sdk.directory,
      submitKey: submitConfig(),
      stopKey: stopConfig(),
      user: parentParams.user[0],
      readonly,
    })
  })

  const doc = createPromptDoc({
    config: docConfig,
    client: sdk.client,
    onSubmit: () => handlers.submit?.(),
    // The doc and the composer spend one shared per-prompt attachment budget: a doc-mode send ships
    // the doc's blocks together with whatever image parts the prompt still carries. Handing the doc
    // the composer's usage is what stops an image added on one side from being free on the other.
    baseUsage: () => attachmentUsage(prompt.current()),
    // Esc in the doc editor: swallow BlockSuite's native handling always; stop only while a run is
    // in flight (requestStop drives the shared stop-consent vote in collaborative docs).
    onStop: () => {
      if (working()) void requestStop()
    },
    onUploadFailed: (name) => {
      showToast({
        title: language.t("prompt.toast.docUploadFailed.title"),
        description: language.t("prompt.toast.docUploadFailed.description", { name }),
      })
    },
  })
  // The session owns the final teardown; the composer only mounts/detaches the editor DOM.
  onCleanup(() => doc.dispose())

  createEffect((prev) => {
    const id = params.id
    if (prev === id) return id
    doc.reset()
    // 보던 세션이 지워지면 모두 새 세션으로 옮겨간다. 그때 남아 있던 동의창은 사라진 세션의 투표라,
    // 새 대화 위에 떠서 죽은 세션으로 요청을 보내게 된다.
    closeApproval()
    return id
  })

  createEffect(() => {
    const id = params.id
    if (!id) return
    void doc.refresh(id)
  })

  // Keep this tab's JS alive for the whole collaborative doc session — always on, not toggled by
  // visibility or participant count (a frozen tab cannot re-enable itself when someone joins later,
  // and full-window occlusion flips the hidden state without a reliable event on every platform).
  // This is what lets a backgrounded collaborator keep ponging (stays out of 나감) and keep
  // receiving vote casts. Readonly spectators don't participate, so they skip it.
  createEffect(() => {
    if (mode() !== "doc" || readonly) return
    const stop = startRtcKeepalive()
    onCleanup(stop)
  })

  // The consent socket IS this client's membership on the server (`peers` → targets()). It stays up
  // for as long as the session is open, independent of which dock is currently on screen.
  createEffect(() => {
    const sessionID = params.id
    const docID = doc.docID()
    const actorID = doc.actorID()
    if (mode() !== "doc" || !sessionID || !docID || !actorID) return
    // A readonly viewer connects observer-only: it WATCHES the consent vote (spectator dialog) but the
    // server keeps observers out of `peers`/targets(), so it is never counted as a 동시전송 target.
    const stop = connectSubmit({
      baseUrl: sdk.url,
      directory: sdk.directory,
      sessionID,
      docID,
      actorID,
      observer: readonly,
      event: (event) => showApproval(event.state),
    })
    onCleanup(stop)
  })

  /**
   * Wipe everything the composer carried into the send that just landed.
   *
   * The solo path does this in submit.ts (clearContext + clearInput). The consent path returns early
   * there — approve() owns the send — so the same clearing has to happen here instead, and it is
   * driven by the send actually landing rather than by the local request: a cancelled or expired vote
   * must leave the typed prompt and its attachments exactly where they were.
   *
   * prompt.reset() matters as much as clearContext(): in doc mode the text lives in the doc, but
   * prompt.current() still holds the non-text parts a drop adds (prompt-input's dropPath writes a
   * file part alongside the doc reference). Left behind, those parts ride along on every later send,
   * and a file part is inlined by the server on each one — so the same file's contents get re-sent,
   * and re-billed, forever.
   */
  const clearComposer = () => {
    for (const item of prompt.context.items()) {
      prompt.context.remove(item.key)
    }
    prompt.reset()
  }

  createEffect(() => {
    const id = params.id
    if (!id) return
    void globalSDK.event.start()
    const unsub = globalSDK.event.on(sdk.directory, (event) => {
      const item = event as {
        type: string
        properties: { sessionID: string; docID: string; clientID?: string; init?: boolean }
      }
      if (item.type !== "doc.prompt.rotated") return
      const props = item.properties
      if (props.sessionID !== id) return
      if (props.clientID === doc.clientID) return
      // The prompt doc only ever rotates right after a prompt was sent, so this doubles as the
      // backstop for a 'sent' cast we never saw: the server's replay is keyed by the submit's docID,
      // so a client whose socket was down at cast time reconnects onto the *rotated* doc and misses
      // it. Idempotent with the cast path — clearing an already-cleared composer is a no-op. Only in
      // doc mode: someone who stepped out to the plain composer never had a submit socket to miss a
      // cast on, and their own draft there is not part of the send that just landed.
      if (mode() === "doc") clearComposer()
      void doc.pivot(props.sessionID, props.docID, { init: props.init ?? false }).then(() => {
        if (mode() === "doc") return
        setMode("doc")
      })
    })
    onCleanup(unsub)
  })

  const [approval, setApproval] = createSignal<DocSubmitState | undefined>()
  const [approvalSession, setApprovalSession] = createSignal<string | undefined>()
  let approvalID: string | undefined
  let finalizedID: string | undefined

  // 투표가 도는 동안에는 다른 합의를 시작할 수 없다(서버도 지우기 합의에 대해 같은 규칙을 건다).
  const votePending = createMemo(() => approval()?.status === "pending")

  const closeApproval = () => {
    dialog.close()
    approvalID = undefined
    setApproval(undefined)
  }
  const showApproval = (state: DocSubmitState) => {
    const actorID = doc.actorID()
    if (!actorID) return
    // No membership gate here: the server casts only to connected peers and joins any connected
    // non-member to a pending vote (dynamic membership), so every state we receive is ours to
    // render. The old gate silently dropped casts when membership drifted — the "dialog never
    // appeared" bug.
    // Terminal states are handled exactly once per submit: a server replay on reconnect (or a
    // duplicate cast) for an already-resolved submit must not re-clear context or re-open a dialog.
    if (state.status !== "pending") {
      if (finalizedID === state.submitID) return
      finalizedID = state.submitID
      // A 'stop' vote shows no terminal screen — any resolution just closes. Stopping the response
      // and the response finishing on its own are the same end state, so there's nothing to show:
      // on approval the server already cancelled the run; a reject/expire simply does nothing.
      if (state.targetKind === "stop") {
        if (approvalID === state.submitID) closeApproval()
        return
      }
    }
    if (state.status === "sent") {
      // Only a doc send reaches this — a 'stop' vote returned above, and question votes run on their
      // own socket (session-question-dock) — so the composer is safe to clear wholesale.
      clearComposer()
      if (approvalID === state.submitID) closeApproval()
      return
    }
    setApproval(state)
    if (approvalID === state.submitID) return
    approvalID = state.submitID
    dialog.show(
      () => (
        <DialogDocSubmit
          state={approval}
          actorID={actorID}
          spectator={readonly}
          kind={approval()?.targetKind === "stop" || approval()?.targetKind === "clear" ? (approval()!.targetKind as "stop" | "clear") : "doc"}
          sdk={{ url: sdk.url, directory: sdk.directory, client: sdk.client }}
          approve={() => {
            const current = approval()
            if (!current) return
            void respondSubmit({
              baseUrl: sdk.url,
              directory: sdk.directory,
              sessionID: current.sessionID,
              submitID: current.submitID,
              actorID,
              action: "approve",
            })
              .then(setApproval)
              .catch(() =>
                showToast({
                  title: language.t("docSubmit.toast.approveFailed"),
                  description: language.t("common.requestFailed"),
                }),
              )
          }}
          cancel={() => {
            const current = approval()
            if (!current) return
            void respondSubmit({
              baseUrl: sdk.url,
              directory: sdk.directory,
              sessionID: current.sessionID,
              submitID: current.submitID,
              actorID,
              action: "cancel",
            })
              .then(setApproval)
              .catch(() =>
                showToast({
                  title: language.t("docSubmit.toast.cancelFailed"),
                  description: language.t("common.requestFailed"),
                }),
              )
          }}
          exclude={() => {
            const current = approval()
            if (!current) return
            void respondSubmit({
              baseUrl: sdk.url,
              directory: sdk.directory,
              sessionID: current.sessionID,
              submitID: current.submitID,
              actorID,
              action: "exclude",
            })
              .then(setApproval)
              .catch(() =>
                showToast({
                  title: language.t("docSubmit.toast.sendFailed"),
                  description: language.t("common.requestFailed"),
                }),
              )
          }}
          close={closeApproval}
          onExpire={() => {
            // Server terminal cast never arrived — drive the same "expired" transition locally so the
            // dialog resolves instead of freezing at 0초. Routed through showApproval so finalizedID is
            // set: a late server cast for this submit is then ignored rather than re-opening the dialog.
            const current = approval()
            if (current?.status === "pending") showApproval({ ...current, status: "expired" })
          }}
        />
      ),
      () => {
        const current = approval()
        if (current?.status === "pending") {
          approvalID = undefined
          window.setTimeout(() => {
            const next = approval()
            if (next?.status === "pending") showApproval(next)
          }, 120)
          return
        }
        approvalID = undefined
        setApproval(undefined)
      },
    )
  }

  // Stopping the AI mid-response is a shared action in a collaborative doc: gate it behind the same
  // consent vote as sending. Solo (or non-doc) falls straight through to a direct abort. The dialog
  // is driven by the vote, so it stays up even if the response finishes first; on resolution it just
  // closes (server already cancelled on approval, or nothing on reject — same end state either way).
  const requestStop = async () => {
    const sessionID = params.id
    const docID = doc.docID()
    const actorID = doc.actorID()
    const abort = async () => {
      if (handlers.abort) {
        await handlers.abort()
        return
      }
      // The composer is not mounted (a question/permission dock owns the screen), so there is no
      // local queue to unwind — cancel the run directly.
      if (sessionID) await sdk.client.session.abort({ sessionID }).catch(() => {})
    }
    if (mode() !== "doc" || !sessionID || !docID || !actorID) {
      await abort()
      return
    }
    const list = doc.actors()
    const ids = Array.from(new Set([actorID, ...list.map((item) => item.actorID)]))
    if (ids.length <= 1) {
      await abort()
      return
    }
    const names: Record<string, string> = {}
    for (const item of list) {
      const name = item.name?.trim()
      if (name && name !== item.actorID) names[item.actorID] = name
    }
    try {
      const state = await startStopSubmit({
        baseUrl: sdk.url,
        directory: sdk.directory,
        sessionID,
        docID,
        actorID,
        names,
      })
      setApprovalSession(sessionID)
      showApproval(state)
    } catch {
      // Never fall through to a solo abort here: peers exist, so stopping without their consent is
      // exactly what the vote is for. Surface the failure and leave the run alone.
      showToast({
        title: language.t("docSubmit.toast.stopRequestFailed"),
        description: language.t("common.requestFailed"),
      })
    }
  }

  /**
   * 세션 지우기도 함께 쓰는 행동이다. 누군가 혼자 누르면 나머지가 보던 대화가 예고 없이 사라지고,
   * 되돌릴 수도 없다. 그래서 전송·중지와 같은 동의 투표를 거친다 — 합의가 서면 서버가 실행을 끊고
   * 세션을 보관한 뒤 대체 세션을 만들고, 모두 그 새 세션으로 함께 옮겨간다.
   *
   * 혼자(또는 doc 모드가 아닐 때)는 물어볼 상대가 없으니 false 를 돌려준다 — 호출한 쪽이 기존
   * 확인창 경로로 지운다.
   */
  const requestClear = async () => {
    const sessionID = params.id
    const docID = doc.docID()
    const actorID = doc.actorID()
    if (mode() !== "doc" || !sessionID || !docID || !actorID) return false

    const list = doc.actors()
    const ids = Array.from(new Set([actorID, ...list.map((item) => item.actorID)]))
    if (ids.length <= 1) return false

    const names: Record<string, string> = {}
    for (const item of list) {
      const name = item.name?.trim()
      if (name && name !== item.actorID) names[item.actorID] = name
    }
    try {
      const state = await startClearSubmit({
        baseUrl: sdk.url,
        directory: sdk.directory,
        sessionID,
        docID,
        actorID,
        names,
      })
      setApprovalSession(sessionID)
      showApproval(state)
    } catch {
      // 동의 없이 혼자 지우는 길로 새면 안 된다. 다른 투표가 도는 중이라 서버가 거절했을 수도 있다.
      showToast({
        title: language.t("docSubmit.toast.clearRequestFailed"),
        description: language.t("common.requestFailed"),
      })
    }
    return true
  }

  // 지우기 확인창은 앱 셸에 있어 이 컨텍스트에 닿지 않는다. 지금 열린 세션이 자기 요청 함수를 걸어
  // 두면, 확인창이 "지우기" 를 누른 순간 동의를 먼저 구할 수 있다.
  createEffect(() => {
    const id = params.id
    if (!id) return
    onCleanup(SessionClearVote.register(id, requestClear))
  })

  return {
    doc,
    mode,
    setMode,
    working,
    requestStop,
    requestClear,
    votePending,
    showApproval,
    approvalSession,
    setApprovalSession,
    setHandlers: (next) => {
      handlers.submit = next.submit
      handlers.abort = next.abort
    },
  }
}

export function PromptDocSessionProvider(props: ParentProps<{ value: PromptDocSession }>) {
  return <PromptDocSessionContext.Provider value={props.value}>{props.children}</PromptDocSessionContext.Provider>
}
