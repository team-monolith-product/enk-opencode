import { DataProvider } from "@opencode-ai/ui/context"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/util/encode"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, onCleanup, type ParentProps, Show } from "solid-js"
import { useClientEnv } from "@/context/client-env"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { LocalProvider } from "@/context/local"
import { SDKProvider, useSDK } from "@/context/sdk"
import { SyncProvider, useSync } from "@/context/sync"
import { attachmentSrc } from "@/utils/attachment-src"
import { decode64 } from "@/utils/base64"
import { pickReplacementSession, REPLACEMENT_WAIT_MS, SessionFollow } from "@/utils/session-follow"
import { DocMessage } from "@/components/blocksuite/doc-message"

function DirectoryDataProvider(props: ParentProps<{ directory: string }>) {
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams()
  const sync = useSync()
  const sdk = useSDK()
  const globalSDK = useGlobalSDK()
  const env = useClientEnv()
  const slug = createMemo(() => base64Encode(props.directory))

  // 세션 이동은 어디서든 호스트가 넘긴 ?user=id||name 신원을 달고 가야 한다. 떨어뜨리면 actor 가
  // 게스트로 다시 등록된다.
  const openSession = (sessionID: string) =>
    navigate(`/${slug()}/session/${sessionID}${location.search}${location.hash}`, { replace: true })
  const openBlankSession = () => navigate(`/${slug()}/session${location.search}${location.hash}`, { replace: true })

  createEffect(() => {
    const next = sync.data.path.directory
    if (!next || next === props.directory) return
    const path = location.pathname.slice(slug().length + 1)
    navigate(`/${base64Encode(next)}${path}${location.search}${location.hash}`, { replace: true })
  })

  createEffect(() => {
    const id = params.id
    if (!id) return
    void sync.session.sync(id)
  })

  // 디렉토리 로드 시 직전(가장 최근) 세션으로 자동 복원한다. session 목록은 id 오름차순,
  // session id 는 descending 으로 발급되므로 첫 root 세션이 가장 최근 세션이다.
  let autoResumed = false
  createEffect(() => {
    if (autoResumed) return
    if (params.id) {
      autoResumed = true
      return
    }
    const recent = sync.data.session.find((s) => !s.parentID)
    if (!recent) return
    autoResumed = true
    openSession(recent.id)
  })

  // 세션 지우기는 지운 사람만의 일이 아니다. 같은 세션을 함께 보고 있던 다른 접속자에게도 세션이
  // 사라지는데(리듀서가 스토어에서 뺀다), 화면은 그대로라 지워진 대화 위에 남는다. 지워진 세션을
  // 보고 있었다면 그 자리를 대신할 세션으로 다 같이 옮겨간다.
  const followReplacement = (removedID?: string) => {
    const next = pickReplacementSession(sync.data.session, removedID)
    if (next) {
      SessionFollow.clear(props.directory)
      openSession(next.id)
      return
    }
    // 한 세션만 띄우는 워크스페이스는 서버가 지우기 요청 안에서 대체 세션을 만든다. 곧 도착할
    // session.created 를 기다렸다가 옮겨가야 모두가 같은 새 세션에서 만난다.
    if (sync.data.config.ensureSession) {
      SessionFollow.expect(props.directory)
      return
    }
    SessionFollow.clear(props.directory)
    openBlankSession()
  }

  const unsubscribeSessionRemoval = globalSDK.event.listen((e) => {
    if (e.name !== props.directory) return
    const event = e.details
    if (event?.type !== "session.updated" && event?.type !== "session.deleted") return
    const info = event.properties.info
    if (!info || info.id !== params.id) return
    if (event.type === "session.updated" && !info.time?.archived) return
    followReplacement(info.id)
  })
  onCleanup(unsubscribeSessionRemoval)

  // 자리를 비운 사이(탭 절전·네트워크 끊김)에 지워졌다면 그 이벤트는 못 받는다. 돌아왔을 때 목록만
  // 조용히 갱신되고 화면은 사라진 대화에 남는다. 그래서 스트림이 다시 붙을 때마다 지금 보고 있는
  // 세션이 아직 살아 있는지 서버에 되묻는다. 한 세션만 띄우는 워크스페이스에서만 — 그 밖에서는
  // 보관된 세션을 일부러 열어 둔 것일 수 있다.
  const unsubscribeReconnect = globalSDK.event.listen((e) => {
    if (e.name !== "global") return
    if (e.details?.type !== "server.connected") return
    const id = params.id
    if (!id) return
    if (!sync.data.config.ensureSession) return
    void sdk.client.session
      .get({ sessionID: id })
      .then((res) => {
        if (params.id !== id) return
        if (!res.data?.time?.archived) return
        followReplacement(id)
      })
      .catch(() => {
        // 완전히 지워졌으면 조회가 실패한다 — 그 역시 자리를 옮겨야 한다는 뜻이다.
        if (params.id === id) followReplacement(id)
      })
  })
  onCleanup(unsubscribeReconnect)
  onCleanup(() => SessionFollow.clear(props.directory))

  // 대체 세션을 기다리는 동안. 도착하면 옮겨가고, 이벤트가 끊겨 오지 않으면 빈 새 세션 화면으로 떨어진다.
  createEffect(() => {
    if (!SessionFollow.waiting(props.directory)) return
    const next = pickReplacementSession(sync.data.session, params.id)
    if (next) {
      SessionFollow.clear(props.directory)
      openSession(next.id)
      return
    }
    const timer = setTimeout(() => {
      if (!SessionFollow.waiting(props.directory)) return
      SessionFollow.clear(props.directory)
      openBlankSession()
    }, REPLACEMENT_WAIT_MS)
    onCleanup(() => clearTimeout(timer))
  })

  return (
    <DataProvider
      data={sync.data}
      directory={props.directory}
      onNavigateToSession={(sessionID: string) =>
        navigate(`/${slug()}/session/${sessionID}${location.search}${location.hash}`)
      }
      onSessionHref={(sessionID: string) => `/${slug()}/session/${sessionID}${location.search}`}
      onAssetUrl={(url: string) => attachmentSrc({ baseUrl: sdk.url, directory: sdk.directory, url })}
      hideMinorErrors={env.disableMinorErrors()}
      doc={(props) => <DocMessage id={props.id} fallback={props.fallback} />}
    >
      <LocalProvider>{props.children}</LocalProvider>
    </DataProvider>
  )
}

export default function Layout(props: ParentProps) {
  const params = useParams()
  const language = useLanguage()
  const navigate = useNavigate()
  let invalid = ""

  const resolved = createMemo(() => {
    if (!params.dir) return ""
    return decode64(params.dir) ?? ""
  })

  createEffect(() => {
    const dir = params.dir
    if (!dir) return
    if (resolved()) {
      invalid = ""
      return
    }
    if (invalid === dir) return
    invalid = dir
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: language.t("directory.error.invalidUrl"),
    })
    navigate("/", { replace: true })
  })

  return (
    <Show when={resolved()} keyed>
      {(resolved) => (
        <SDKProvider directory={() => resolved}>
          <SyncProvider>
            <DirectoryDataProvider directory={resolved}>{props.children}</DirectoryDataProvider>
          </SyncProvider>
        </SDKProvider>
      )}
    </Show>
  )
}
