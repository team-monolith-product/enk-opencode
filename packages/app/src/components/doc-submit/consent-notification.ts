import type { DocSubmitState } from "../prompt-input/doc-submit"

// OS notification for a consent vote reaching a participant whose tab is hidden. Pairs with the
// loopback RTC keepalive (utils/rtc-keepalive.ts): the keepalive keeps a backgrounded tab's JS
// alive so the vote cast still arrives, and this surfaces it where the user actually is. Clicking
// focuses the tab — the dialog is already on screen (state-driven), so nothing else to do.
// One notification per submit (tag = submitID); resolved votes close theirs.

const shown = new Map<string, Notification>()

function copy(state: DocSubmitState) {
  const requester = state.actors.find((actor) => actor.actorID === state.actorID)?.name ?? "팀원"
  if (state.targetKind === "stop") return `${requester}님이 AI 응답 중지 동의를 요청했어요`
  if (state.targetKind === "question") return `${requester}님이 질문 답변 전송 동의를 요청했어요`
  return `${requester}님이 프롬프트 전송 동의를 요청했어요`
}

// Ask once per doc-session entry. Chrome shows a quiet prompt when this is not gesture-driven —
// a denial (or unsupported platform) just means no notifications, never an error.
export function requestConsentNotificationPermission() {
  if (typeof Notification === "undefined") return
  if (Notification.permission !== "default") return
  void Notification.requestPermission().catch(() => {})
}

export function notifyConsentWhenHidden(state: DocSubmitState, myActorID: string) {
  if (typeof Notification === "undefined") return

  // Any terminal state retires the notification — the moment to act has passed.
  if (state.status !== "pending") {
    shown.get(state.submitID)?.close()
    shown.delete(state.submitID)
    return
  }
  // My own approval also retires it: nothing left for me to act on.
  const me = state.actors.find((actor) => actor.actorID === myActorID)
  if (me?.status === "approved") {
    shown.get(state.submitID)?.close()
    shown.delete(state.submitID)
    return
  }

  if (Notification.permission !== "granted") return
  if (!document.hidden) return
  if (state.actorID === myActorID) return
  if (shown.has(state.submitID)) return

  try {
    const remaining = Math.max(0, Math.round((state.expiresAt - Date.now()) / 1000))
    const notification = new Notification(copy(state), {
      tag: state.submitID,
      body: `${remaining}초 안에 응답하지 않으면 자동 거절돼요`,
    })
    notification.onclick = () => {
      window.focus()
      notification.close()
    }
    shown.set(state.submitID, notification)
  } catch {
    // Constructor can throw on platforms that only allow notifications from service workers.
  }
}
