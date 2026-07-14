import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, onMount, Show, type Accessor } from "solid-js"
import { useClientEnv } from "@/context/client-env"
import { createPage } from "@/components/blocksuite/blocksuite-doc"
import { SessionPreviewMascot } from "@/pages/session/session-preview-mascot"
import type { DocSubmitActor, DocSubmitState } from "../prompt-input/doc-submit"
import { avatarLabel } from "./avatar-label"
import { useCountdown } from "./use-countdown"
import "./doc-submit.css"

// What the vote will do once approved — drives the dialog copy.
export type DocSubmitKind = "doc" | "question-send" | "question-dismiss" | "question-back" | "stop"

// For question votes: the question(s) and the answer(s) being agreed on, shown so everyone sees
// exactly what is about to be sent (or which question is being dismissed).
export type DocSubmitPreviewItem = { question: string; answers: string[] }

// Enough of the session SDK to mount the prompt doc read-only inside the dialog. Passed explicitly
// because the dialog renders in a Portal whose owner sits ABOVE the per-directory SDKProvider, so
// `useSDK()` inside the dialog would not resolve the session client.
export type DocSubmitSdk = { url: string; directory: string; client: OpencodeClient }

type Props = {
  state: Accessor<DocSubmitState | undefined>
  actorID: string
  kind?: DocSubmitKind
  preview?: () => DocSubmitPreviewItem[]
  // Required for kind === "doc": lets the snapshot mount the prompt doc read-only.
  sdk?: DocSubmitSdk
  // A readonly spectator watches the vote (live status list) but cannot approve/reject — the action
  // buttons and approve/reject keybinds are suppressed.
  spectator?: boolean
  approve: () => void
  cancel: () => void
  // Requester-only: send now without the members who left mid-vote (their rows show 나감). Offered
  // when the departed are the sole holdouts — a departure itself never sends.
  exclude?: () => void
  close: () => void
  // Fired when the local countdown passes the deadline (+grace) without a server terminal cast — the
  // parent synthesizes an "expired" state so a finished vote never lingers on screen. Optional so a
  // spectator-only mount can omit it.
  onExpire?: () => void
}

// ── copy helpers (kind-aware) ──────────────────────────────────────────────
function headline(kind: DocSubmitKind | undefined) {
  if (kind === "question-send") return "이 답변, 보낼까요?"
  if (kind === "question-dismiss") return "이 질문, 닫을까요?"
  if (kind === "question-back") return "이전 질문으로 돌아갈까요?"
  if (kind === "stop") return "AI 응답을 멈출까요?"
  return "이 프롬프트, 보낼까요?"
}

function requestVerb(kind: DocSubmitKind | undefined) {
  if (kind === "question-dismiss") return "닫기를"
  if (kind === "question-back") return "되돌리기를"
  if (kind === "stop") return "중지를"
  return "전송을"
}

function approveLabel(kind: DocSubmitKind | undefined) {
  if (kind === "question-dismiss") return "수락하고 닫기"
  if (kind === "question-back") return "수락하고 돌아가기"
  if (kind === "stop") return "수락하고 멈추기"
  return "수락하고 보내기"
}

function excludeLabel(kind: DocSubmitKind | undefined) {
  if (kind === "question-dismiss") return "나간 인원 제외하고 닫기"
  if (kind === "question-back") return "나간 인원 제외하고 돌아가기"
  if (kind === "stop") return "나간 인원 제외하고 멈추기"
  return "나간 인원 제외하고 보내기"
}

// Verb used in the live "동의 현황" status line ("…전송돼요" / "…진행돼요").
function proceedVerb(kind: DocSubmitKind | undefined) {
  if (kind === "question-dismiss") return "닫혀요"
  if (kind === "question-back") return "되돌아가요"
  if (kind === "stop") return "멈춰요"
  return "전송돼요"
}

function warnText(kind: DocSubmitKind | undefined) {
  if (kind === "question-dismiss") return "닫으면 이 질문은 사라져요. 거절하면 그대로 둘 수 있어요."
  if (kind === "question-back") return "되돌리면 이 질문의 답변이 초기화돼요. 거절하면 그대로 둘 수 있어요."
  if (kind === "stop") return "멈추면 진행 중인 AI 응답이 중단돼요. 거절하면 계속 진행돼요."
  return "전송 후에는 AI 응답을 취소할 수 없어요. 거절하면 다시 편집할 수 있어요."
}

// Votes that show only the question text (no answers) in the preview.
function hideAnswers(kind: DocSubmitKind | undefined) {
  return kind === "question-dismiss" || kind === "question-back"
}

// ── inline glyphs (design-system Icon ports — app icon set lacks send/clock/user/warn/refresh) ──
const ICON = {
  send: (s = 14) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  ),
  clock: (s = 14) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  user: (s = 14) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  ),
  check: (s = 14) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  x: (s = 14) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  warn: (s = 14) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
  refresh: (s = 14) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  ),
  arrowRight: (s = 14) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  ),
}

// ── avatar (initials circle + agree check pop) ─────────────────────────────
function ConsentAvatar(props: { name: string; color: string; size?: number; dashed?: boolean; check?: boolean; on?: boolean }) {
  const size = () => props.size ?? 30
  return (
    <span class="ds-avatar" style={{ width: `${size()}px`, height: `${size()}px` }}>
      <span
        class="ds-avatar__circle"
        classList={{ "ds-avatar__circle--dashed": props.dashed }}
        style={{
          "background-color": props.dashed ? "transparent" : props.color,
          "font-size": `${size() * 0.36}px`,
          opacity: props.on === false ? 0.5 : 1,
        }}
      >
        {avatarLabel(props.name)}
      </span>
      <Show when={props.check}>
        <span class="ds-avatar__check jt-check-pop">{ICON.check(8)}</span>
      </Show>
    </span>
  )
}

function ConsentCountdownChip(props: { sec: number; danger: boolean }) {
  return (
    <span class="ds-chip" classList={{ "ds-chip--danger": props.danger }}>
      {ICON.clock(13)}
      자동 거절까지 {props.sec}초
    </span>
  )
}

// ── prompt doc snapshot — read-only mount of the doc being sent ────────────
function snapshotTheme(): "light" | "dark" {
  const scheme = document.documentElement.getAttribute("data-color-scheme")
  if (scheme === "dark" || scheme === "light") return scheme
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function ConsentDocSnapshot(props: { docID: string; sdk: DocSubmitSdk }) {
  const [fail, setFail] = createSignal(false)
  let el: HTMLDivElement | undefined
  let page: Awaited<ReturnType<typeof createPage>> | undefined
  let stop = false

  onMount(() => {
    const host = el
    if (!host) {
      setFail(true)
      return
    }
    void createPage({
      theme: snapshotTheme(),
      init: false,
      readonly: true,
      preview: true,
      sync: {
        docID: props.docID,
        baseUrl: props.sdk.url,
        directory: props.sdk.directory,
        client: props.sdk.client,
        actorID: "viewer",
        name: "Viewer",
        color: "#3574D9",
      },
    })
      .then(async (next) => {
        if (stop) {
          await next.dispose()
          return
        }
        page = next
        await next.attach(host)
      })
      .catch(() => {
        void page?.dispose()
        page = undefined
        setFail(true)
      })
  })

  onCleanup(() => {
    stop = true
    void page?.dispose()
  })

  return (
    <Show when={!fail()} fallback={<div class="ds-snap-fallback">문서를 불러올 수 없습니다.</div>}>
      <div ref={el} data-component="prompt-doc-viewer" />
    </Show>
  )
}

// ── question preview (rendered inside the snapshot card for question votes) ─
function PreviewCard(props: { items: () => DocSubmitPreviewItem[]; dismiss?: boolean }) {
  return (
    <div class="ds-preview" data-multi={props.items().length > 1}>
      <For each={props.items()}>
        {(item, i) => (
          <div class="ds-preview-item">
            <Show when={props.items().length > 1}>
              <span class="ds-preview-idx">{i() + 1}</span>
            </Show>
            <div class="ds-preview-body">
              <div class="ds-preview-q">{item.question}</div>
              <Show when={!props.dismiss}>
                <Show
                  when={item.answers.length > 0}
                  fallback={<div class="ds-preview-a ds-preview-a--empty">미선택</div>}
                >
                  <div class="ds-preview-answers">
                    <For each={item.answers}>{(answer) => <span class="ds-preview-a">{answer}</span>}</For>
                  </div>
                </Show>
              </Show>
            </div>
          </div>
        )}
      </For>
    </div>
  )
}

// The snapshot region: doc viewer for prompt sends, question preview for question votes, nothing
// for a bare "stop" vote.
function SnapshotArea(props: { kind?: DocSubmitKind; state: DocSubmitState; preview?: () => DocSubmitPreviewItem[]; sdk?: DocSubmitSdk }) {
  return (
    <Show when={props.kind !== "stop"}>
      <div class="jt-snap-scroll ds-snap">
        <Show
          when={props.kind === "doc" && props.sdk}
          fallback={
            <Show when={props.preview}>
              {(items) => <PreviewCard items={items()} dismiss={hideAnswers(props.kind)} />}
            </Show>
          }
        >
          <ConsentDocSnapshot docID={props.state.targetID} sdk={props.sdk!} />
        </Show>
      </div>
    </Show>
  )
}

// ── voting body — content snapshot + live agreement + asymmetric actions ───
function VotingBody(props: {
  state: DocSubmitState
  kind?: DocSubmitKind
  preview?: () => DocSubmitPreviewItem[]
  sdk?: DocSubmitSdk
  actorID: string
  sec: number
  approve: () => void
  cancel: () => void
}) {
  const requester = () => props.state.actors.find((item) => item.actorID === props.state.actorID)
  const nonReq = createMemo(() => props.state.actors.filter((item) => item.actorID !== props.state.actorID))
  // 나감 members don't count toward "N명이 더 동의하면" — they can't answer; whether to proceed
  // without them is the requester's call (exclude action in the waiting view).
  const remaining = createMemo(() => nonReq().filter((item) => item.status === "pending"))
  const departed = createMemo(() => nonReq().filter((item) => item.status === "left"))
  const onlyMe = () => {
    const left = remaining()
    return left.length === 1 && left[0]?.actorID === props.actorID
  }
  const danger = () => props.sec <= 5

  return (
    <div class="ds-body ds-body--voting">
      <div class="ds-vote-header">
        <ConsentAvatar name={requester()?.name ?? "참여자"} color={requester()?.color ?? "#888"} size={34} />
        <div class="ds-vote-header__text">
          <strong>{requester()?.name ?? "참여자"}</strong>님이 {requestVerb(props.kind)} 요청했어요
        </div>
        <ConsentCountdownChip sec={props.sec} danger={danger()} />
      </div>

      <h2 class="ds-headline">{headline(props.kind)}</h2>

      <SnapshotArea kind={props.kind} state={props.state} preview={props.preview} sdk={props.sdk} />

      <div class="ds-agree">
        <span class="ds-agree__stack">
          <For each={nonReq()}>
            {(item, i) => {
              const ok = () => item.status === "approved"
              return (
                <span class="ds-agree__slot" style={{ "margin-left": i() ? "-7px" : "0" }}>
                  <ConsentAvatar name={item.name} color={item.color} size={26} dashed={!ok()} check={ok()} on={ok()} />
                </span>
              )
            }}
          </For>
        </span>
        <span class="ds-agree__text">
          <Show
            when={remaining().length > 0}
            fallback={
              <Show
                when={departed().length > 0}
                fallback={
                  <span>
                    <strong class="ds-ok">모두 동의했어요</strong> · 곧 {proceedVerb(props.kind)}
                  </span>
                }
              >
                <span>
                  <strong>{departed().length}명</strong>이 나갔어요 · 요청자가 진행을 정해요
                </span>
              </Show>
            }
          >
            <Show
              when={onlyMe()}
              fallback={
                <span>
                  <strong>{remaining().length}명</strong>이 더 동의하면 {proceedVerb(props.kind)}
                </span>
              }
            >
              <span>
                이제 <strong>나만</strong> 동의하면 {proceedVerb(props.kind)}
              </span>
            </Show>
          </Show>
        </span>
      </div>

      <div class="ds-actions">
        <button type="button" class="jt-btn jt-btn-secondary jt-btn-lg" onClick={props.cancel}>
          거절 <span class="ds-kbd">Esc</span>
        </button>
        <span class="ds-actions__spacer" />
        <button type="button" class="jt-btn jt-btn-critical jt-btn-lg ds-btn-approve" onClick={props.approve}>
          {ICON.send(15)}
          {approveLabel(props.kind)}
          <span class="ds-kbd ds-kbd--on-dark">Enter</span>
        </button>
      </div>

      <div class="ds-warn">
        {ICON.warn(12)}
        {warnText(props.kind)}
      </div>
    </div>
  )
}

// ── waiting body — I agreed, waiting on the rest ───────────────────────────
function StatusRow(props: { actor: DocSubmitActor; me: string; requesterID: string }) {
  const ok = () => props.actor.status === "approved"
  const [flash, setFlash] = createSignal(false)
  let prev = ok()
  createEffect(() => {
    const now = ok()
    if (now && !prev) {
      setFlash(true)
      const t = setTimeout(() => setFlash(false), 800)
      onCleanup(() => clearTimeout(t))
    }
    prev = now
  })
  const suffix = () => {
    let out = ""
    if (props.actor.actorID === props.me) out += " (나)"
    if (props.actor.actorID === props.requesterID) out += " · 요청자"
    return out
  }
  const gone = () => props.actor.status === "left"
  return (
    <div class="ds-status-row" classList={{ "jt-consent-row-flash": flash(), "ds-status-row--gone": gone() }}>
      <ConsentAvatar name={props.actor.name} color={props.actor.color} size={28} on={ok()} check={ok()} dashed={gone()} />
      <span class="ds-status-row__name" classList={{ "ds-status-row__name--ok": ok() }}>
        {props.actor.name}
        {suffix()}
      </span>
      <Show
        when={ok()}
        fallback={
          <Show
            when={gone()}
            fallback={
              <span class="ds-status-row__wait">
                대기 중 <span class="jt-spin ds-spin">{ICON.refresh(12)}</span>
              </span>
            }
          >
            <span class="ds-status-row__wait">
              {ICON.user(12)} 나감
            </span>
          </Show>
        }
      >
        <span class="jt-pill jt-pill-started ds-status-row__pill">동의함</span>
      </Show>
    </div>
  )
}

function WaitingBody(props: {
  state: DocSubmitState
  kind?: DocSubmitKind
  actorID: string
  sec: number
  cancel: () => void
  exclude?: () => void
  spectator?: boolean
}) {
  const allOk = createMemo(() => props.state.actors.every((item) => item.status === "approved"))
  // The departed are the sole holdouts: the requester (and only the requester) may proceed without
  // them — a departure by itself never sends.
  const excludable = createMemo(
    () =>
      props.state.actorID === props.actorID &&
      props.state.actors.some((item) => item.status === "left") &&
      !props.state.actors.some((item) => item.status === "pending"),
  )
  const sub = () => {
    if (props.kind === "stop") return "모두 동의하면 AI 응답을 멈춰요"
    if (props.kind === "question-dismiss") return "모두 동의하면 질문을 닫아요"
    if (props.kind === "question-back") return "모두 동의하면 이전 질문으로 돌아가요"
    return "모두 동의하면 바로 AI에게 전송돼요"
  }
  // A readonly spectator sees the SAME waiting/status view an already-approved participant sees — same
  // copy and layout. The only difference: it cannot cancel, so the "동의 취소" button is hidden.
  return (
    <div class="ds-body ds-body--waiting">
      <SessionPreviewMascot size={52} />
      <div class="ds-waiting-head">
        <h2 class="ds-headline ds-headline--center">
          {excludable()
            ? "나간 팀원만 응답하지 않았어요"
            : allOk()
              ? "모두 동의했어요. 진행할게요"
              : "동의했어요. 팀원을 기다려요"}
        </h2>
        <p class="ds-waiting-sub">
          {excludable() ? "제외하고 보내거나, 돌아올 때까지 기다릴 수 있어요" : sub()} ·{" "}
          <span class="ds-nowrap">자동 거절까지 {props.sec}초</span>
        </p>
      </div>
      <div class="jt-snap-scroll ds-status-list">
        <For each={props.state.actors}>
          {(item) => <StatusRow actor={item} me={props.actorID} requesterID={props.state.actorID} />}
        </For>
      </div>
      <Show when={!props.spectator}>
        <div class="ds-waiting-actions">
          <button type="button" class="jt-btn jt-btn-secondary" onClick={props.cancel}>
            동의 취소 <span class="ds-kbd">Esc</span>
          </button>
          <Show when={excludable() && props.exclude}>
            <button type="button" class="jt-btn jt-btn-critical ds-btn-approve" onClick={props.exclude}>
              {ICON.send(14)}
              {excludeLabel(props.kind)}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  )
}

// ── failure card — three outcomes, auto-returns to canvas ──────────────────
function failInfo(state: DocSubmitState): { title: string; sub: string; icon: JSX.Element } {
  const timeoutSec = Math.round(state.timeoutMs / 1000)
  if (state.status === "left") {
    return { title: "전송이 무산됐어요", sub: "팀원이 캔버스를 나가 합의가 깨졌어요. 다시 모이면 보낼 수 있어요.", icon: ICON.user(22) }
  }
  if (state.status === "expired") {
    return {
      title: "시간이 초과되었어요",
      sub: `${timeoutSec}초 안에 모두 동의하지 않아 전송되지 않았어요. 다시 시도해 주세요.`,
      icon: ICON.clock(22),
    }
  }
  return { title: "전송이 취소되었어요", sub: "캔버스로 돌아가 내용을 다시 다듬은 뒤 보낼 수 있어요.", icon: ICON.x(22) }
}

function FailureCard(props: { state: DocSubmitState; close: () => void }) {
  const env = useClientEnv()
  const info = createMemo(() => failInfo(props.state))
  const total = env.submitFailureCloseSec()
  const [auto, setAuto] = createSignal(total)
  createEffect(() => {
    if (auto() <= 0) {
      props.close()
      return
    }
    const timer = setTimeout(() => setAuto((value) => value - 1), 1000)
    onCleanup(() => clearTimeout(timer))
  })
  return (
    <div class="jt-consent-card ds-fail-card">
      <div class="ds-fail__icon">{info().icon}</div>
      <h2 class="ds-headline ds-headline--center ds-fail__title">{info().title}</h2>
      <p class="ds-fail__sub">{info().sub}</p>
      <div class="ds-fail__bar">
        <div class="ds-fail__bar-fill" style={{ width: `${total > 0 ? (Math.max(0, auto()) / total) * 100 : 0}%` }} />
      </div>
      <span class="ds-fail__count">{Math.max(0, auto())}초 후 캔버스로 돌아가요</span>
      <button type="button" class="jt-btn jt-btn-secondary ds-fail__btn" onClick={props.close}>
        지금 돌아가기 {ICON.arrowRight(14)}
      </button>
    </div>
  )
}

// ── consent frame — top caution-strip timer + body (voting | waiting) ──────
function ConsentFrame(props: {
  view: "voting" | "waiting"
  state: DocSubmitState
  kind?: DocSubmitKind
  preview?: () => DocSubmitPreviewItem[]
  sdk?: DocSubmitSdk
  actorID: string
  spectator?: boolean
  approve: () => void
  cancel: () => void
  exclude?: () => void
  onExpire?: () => void
}) {
  const remaining = useCountdown(() => props.state.expiresAt, props.onExpire)
  const total = () => props.state.timeoutMs / 1000
  // ceil, not round: the chip reads "앞으로 N초", so each number must span the whole second it names —
  // "5초" while 5.0s..4.0s remain, "1초" while 1.0s..0.0s remain, "0초" only once the deadline has
  // actually passed (the frame lingers EXPIRE_GRACE_MS waiting on the server's terminal cast). round put
  // the boundaries on half-seconds: it showed "0초" with 0.5s still on the clock and fired `urgent` at
  // 5.5s. The strip's CSS `transition: width 1s linear` smooths the 1s steps.
  const sec = () => Math.max(0, Math.ceil(remaining()))
  const pct = () => {
    const t = total()
    return t > 0 ? Math.max(0, Math.min(100, (sec() / t) * 100)) : 0
  }
  // Urgency (red strip + heartbeat) only nudges an undecided voter — never the already-agreed waiter,
  // and never a spectator who can't act anyway.
  const urgent = () => sec() <= 5 && props.view === "voting" && !props.spectator

  return (
    <div class="jt-consent-card ds-card" classList={{ "is-urgent": urgent() }}>
      <div class="jt-consent-strip">
        <div class="jt-consent-strip-fill" style={{ width: `${pct()}%` }}>
          <div class="jt-consent-strip-layer" />
          <div class="jt-consent-strip-layer is-red" classList={{ on: urgent() }} />
        </div>
      </div>
      <div class="jt-consent-body-in ds-body-scroll">
        <Show
          when={props.view === "waiting"}
          fallback={
            <VotingBody
              state={props.state}
              kind={props.kind}
              preview={props.preview}
              sdk={props.sdk}
              actorID={props.actorID}
              sec={sec()}
              approve={props.approve}
              cancel={props.cancel}
            />
          }
        >
          <WaitingBody
            state={props.state}
            kind={props.kind}
            actorID={props.actorID}
            sec={sec()}
            cancel={props.cancel}
            exclude={props.exclude}
            spectator={props.spectator}
          />
        </Show>
      </div>
    </div>
  )
}

export function DialogDocSubmit(props: Props) {
  const state = () => props.state()
  const me = () => state()?.actors.find((item) => item.actorID === props.actorID)
  const pending = () => state()?.status === "pending"
  const approved = () => me()?.status === "approved"
  const failed = () => {
    const value = state()?.status
    return value === "cancelled" || value === "expired" || value === "left"
  }

  // Keyboard: Enter = approve (voting only), Esc = reject/cancel. Captured so the shared dialog
  // provider's Esc-to-close does not also fire. On a terminal (failure) screen we leave keys alone
  // so the provider can close normally.
  onMount(() => {
    // A spectator has no approve/reject action, so leave the keys to the dialog provider.
    if (props.spectator) return
    const onKey = (event: KeyboardEvent) => {
      const current = state()
      if (!current || current.status !== "pending") return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.isComposing || event.keyCode === 229) return
      if (event.key === "Enter" && !approved()) {
        event.preventDefault()
        event.stopImmediatePropagation()
        props.approve()
      } else if (event.key === "Escape") {
        event.preventDefault()
        event.stopImmediatePropagation()
        props.cancel()
      }
    }
    window.addEventListener("keydown", onKey, true)
    onCleanup(() => window.removeEventListener("keydown", onKey, true))
  })

  return (
    <div
      data-component="doc-submit-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-label={failed() ? "합의 무산" : "전송 동의"}
    >
      <div data-slot="doc-submit-backdrop" />
      <Show when={state()}>
        {(current) => (
          <Show
            when={!failed()}
            fallback={<FailureCard state={current()} close={props.close} />}
          >
            <ConsentFrame
              view={props.spectator || (pending() && approved()) ? "waiting" : "voting"}
              state={current()}
              kind={props.kind}
              preview={props.preview}
              sdk={props.sdk}
              actorID={props.actorID}
              spectator={props.spectator}
              approve={props.approve}
              cancel={props.cancel}
              exclude={props.exclude}
              onExpire={props.onExpire}
            />
          </Show>
        )}
      </Show>
    </div>
  )
}
