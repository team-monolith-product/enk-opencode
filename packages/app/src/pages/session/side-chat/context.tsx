import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
  useContext,
  type ParentProps,
} from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { showToast } from "@opencode-ai/ui/toast"
import { parseAssetRef } from "@opencode-ai/util/attachment-ref"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import { useParentParams } from "@/context/parent-params"
import { usePromptDocBridge } from "@/context/prompt-doc-bridge"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { sessionBusy } from "@/components/prompt-input/composer-state"
import { Persist, persisted } from "@/utils/persist"
import { Identifier } from "@/utils/id"
import { SIDE_AGENT, findAttachment, pendingHandoffs, type AttachmentSource } from "@/utils/side-session"
import { claimHandoff, excerpt, insertHandoff, prepareHandoff, type HandoffSources } from "./handoff"

/** 사이드 컴포저에 붙인 이미지·파일. url 은 data url. */
export type SideAttachment = { id: string; name: string; mime: string; url: string; size: number }

// 메인 세션별 사이드 세션 ID 와 이미 넣은 handoff 호출. 개인용이라 브라우저 로컬에만 둔다.
type Entry = { sessionID: string; handled: string[]; time: number }

/** 입력 중인 사이드 컴포저 초안. 탭을 옮겨 패널이 내려가도 남도록 세션 레벨에 둔다. */
export type SideDraft = { text: string; attachments: SideAttachment[] }

// 다시 찾지 않는 메인 세션(지워졌는데 이 브라우저가 몰랐던 것 등)의 항목이 끝없이 쌓이지 않게 최근 것만 둔다.
const MAX_ENTRIES = 50
// 스토어에 넣으면 프록시로 감싸져 이후 병합으로 바뀐다 — 공유 상수 대신 매번 새 객체를 쓴다.
const emptyDraft = (): SideDraft => ({ text: "", attachments: [] })

function createSideChat() {
  const params = useParams()
  const sdk = useSDK()
  const sync = useSync()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const local = useLocal()
  const language = useLanguage()
  const bridge = usePromptDocBridge()
  const readonly = useParentParams().readonly

  const [store, setStore, , ready] = persisted(
    Persist.global("side-chat.v1"),
    createStore<{ entries: Record<string, Entry | undefined> }>({ entries: {} }),
  )

  const key = createMemo(() => (params.dir && params.id ? `${params.dir}/${params.id}` : undefined))
  const entry = createMemo(() => {
    const k = key()
    return k ? store.entries[k] : undefined
  })
  const sessionID = createMemo(() => entry()?.sessionID)
  const [creating, setCreating] = createSignal(false)

  const messages = createMemo(() => {
    const id = sessionID()
    return id ? sync.data.message[id] : undefined
  })
  const session = createMemo(() => {
    const id = sessionID()
    return id ? sync.session.get(id) : undefined
  })
  const busy = createMemo(() => {
    const id = sessionID()
    if (!id) return false
    return sessionBusy(sync.data.session_status[id] ?? { type: "idle" }, sync.data.message[id])
  })

  const forget = (k: string) => setStore("entries", k, undefined)

  // 사이드 세션을 불러오고 캐시에서 밀려나지 않게 고정한다. 지워진 세션이면(다른 탭에서 닫음 등) 잊는다.
  createEffect(() => {
    const id = sessionID()
    const k = key()
    if (!id || !k) return
    onCleanup(globalSync.session.pin(id))
    // 이 매핑이 숨은 사이드 세션을 다시 여는 유일한 길이다. 네트워크·서버 오류로 잃으면 안 되므로,
    // 세션이 정말 없다고(404) 확인됐을 때만 잊는다. 그 밖의 실패는 재연결 때 다시 받는다.
    void sync.session.sync(id).catch(async () => {
      const res = await sdk.client.session.get({ sessionID: id }, { throwOnError: false }).catch(() => undefined)
      if (res?.response?.status !== 404) return
      if (untrack(key) === k && untrack(sessionID) === id) forget(k)
    })
  })

  // 끊겨 있던 동안의 이벤트는 다시 오지 않으므로 다시 붙으면 통째로 다시 받는다(directory-layout 과 같은 이유).
  const unsubscribe = globalSDK.event.listen((e) => {
    if (e.name !== "global" || e.details?.type !== "server.connected") return
    const id = untrack(sessionID)
    if (id) void sync.session.sync(id, { force: true }).catch(() => {})
  })
  onCleanup(unsubscribe)

  const open = async () => {
    const k = key()
    const main = params.id
    if (!k || !main || readonly) return
    if (entry()?.sessionID) return entry()!.sessionID
    if (creating()) return
    setCreating(true)
    try {
      const res = await sdk.client.session.fork({ sessionID: main, side: true })
      const created = res.data
      if (!created) return
      const entries = { ...store.entries, [k]: { sessionID: created.id, handled: [], time: Date.now() } }
      const keep = Object.entries(entries)
        .filter((item): item is [string, Entry] => !!item[1])
        .sort((a, b) => (b[1].time ?? 0) - (a[1].time ?? 0))
        .slice(0, MAX_ENTRIES)
      setStore("entries", reconcile(Object.fromEntries(keep)))
      return created.id
    } catch {
      showToast({ title: language.t("sideChat.toast.openFailed") })
    } finally {
      setCreating(false)
    }
  }

  const remove = async (id: string) => {
    await sdk.client.session.abort({ sessionID: id }).catch(() => {})
    await sdk.client.session.delete({ sessionID: id }).catch(() => {})
  }

  const close = async () => {
    const k = key()
    const id = sessionID()
    if (!k || !id) return
    forget(k)
    await remove(id)
  }

  /** 지금 시점의 메인 대화로 다시 포크한다. */
  const restart = async () => {
    await close()
    return open()
  }

  const send = async (text: string, images: SideAttachment[]) => {
    const id = sessionID()
    const model = local.model.current()
    if (!id || !model || (!text.trim() && images.length === 0)) return false
    // 붙인 이미지·파일마다 doc 모드와 같은 attachment:// 표기를 실어, AI 가 handoff 에서 같은 이름으로 가리키게 한다.
    const links = images.map((item) => {
      const link = `[${item.name}](attachment://${encodeURIComponent(item.name)})`
      return item.mime.startsWith("image/") ? `!${link}` : link
    })
    try {
      await sdk.client.session.promptAsync({
        sessionID: id,
        agent: SIDE_AGENT,
        model: { providerID: model.provider.id, modelID: model.id },
        variant: local.model.variant.current(),
        messageID: Identifier.ascending("message"),
        parts: [
          ...(text.trim() ? [{ id: Identifier.ascending("part"), type: "text" as const, text: text.trim() }] : []),
          // 모델만 보는 표기라 synthetic 으로 둔다 — 말풍선에는 사용자가 쓴 글만 보인다.
          ...(links.length
            ? [{ id: Identifier.ascending("part"), type: "text" as const, text: links.join("\n"), synthetic: true }]
            : []),
          ...images.map((image) => ({
            id: Identifier.ascending("part"),
            type: "file" as const,
            mime: image.mime,
            url: image.url,
            filename: image.name,
          })),
        ],
      })
      return true
    } catch {
      showToast({ title: language.t("sideChat.toast.sendFailed") })
      return false
    }
  }

  const abort = () => {
    const id = sessionID()
    if (id) void sdk.client.session.abort({ sessionID: id }).catch(() => {})
  }

  // ── 넘기기: 끝난 handoff 툴 호출을 메인 프롬프트 doc 에 블록으로 넣는다 ─────────────────────────

  const handled = createMemo(() => new Set(entry()?.handled ?? []))
  // 관전자는 메인 doc 을 고칠 수 없다 — 예전 기록이 남아 있어도 넘기기를 시도하지(대기 토스트도) 않는다.
  const pending = createMemo(() => (ready() && !readonly ? pendingHandoffs(messages(), sync.data.part, handled()) : []))
  let flushing = false
  // 대기 안내는 기다림 한 번에 한 번만 띄운다 — 효과가 다시 돌 때마다 토스트가 쌓이지 않게.
  let waitingNotified = false

  // 넘기기 결과는 토스트로 알린다. 사이드 탭을 안 보고 있어도(세션 레벨) 결과가 보인다.
  const notify = (result: { failed: string[]; overflow: boolean; tooLarge: boolean }) => {
    const notes = [
      result.failed.length ? language.t("sideChat.handoff.failed", { items: result.failed.join(", ") }) : undefined,
      result.overflow || result.tooLarge ? language.t("sideChat.handoff.overflow") : undefined,
    ].filter((note): note is string => !!note)
    showToast({
      variant: notes.length ? "default" : "success",
      title: language.t("sideChat.handoff.done"),
      description: notes.length ? notes.join(" · ") : undefined,
    })
  }

  const bytes = async (source: AttachmentSource): Promise<Blob | undefined> => {
    const ref = parseAssetRef(source.url)
    if (ref) {
      // 프롬프트 doc 은 보낼 때마다 새 docID 로 바뀌고 첨부는 doc 별로 저장된다 — 예전 메시지의 첨부는
      // 지금 입력창 doc 에 없으니 바이트를 받아 다시 올린다.
      const res = await sdk.client.doc.asset.get(
        { docID: ref.docID, assetID: ref.assetID },
        { cache: "no-store", parseAs: "blob", throwOnError: false },
      )
      return res.data instanceof Blob ? res.data : undefined
    }
    if (source.url.startsWith("file://")) return workspace(decodeURIComponent(new URL(source.url).pathname))
    return fetch(source.url)
      .then((res) => (res.ok ? res.blob() : undefined))
      .catch(() => undefined)
  }

  const workspace = async (path: string): Promise<Blob | undefined> => {
    const res = await sdk.client.file.read({ path }).catch(() => undefined)
    const data = res?.data
    // 이미지는 type "text" + encoding "base64" 로 온다(file/index.ts). type 이 아니라 인코딩과 내용으로 본다 —
    // 이미지가 아닌 바이너리는 내용이 비어 온다.
    if (!data || data.encoding !== "base64" || !data.content) return
    const bin = atob(data.content)
    return new Blob([Uint8Array.from(bin, (c) => c.charCodeAt(0))], {
      type: data.mimeType ?? "application/octet-stream",
    })
  }

  // 넘길 첨부의 바이트 — 사이드 세션 대화(포크된 메인 기록 포함)의 파일 파트에서 이름으로 찾는다.
  // 처음엔 최근 80개만 받아 두므로, 없으면 이전 페이지를 받아 가며 찾는다 — 서버 handoff 툴은 모델이 보는
  // 전체 기록으로 이름을 확인했으니, 화면에 안 받은 페이지에 있을 수 있다.
  const MAX_HISTORY_PAGES = 20
  const sources = (id: string): HandoffSources => ({
    workspace,
    attachment: async (name) => {
      let source = findAttachment(sync.data.message[id], sync.data.part, name)
      for (let page = 0; !source && page < MAX_HISTORY_PAGES && sync.session.history.more(id); page++) {
        await sync.session.history.loadMore(id)
        source = findAttachment(sync.data.message[id], sync.data.part, name)
      }
      if (!source) return
      const blob = await bytes(source).catch(() => undefined)
      if (!blob) return
      return { blob, filename: source.filename ?? name, mime: source.mime }
    },
  })

  const markHandled = (k: string, callID: string) =>
    // 개수로 자르지 않는다 — 아직 대화에 남아 있는 호출을 밀어내면 그 호출이 다시 대기로 올라와 flush 가
    // 끝없이 돈다. 이 목록은 사이드 세션 하나의 넘기기 수만큼만 자라고, 닫으면 항목째 지워진다(MAX_ENTRIES).
    setStore("entries", k, "handled", (list) => [...(list ?? []), callID])

  const flush = async () => {
    if (flushing) return
    flushing = true
    try {
      for (;;) {
        const k = untrack(key)
        const id = untrack(sessionID)
        const next = untrack(pending)[0]
        if (!k || !id || !next || !untrack(bridge.ready)) return
        try {
          const prepared = await prepareHandoff(next.input, sources(id))
          // 모으는 동안 다른 세션으로 옮겼거나 메인 입력창이 내려갔다 — 아직 아무것도 넣지 않았으니
          // 다음 기회(입력창이 다시 붙어 revision 이 오를 때)로 미룬다.
          if (untrack(key) !== k || !untrack(bridge.ready)) return
          const claimed = await claimHandoff(next.callID)
          markHandled(k, next.callID)
          // 같은 브라우저의 다른 탭이 이미 넣었다.
          if (!claimed) continue
          waitingNotified = false
          notify(await insertHandoff(prepared, bridge))
        } catch {
          // 다시 돌면 같은 실패를 반복하므로 처리한 것으로 두고 알린다.
          markHandled(k, next.callID)
          notify({ failed: [excerpt(next.input.text)], overflow: false, tooLarge: false })
        }
      }
    } finally {
      flushing = false
      // 이 flush 가 도는 동안 들어온 호출(다른 세션으로 옮겨 생긴 대기 등)은 가드에 막혀 그냥 돌아갔다.
      // 가드는 반응형이 아니라 풀려도 효과가 다시 돌지 않으므로, 남은 일이 있고 받을 곳이 있으면 다시 돈다.
      if (untrack(pending).length > 0 && untrack(bridge.ready)) queueMicrotask(() => void flush())
    }
  }

  createEffect(() => {
    bridge.revision()
    const count = pending().length
    if (count === 0) return
    if (!bridge.ready()) {
      if (!waitingNotified) showToast({ title: language.t("sideChat.handoff.waiting") })
      waitingNotified = true
      return
    }
    void flush()
  })

  // ── 초안 ──────────────────────────────────────────────────────────────────────────────────────
  // data url 첨부가 클 수 있어 브라우저 저장소에는 두지 않는다 — 새로고침까지는 지키지 않는다.
  const [drafts, setDrafts] = createStore<Record<string, SideDraft | undefined>>({})
  const draft = () => {
    const k = key()
    return (k && drafts[k]) || emptyDraft()
  }
  /** 비동기 작업이 끝났을 때 처음 시작한 세션의 초안에 쓰도록, 시작 시점의 초안 키를 잡아 둔다. */
  const draftKey = () => untrack(key)
  const draftFor = (k: string | undefined) => (k && drafts[k]) || emptyDraft()
  const snapshot = (value: SideDraft | undefined): SideDraft =>
    value ? { text: value.text, attachments: value.attachments.map((item) => ({ ...item })) } : emptyDraft()
  const updateDraft = (next: (current: SideDraft) => SideDraft, k = untrack(key)) => {
    if (!k) return
    // 객체를 그냥 넘기면 기존 항목에 얕게 병합된다 — 통째로 바꾼다.
    setDrafts(k, reconcile(next(snapshot(drafts[k]))))
  }

  /**
   * 보낼 초안을 꺼내며 비운다. 요청이 늦게 끝나는 동안 새로 쓴 글이나 다른 세션의 초안을 지우지 않도록
   * 비우기는 보내기 전에 하고, 실패하면 그 세션 초안이 아직 비어 있을 때만 되돌린다.
   */
  const takeDraft = () => {
    const k = untrack(key)
    // 스토어 프록시를 들고 있으면 바로 아래 비우기가 그 값까지 지운다 — 평범한 사본으로 꺼낸다.
    const taken = snapshot(k ? drafts[k] : undefined)
    updateDraft(emptyDraft, k)
    return {
      draft: taken,
      restore: () => updateDraft((current) => (current.text || current.attachments.length ? current : taken), k),
    }
  }

  return {
    draft,
    setDraftText: (text: string) => updateDraft((current) => ({ ...current, text })),
    draftKey,
    draftFor,
    setDraftAttachments: (next: (list: SideAttachment[]) => SideAttachment[], k = untrack(key)) =>
      updateDraft((current) => ({ ...current, attachments: next(current.attachments) }), k),
    takeDraft,
    /** 사이드 대화의 더 이전 기록(처음 동기화는 최근 80개만 받는다). */
    history: {
      more: () => {
        const id = sessionID()
        return !!id && sync.session.history.more(id)
      },
      loading: () => {
        const id = sessionID()
        return !!id && sync.session.history.loading(id)
      },
      loadMore: () => {
        const id = sessionID()
        if (id) void sync.session.history.loadMore(id)
      },
    },
    enabled: () => !readonly && !!params.id,
    sessionID,
    session,
    messages,
    busy,
    creating,
    open,
    close,
    restart,
    send,
    abort,
  }
}

export type SideChat = ReturnType<typeof createSideChat>

const SideChatContext = createContext<SideChat>()

export function SideChatProvider(props: ParentProps) {
  return <SideChatContext.Provider value={createSideChat()}>{props.children}</SideChatContext.Provider>
}

export function useSideChat() {
  const value = useContext(SideChatContext)
  if (!value) throw new Error("useSideChat must be used within SideChatProvider")
  return value
}
