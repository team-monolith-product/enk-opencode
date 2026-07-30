import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { EnvRequest } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { DockPrompt } from "@opencode-ai/ui/dock-prompt"
import { Icon } from "@opencode-ai/ui/icon"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { label } from "@/components/blocksuite/actor"
import { loadActor, saveActor } from "@/components/prompt-input/doc-actor"
import { connectEnvDraft, type EnvDraftChannel, type EnvPresenceEntry } from "@/components/prompt-input/doc-submit"
import { useLanguage } from "@/context/language"
import { useParentParams } from "@/context/parent-params"
import { useSDK } from "@/context/sdk"

// AI 가 외부 서비스 값을 요청하면 뜨는 입력 도크. 팀 전원 화면에 뜨고 이름·값을 함께 채운다.
//
// 값이 지나가는 곳은 여기(브라우저 메모리) → 초안 소켓 → 저장 요청 본문, 이 셋뿐이다. 대화 메시지에도
// 문서에도 남기지 않고 모델에게도 가지 않는다. 관전자는 서버가 초안 소켓을 거절하므로 읽기 전용으로만 본다.
export function SessionEnvRequestDock(props: { request: EnvRequest; onSubmit?: () => void }) {
  const language = useLanguage()
  const sdk = useSDK()
  const parentParams = useParentParams()

  const readonly = parentParams.readonly
  const sessionID = props.request.sessionID
  const requestID = props.request.id

  const [draft, setDraft] = createStore({ key: props.request.name, value: "" })
  const [presence, setPresence] = createSignal<EnvPresenceEntry[]>([])
  const [actor, setActor] = createSignal<{ actorID: string; name: string; color: string }>()
  const [busy, setBusy] = createSignal(false)

  let channel: EnvDraftChannel | undefined
  let disposed = false

  const others = createMemo(() => presence().filter((item) => item.editing && item.actorID !== actor()?.actorID))

  const broadcast = (editing: boolean) => {
    const a = actor()
    if (!a || !channel || readonly) return
    channel.sendPresence({ actorID: a.actorID, name: a.name, color: a.color, editing })
  }

  const edit = (field: "key" | "value", text: string) => {
    setDraft(field, text)
    channel?.sendOp({ kind: field, text })
    broadcast(true)
  }

  const fail = (err: unknown) => {
    const description = err instanceof Error ? err.message : String(err)
    showToast({ title: language.t("common.requestFailed"), description })
  }

  const save = async () => {
    if (busy() || readonly) return
    const key = draft.key.trim()
    const value = draft.value
    if (!key || !value) return
    setBusy(true)
    try {
      await sdk.client.envRequest.submit({
        requestID,
        directory: sdk.directory,
        // 서버가 정한 이름과 다를 때만 실어 보낸다.
        ...(key === props.request.name ? {} : { name: key }),
        value,
      })
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
      await sdk.client.envRequest.skip({ requestID, directory: sdk.directory })
      props.onSubmit?.()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  onMount(() => {
    void (async () => {
      const user = parentParams.user[0]

      // 관전자는 actor 를 등록하지 않고 초안 소켓에도 붙지 않는다 — 서버가 어차피 거절한다.
      // 값이 오가는 채널에 순수 관전자를 들이지 않는 게 이 도크의 규칙이다.
      if (readonly) return

      const stored = loadActor(sessionID, user?.id)
      // 도크가 서버보다 먼저 뜰 수 있어 등록이 성공할 때까지 물러서며 재시도한다.
      let registered: Awaited<ReturnType<typeof sdk.client.session.actor.upsert>>["data"] | undefined
      let delay = 500
      while (!disposed) {
        try {
          const res = await sdk.client.session.actor.upsert({
            sessionID,
            directory: sdk.directory,
            ...(stored ? { actorID: stored } : {}),
            ...(user ? { userID: user.id, name: user.name } : {}),
            ...(user?.color ? { color: user.color } : {}),
          })
          registered = res.data
          if (registered) break
        } catch {
          // 백오프로 넘어간다
        }
        await new Promise<void>((resolve) => setTimeout(resolve, delay))
        delay = Math.min(delay * 2, 8000)
      }
      if (disposed || !registered) return

      saveActor(sessionID, registered.actorID, user?.id)
      setActor({
        actorID: registered.actorID,
        name: label(registered.actorID, registered.name),
        color: registered.color,
      })

      channel = connectEnvDraft({
        baseUrl: sdk.url,
        directory: sdk.directory,
        sessionID,
        requestID,
        actorID: registered.actorID,
        key: props.request.name,
        onDraft: (next) => setDraft({ key: next.key, value: next.value }),
        onPresence: (list) => setPresence(list),
      })
      broadcast(false)
    })()
  })

  onCleanup(() => {
    disposed = true
    channel?.close()
    channel = undefined
    // 로컬 사본을 비워 도크가 사라진 뒤 메모리에 값이 남지 않게 한다.
    setDraft("value", "")
  })

  const canSave = createMemo(() => !!draft.key.trim() && !!draft.value && !busy() && !readonly)

  return (
    <DockPrompt
      kind="env"
      header={
        <>
          <span class="inline-flex shrink-0 items-center justify-center text-icon-base">
            <Icon name="lock" size="small" />
          </span>
          <span class="text-13-medium text-text-strong shrink-0">{language.t("envRequest.title")}</span>
          <span class="text-12-regular text-text-weaker truncate min-w-0">· {props.request.label}</span>
        </>
      }
      footer={
        <>
          {/* 좌: 안내 한 줄. 누가 입력 중이면 같은 줄에 이어 붙인다(시안은 액션과 한 행). */}
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="text-12-regular text-text-weak shrink-0">{language.t("envRequest.notice.ai")}</span>
            <Show when={others().length > 0}>
              <span class="text-12-regular text-text-weaker truncate min-w-0">
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
      <Show when={props.request.reason}>
        <p class="text-12-regular text-text-weak leading-relaxed">{props.request.reason}</p>
      </Show>

      {/* 이름 = 값. 이름은 AI 가 정한 값으로 시작하고 팀이 함께 고칠 수 있다. */}
      <div class="flex items-center gap-2">
        <div class="basis-[44%] shrink-0 min-w-0">
          <TextField
            class="font-mono"
            label={language.t("envRequest.field.name.label")}
            hideLabel
            autocomplete="off"
            value={draft.key}
            disabled={readonly}
            onChange={(v) => edit("key", v)}
          />
        </div>
        <span class="font-mono text-13-regular text-text-weaker shrink-0">=</span>
        <div class="flex-1 min-w-0">
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
            onChange={(v) => edit("value", v)}
            onBlur={() => broadcast(false)}
          />
        </div>
      </div>

      <Show when={props.request.docsUrl}>
        {(url) => (
          <span class="text-12-regular text-text-weaker truncate">
            {language.t("envRequest.notice.docs", { url: url() })}
          </span>
        )}
      </Show>
      <Show when={readonly}>
        <span class="text-12-regular text-text-weaker">{language.t("envRequest.readonly")}</span>
      </Show>
    </DockPrompt>
  )
}
