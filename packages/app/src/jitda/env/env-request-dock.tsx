import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { TextField } from "@opencode/ui/text-field"
import { showToast } from "@opencode/ui/toast"
import { useLanguage } from "@/runtime/i18n/language"
import { connectEnvDraft, type EnvDraftChannel, type EnvPresenceEntry } from "../composer/doc-submit"
import { useJitda } from "../context"
import { merge } from "./env-draft-merge"
import { Button } from "./ui/button"
import { DockPrompt } from "./ui/dock-prompt"
import { Icon } from "./ui/icon"

export type EnvRequest = {
  id: string
  sessionID: string
  name: string
  label: string
  reason?: string
  docsUrl?: string
  replace?: boolean
  tool?: { messageID: string; callID: string }
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// 서버의 pending 목록이 원본이다. 새로고침·재접속 뒤 되살리지 않으면 AI 는 기다리는데 입력창이 없다.
export function createEnvRequests() {
  const jitda = useJitda()
  const [store, setStore] = createStore<{ list: EnvRequest[] }>({ list: [] })

  const refetch = () =>
    jitda.rpc.envRequest
      .list({}, jitda.options())
      .then((out) => {
        const list = ((out as { requests?: EnvRequest[] }).requests ?? []).filter(
          (item) => !!item?.id && !!item.sessionID,
        )
        setStore(
          "list",
          reconcile(
            list.sort((a, b) => cmp(a.id, b.id)),
            { key: "id" },
          ),
        )
      })
      .catch(() => undefined)

  onMount(() => void refetch())

  const offAsked = jitda.rpc.envRequest.events.on("asked", (event) => {
    const request = event.data as unknown as EnvRequest
    if (!request?.id || !request.sessionID) return
    setStore(
      "list",
      produce((list) => {
        const index = list.findIndex((item) => item.id === request.id)
        if (index >= 0) {
          list[index] = request
          return
        }
        list.push(request)
        list.sort((a, b) => cmp(a.id, b.id))
      }),
    )
  })
  const offResolved = jitda.rpc.envRequest.events.on("resolved", (event) => {
    const requestID = (event.data as { requestID?: unknown }).requestID
    if (typeof requestID !== "string") return
    setStore("list", (list) => list.filter((item) => item.id !== requestID))
  })
  onCleanup(() => {
    offAsked()
    offResolved()
  })

  return {
    list: () => store.list,
    refetch,
    /** sessionIDs 는 현재 세션부터 하위 세션까지 트리 순서. 앞 세션의 요청이 먼저다(V1 sessionEnvRequest). */
    pick: (sessionIDs: readonly string[]) => {
      for (const id of sessionIDs) {
        const found = store.list.find((item) => item.sessionID === id)
        if (found) return found
      }
      return undefined
    },
  }
}

// AI 가 외부 서비스 값을 요청하면 뜨는 입력 도크. 팀 전원 화면에 뜨고 값을 함께 채운다.
// 값은 브라우저 메모리 → 초안 소켓 → 저장 요청 본문에만 지나간다. 관전자는 소켓에 붙지 않고 읽기 전용으로 본다.
// 변수 이름은 AI 요청(props.request.name)이 단일 원본이라 원격 초안의 key 는 버린다.
export function EnvRequestDock(props: {
  request: EnvRequest
  /** 문서 서버(session_actor)에 등록된 이 탭의 actor id. 등록 전에는 undefined — 등록되면 그때 소켓을 연다. */
  actorID: () => string | undefined
  /** presence 로 다른 참가자에게 보일 이름·색(actor 등록 응답의 name/color). */
  actorName?: () => string | undefined
  actorColor?: () => string | undefined
  onSubmit?: () => void
}) {
  const language = useLanguage()
  const jitda = useJitda()

  const readonly = jitda.readonly()
  const sessionID = props.request.sessionID
  const requestID = props.request.id

  const [draft, setDraft] = createStore({ value: "" })
  const [presence, setPresence] = createSignal<EnvPresenceEntry[]>([])
  const [busy, setBusy] = createSignal(false)

  let channel: EnvDraftChannel | undefined
  // 값 칸을 잡고 있을 때는 원격 value 를 덮지 않는다 — 한글 조합 보호(env-draft-merge).
  let focused: "value" | undefined

  const actor = createMemo(() => {
    const actorID = props.actorID()
    if (!actorID) return
    return {
      actorID,
      name: props.actorName?.()?.trim() || actorID,
      color: props.actorColor?.() ?? jitda.identity()?.color ?? "",
    }
  })

  const others = createMemo(() => presence().filter((item) => item.editing && item.actorID !== actor()?.actorID))

  const broadcast = (editing: boolean) => {
    const a = actor()
    if (!a || !channel || readonly) return
    channel.sendPresence({ actorID: a.actorID, name: a.name, color: a.color, editing })
  }

  const edit = (text: string) => {
    setDraft("value", text)
    channel?.sendOp({ kind: "value", text })
    broadcast(true)
  }

  const fail = (err: unknown) => {
    const description =
      err instanceof Error
        ? err.message
        : err && typeof err === "object" && "message" in err && typeof err.message === "string"
          ? err.message
          : String(err)
    showToast({ title: language.t("common.requestFailed"), description })
  }

  const save = async () => {
    if (busy() || readonly) return
    const value = draft.value
    if (!value) return
    setBusy(true)
    try {
      await jitda.rpc.envRequest.submit({ requestID, value }, jitda.options())
      // 저장 직후 로컬 사본을 지운다. 이후 전원 도크는 resolved 이벤트로 닫힌다.
      setDraft("value", "")
      props.onSubmit?.()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const skip = async () => {
    if (busy() || readonly) return
    setBusy(true)
    try {
      await jitda.rpc.envRequest.skip({ requestID }, jitda.options())
      props.onSubmit?.()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  createEffect(
    on(
      () => actor()?.actorID,
      (actorID) => {
        if (readonly || !actorID) return
        const current = connectEnvDraft({
          api: jitda.doc,
          sessionID,
          requestID,
          actorID,
          key: props.request.name,
          onDraft: (next) => {
            const patch = merge(focused, { key: props.request.name, value: next.value })
            if (patch.value !== undefined) setDraft("value", patch.value)
          },
          onPresence: (list) => setPresence(list),
        })
        channel = current
        broadcast(false)
        onCleanup(() => {
          current.close()
          if (channel === current) channel = undefined
        })
      },
    ),
  )

  onCleanup(() => {
    // 로컬 사본을 비워 도크가 사라진 뒤 메모리에 값이 남지 않게 한다.
    setDraft("value", "")
  })

  const canSave = createMemo(() => !!draft.value && !busy() && !readonly)

  return (
    <DockPrompt
      kind="env"
      header={
        <>
          <span class="inline-flex shrink-0 items-center justify-center text-icon-base">
            <Icon name="lock" size="small" />
          </span>
          <span data-slot="env-title" class="shrink-0">
            {language.t("envRequest.title")}
          </span>
          <span data-slot="env-subtitle" class="text-text-weaker truncate min-w-0">
            · {props.request.label}
          </span>
        </>
      }
      footer={
        <>
          <div class="flex items-center gap-1.5 min-w-0">
            <span data-slot="env-note" class="text-text-weak shrink-0">
              {language.t("envRequest.notice.ai")}
            </span>
            <Show when={others().length > 0}>
              <span data-slot="env-note" class="text-text-weaker truncate min-w-0">
                ·{" "}
                {language.t("envRequest.editing", {
                  names: others()
                    .map((item) => item.name)
                    .join(", "),
                })}
              </span>
            </Show>
          </div>
          <div class="flex-1" />
          <div class="flex items-center gap-2 shrink-0">
            <Button variant="secondary" size="small" onClick={() => void skip()} disabled={busy() || readonly}>
              {language.t("envRequest.cancel")}
            </Button>
            <Button variant="primary" size="small" onClick={() => void save()} disabled={!canSave()}>
              {language.t("envRequest.save")}
            </Button>
          </div>
        </>
      }
    >
      {/* 붙여넣기 버튼은 두지 않는다 — clipboard.readText() 가 브라우저 권한 창을 띄운다. ⌘V 는 그대로 된다. */}
      <Show when={props.request.replace}>
        <p data-slot="env-note" class="text-text-weak">
          {language.t("envRequest.notice.replace")}
        </p>
      </Show>

      {/* 입력 중에는 값을 가리지 않는다 — 방금 붙여넣은 값을 눈으로 확인할 수 있어야 한다. */}
      <TextField
        class="font-mono"
        autofocus
        label={language.t("envRequest.field.value.label")}
        hideLabel
        autocomplete="off"
        placeholder={language.t("envRequest.field.value.placeholder")}
        value={draft.value}
        disabled={readonly}
        onFocus={() => (focused = "value")}
        onChange={edit}
        onBlur={() => {
          focused = undefined
          broadcast(false)
        }}
      />

      <Show when={readonly}>
        <span data-slot="env-note" class="text-text-weaker">
          {language.t("envRequest.readonly")}
        </span>
      </Show>
    </DockPrompt>
  )
}
