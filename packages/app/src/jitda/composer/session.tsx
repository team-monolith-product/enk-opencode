import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation, useNavigate } from "@solidjs/router"
import { useDialog } from "@opencode/ui/context/dialog"
import { showToast } from "@opencode/ui/toast"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { useServer } from "@/runtime/server/current"
import { ServerConnection } from "@/runtime/server/registry"
import { sessionHref } from "@/shell/routes/session"
import type { SessionModel } from "@/session/model"
import { useJitda } from "../context"
import { Flags } from "../flags"
import { createDocClient } from "./doc-client"
import { subscribeDocEvents } from "./doc-events"
import {
  connectSubmit,
  respondSubmit,
  startClearSubmit,
  startRevert,
  startStopSubmit,
  type DocSubmitState,
} from "./doc-submit"
import { DialogDocSubmit } from "./doc-submit/dialog-doc-submit"
import { createPromptDoc, type PromptDocConfig } from "./prompt/doc"
import { startRtcKeepalive } from "./util/rtc-keepalive"

export type PromptMode = "normal" | "shell" | "doc"

// 협업 프롬프트 문서·합의 소켓·합의 다이얼로그는 세션이 소유한다. 질문·권한 도크가 컴포저를 가리는 동안에도
// 참여자 집합이 유지돼야, 답한 뒤 처음 누른 사람이 '혼자'로 판정돼 합의를 건너뛰지 않는다.
export type PromptDocSession = {
  sessionID: Accessor<string | undefined>
  doc: ReturnType<typeof createPromptDoc>
  mode: Accessor<PromptMode>
  setMode: (mode: PromptMode) => void
  working: Accessor<boolean>
  requestStop: () => Promise<void>
  /** 같이 쓰는 중이면 지우기 합의를 시작하고 true. 혼자면 false — 호출한 쪽이 바로 지운다. */
  requestClear: () => Promise<boolean>
  /** 이전 턴으로 되돌리기(messageID) 또는 되돌리기 취소(redo). 같이 쓰는 중이면 합의를 거친다. */
  requestRevert: (input: { messageID?: string; redo?: boolean }) => Promise<void>
  /** 확인창 뒤 혼자 지우기: 보관하고 대체(메인) 세션으로 옮겨간다. */
  clear: () => Promise<void>
  votePending: Accessor<boolean>
  showApproval: (state: DocSubmitState) => void
  approvalSession: Accessor<string | undefined>
  setApprovalSession: (sessionID: string | undefined) => void
  /** 문서 모드 드롭으로 함께 실을 파일(V1 프롬프트의 file 파트). 전송이 끝나면 비운다. */
  dropped: Accessor<string[]>
  setDropped: (paths: string[]) => void
  setHandlers: (handlers: { submit?: () => void; abort?: () => void | Promise<void> }) => void
}

const PromptDocSessionContext = createContext<PromptDocSession>()

export function usePromptDocSession() {
  const value = useContext(PromptDocSessionContext)
  if (!value) throw new Error("usePromptDocSession must be used within PromptDocSessionProvider")
  return value
}

export function PromptDocSessionProvider(props: ParentProps<{ value: PromptDocSession }>) {
  return <PromptDocSessionContext.Provider value={props.value}>{props.children}</PromptDocSessionContext.Provider>
}

const REPLACEMENT_RETRY_MS = 1_000

export function createPromptDocSession(input: { session: SessionModel }): PromptDocSession {
  const jitda = useJitda()
  const server = useServer()
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const navigate = useNavigate()
  const location = useLocation()
  const client = createDocClient(jitda.doc)

  const readonly = jitda.readonly()
  const sessionID = () => input.session.identity.sessionID()
  const user = () => {
    const identity = jitda.identity()
    if (!identity) return undefined
    return { id: identity.id, name: identity.name ?? identity.id, color: identity.color }
  }

  const [mode, setMode] = createSignal<PromptMode>("doc")
  const [dropped, setDropped] = createSignal<string[]>([])
  const handlers: { submit?: () => void; abort?: () => void | Promise<void> } = {}

  const working = createMemo(() => input.session.data.working())

  const config = (): PromptDocConfig => ({
    sessionID: sessionID(),
    submitKey: Flags.promptSubmitKey,
    stopKey: "escape",
    user: user(),
    readonly,
  })
  const [docConfig, setDocConfig] = createStore<PromptDocConfig>(config())
  createEffect(() => setDocConfig(config()))

  const doc = createPromptDoc({
    config: docConfig,
    api: jitda.doc,
    client,
    onSubmit: () => handlers.submit?.(),
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
  onCleanup(() => doc.dispose())

  createEffect((prev) => {
    const id = sessionID()
    if (prev === id) return id
    doc.reset()
    // 지워진 세션의 투표 창이 새 대화 위에 남아 죽은 세션으로 요청을 보내지 않게 닫는다.
    closeApproval()
    return id
  })

  createEffect(() => {
    const id = sessionID()
    if (!id) return
    void doc.refresh(id).catch(() => undefined)
  })

  createEffect(() => {
    if (mode() !== "doc" || readonly) return
    const stop = startRtcKeepalive()
    onCleanup(stop)
  })

  // 합의 소켓이 곧 서버가 보는 이 클라이언트의 참여 자격이다. 어느 도크가 떠 있든 세션 내내 붙어 있다.
  createEffect(() => {
    const id = sessionID()
    const docID = doc.docID()
    const actorID = doc.actorID()
    if (mode() !== "doc" || !id || !docID || !actorID) return
    const stop = connectSubmit({
      api: jitda.doc,
      sessionID: id,
      docID,
      actorID,
      observer: readonly,
      event: (event) => showApproval(event.state),
    })
    onCleanup(stop)
  })

  // 합의로 나간 전송도 컴포저를 비운다. 취소·만료된 투표는 입력을 그대로 둬야 하므로 실제 전송에 맞춰 비운다.
  const clearComposer = () => setDropped([])

  createEffect(() => {
    const id = sessionID()
    if (!id) return
    let first = true
    const stop = subscribeDocEvents(jitda.doc, (event) => {
      if (event.type === "server.connected") {
        // 재접속: doc 교체는 이벤트 한 번으로만 알려지고 재생이 없다. 자리를 비운 사이 교체됐다면 되묻는다.
        if (first) {
          first = false
          return
        }
        if (sessionID() !== id) return
        const previous = doc.docID()
        void doc
          .refresh(id)
          .then((next) => {
            if (!next || next === previous) return
            if (mode() === "doc") clearComposer()
          })
          .catch(() => {})
        return
      }
      if (event.type !== "doc.prompt.rotated") return
      const props = event.properties as { sessionID?: string; docID?: string; clientID?: string; init?: boolean }
      if (props.sessionID !== id || !props.docID) return
      if (props.clientID === doc.clientID) return
      // 문서는 전송 직후에만 바뀌므로, 놓친 'sent' 알림의 안전망도 된다.
      if (mode() === "doc") clearComposer()
      void doc.pivot(id, props.docID, { init: props.init ?? false }).then(() => {
        if (mode() === "doc") return
        setMode("doc")
      })
    })
    onCleanup(stop)
  })

  // ── 대체 세션 따라가기(V1 directory-layout followReplacement) ──
  const follow = (removedID: string) => {
    let stopped = false
    const attempt = () => {
      if (stopped || sessionID() !== removedID) return
      jitda.rpc.session
        .main({}, jitda.options())
        .then((value: unknown) => {
          const next = (value as { id?: string } | undefined)?.id
          if (stopped || sessionID() !== removedID) return
          if (!next || next === removedID) {
            setTimeout(attempt, REPLACEMENT_RETRY_MS)
            return
          }
          navigate(`${sessionHref(ServerConnection.key(server.conn), next)}${location.search}${location.hash}`)
        })
        .catch(() => {
          if (!stopped) setTimeout(attempt, REPLACEMENT_RETRY_MS)
        })
    }
    attempt()
    return () => {
      stopped = true
    }
  }

  createEffect(() => {
    const id = sessionID()
    if (!id) return
    let cancel: (() => void) | undefined
    const removed = () => {
      cancel?.()
      cancel = follow(id)
    }
    const offArchived = serverSDK.event.on("session.archived", (event) => {
      if ((event.data as { sessionID?: string }).sessionID === id) removed()
    })
    const offDeleted = serverSDK.event.on("session.deleted", (event) => {
      if ((event.data as { sessionID?: string }).sessionID === id) removed()
    })
    onCleanup(() => {
      offArchived()
      offDeleted()
      cancel?.()
    })
  })

  // 끊긴 사이 지워졌다면 그 이벤트는 오지 않는다. 다시 붙을 때마다 보고 있는 세션이 살아 있는지 되묻는다.
  createEffect(
    on(
      () => serverSDK.connection.status(),
      (status, previous) => {
        if (status !== "connected" || !previous || previous === "connected") return
        const id = sessionID()
        if (!id) return
        serverSDK.api.session
          .get({ sessionID: id })
          .then((info) => {
            if (sessionID() !== id) return
            if (!(info as { time?: { archived?: number } }).time?.archived) return
            follow(id)
          })
          .catch(() => {
            if (sessionID() === id) follow(id)
          })
      },
    ),
  )

  // ── 합의 다이얼로그 ──
  const [approval, setApproval] = createSignal<DocSubmitState | undefined>()
  const [approvalSession, setApprovalSession] = createSignal<string | undefined>()
  let approvalID: string | undefined
  let finalizedID: string | undefined

  const votePending = createMemo(() => approval()?.status === "pending")
  const dialogKey = (submitID: string) => `jitda-doc-submit:${submitID}`

  const closeApproval = () => {
    if (approvalID) dialog.close(dialogKey(approvalID))
    approvalID = undefined
    setApproval(undefined)
  }
  // V2 다이얼로그는 다른 창이 열리면 말없이 교체된다. id 로 실제 화면에 떠 있는지 확인한다.
  const dialogOpen = (submitID: string) => approvalID === submitID && dialog.active?.id === dialogKey(submitID)

  const respond = (action: "approve" | "cancel" | "exclude", failed: string) => {
    const current = approval()
    const actorID = doc.actorID()
    if (!current || !actorID) return
    void respondSubmit({
      api: jitda.doc,
      sessionID: current.sessionID,
      submitID: current.submitID,
      actorID,
      action,
    })
      // 이미 끝난 투표에 응답하면 최종 상태가 돌아온다. showApproval 을 거쳐야 창이 닫힌다.
      .then((next) => showApproval(next))
      .catch(() => showToast({ title: language.t(failed), description: language.t("common.requestFailed") }))
  }

  // local: 서버가 아닌 이 클라이언트가 만든 상태(카운트다운 만료). 서버 판정이 뒤에 와도 받아들인다.
  const showApproval = (state: DocSubmitState, opts?: { local?: boolean }) => {
    const actorID = doc.actorID()
    if (!actorID) return
    if (state.status !== "pending") {
      if (!opts?.local) {
        if (finalizedID === state.submitID) return
        finalizedID = state.submitID
      }
      // 중지·되돌리기 투표는 결과 화면이 없다 — 끝나면 닫는다.
      if (state.targetKind === "stop" || state.targetKind === "revert") {
        if (dialogOpen(state.submitID)) closeApproval()
        return
      }
      if (state.status === "sent") {
        clearComposer()
        if (dialogOpen(state.submitID)) closeApproval()
        return
      }
      if (!dialogOpen(state.submitID)) return
      setApproval(state)
      return
    }
    setApproval(state)
    if (dialogOpen(state.submitID)) return
    approvalID = state.submitID
    const key = dialogKey(state.submitID)
    dialog.show(
      () => (
        <DialogDocSubmit
          state={approval}
          actorID={actorID}
          spectator={readonly}
          kind={(() => {
            const current = approval()
            if (current?.targetKind === "stop" || current?.targetKind === "clear") return current.targetKind
            if (current?.targetKind === "revert") return current.revertAction ?? "revert"
            return "doc"
          })()}
          sdk={jitda.doc}
          approve={() => respond("approve", "docSubmit.toast.approveFailed")}
          cancel={() => respond("cancel", "docSubmit.toast.cancelFailed")}
          exclude={() => respond("exclude", "docSubmit.toast.sendFailed")}
          close={closeApproval}
          onExpire={() => {
            const current = approval()
            if (current?.status === "pending") showApproval({ ...current, status: "expired" }, { local: true })
          }}
        />
      ),
      () => {
        if (approvalID !== state.submitID) return
        const current = approval()
        approvalID = undefined
        if (current?.status === "pending") {
          // 다른 창이 이 투표 창을 밀어냈다 — 투표가 아직 돌면 다시 띄운다.
          window.setTimeout(() => {
            const next = approval()
            if (next?.status === "pending") showApproval(next)
          }, 120)
          return
        }
        setApproval(undefined)
      },
      key,
    )
  }

  const peers = () => {
    const actorID = doc.actorID()
    const list = doc.actors()
    const ids = Array.from(new Set([actorID, ...list.map((item) => item.actorID)]))
    const names: Record<string, string> = {}
    for (const item of list) {
      const name = item.name?.trim()
      if (name && name !== item.actorID) names[item.actorID] = name
    }
    return { alone: ids.length <= 1, names }
  }

  // 같이 쓰는 문서에서 응답 중지는 전송과 같은 합의를 거친다. 혼자(또는 문서 모드 밖)면 바로 끊는다.
  const requestStop = async () => {
    const id = sessionID()
    const docID = doc.docID()
    const actorID = doc.actorID()
    const abort = async () => {
      if (handlers.abort) {
        await handlers.abort()
        return
      }
      if (id) await serverSDK.api.session.interrupt({ sessionID: id }).catch(() => {})
    }
    if (mode() !== "doc" || !id || !docID || !actorID) {
      await abort()
      return
    }
    const { alone, names } = peers()
    if (alone) {
      await abort()
      return
    }
    try {
      const state = await startStopSubmit({ api: jitda.doc, sessionID: id, docID, actorID, names })
      setApprovalSession(id)
      showApproval(state)
    } catch {
      // 상대가 있는데 동의 없이 혼자 끊으면 안 된다.
      showToast({
        title: language.t("docSubmit.toast.stopRequestFailed"),
        description: language.t("common.requestFailed"),
      })
    }
  }

  const requestRevert = async (input: { messageID?: string; redo?: boolean }) => {
    const id = sessionID()
    if (!id) return
    const docID = doc.docID()
    const actorID = doc.actorID()
    const direct = async () => {
      if (input.redo) {
        await serverSDK.api.session.revert.clear({ sessionID: id })
        return
      }
      if (!input.messageID) return
      await serverSDK.api.session.interrupt({ sessionID: id })
      await serverSDK.api.session.wait({ sessionID: id })
      await serverSDK.api.session.revert.stage({ sessionID: id, messageID: input.messageID })
    }
    const fail = () =>
      showToast({
        title: language.t("docSubmit.toast.revertRequestFailed"),
        description: language.t("common.requestFailed"),
      })
    if (mode() !== "doc" || !docID || !actorID || peers().alone) {
      await direct().catch(fail)
      return
    }
    try {
      const state = await startRevert({ api: jitda.doc, sessionID: id, docID, actorID, names: peers().names, ...input })
      setApprovalSession(id)
      showApproval(state)
    } catch {
      fail()
    }
  }

  const requestClear = async () => {
    const id = sessionID()
    const docID = doc.docID()
    const actorID = doc.actorID()
    if (mode() !== "doc" || !id || !docID || !actorID) return false
    const { alone, names } = peers()
    if (alone) return false
    try {
      const state = await startClearSubmit({ api: jitda.doc, sessionID: id, docID, actorID, names })
      setApprovalSession(id)
      showApproval(state)
    } catch {
      showToast({
        title: language.t("docSubmit.toast.clearRequestFailed"),
        description: language.t("common.requestFailed"),
      })
    }
    return true
  }

  const clear = async () => {
    const id = sessionID()
    if (!id) return
    // 실패했는데 화면만 넘어가면 정리된 줄 알고 대화를 이어간다. 실패는 실패로 보여준다.
    const result = await jitda.rpc.session.archive({ sessionID: id }, jitda.options()).catch((err: unknown) => {
      showToast({
        title: language.t("session.clear.failed.title"),
        description: err instanceof Error && err.message ? err.message : language.t("common.requestFailed"),
      })
      return undefined
    })
    if (!result) return
    const next = (result as { main?: { id?: string } }).main?.id
    if (sessionID() !== id) return
    if (next && next !== id) {
      navigate(`${sessionHref(ServerConnection.key(server.conn), next)}${location.search}${location.hash}`)
      return
    }
    follow(id)
  }

  return {
    sessionID,
    doc,
    mode,
    setMode,
    working,
    requestStop,
    requestClear,
    requestRevert,
    clear,
    votePending,
    showApproval,
    approvalSession,
    setApprovalSession,
    dropped,
    setDropped,
    setHandlers: (next) => {
      handlers.submit = next.submit
      handlers.abort = next.abort
    },
  }
}
