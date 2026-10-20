import { createSignal, onCleanup } from "solid-js"
import { WindowMessenger, connect, type Connection, type RemoteProxy } from "penpal"
import type {
  ChildMethods,
  ConsoleEntry,
  ErrorEntry,
  LocationInfo,
  ParentMethods,
  PickedElement,
} from "./preview-bridge-protocol"

const MAX_LOG = 200

// 부모(앱)측 미리보기 브릿지. iframe 결과물(자식 브릿지)과 penpal 로 연결하고, load 마다 ping 으로 연결을 확인해
// 응답이 없을 때만 재연결한다.
export function createPreviewBridge(opts: { origin: () => string | undefined }) {
  const [connected, setConnected] = createSignal(false)
  const [child, setChild] = createSignal<RemoteProxy<ChildMethods> | undefined>()
  const [consoles, setConsoles] = createSignal<ConsoleEntry[]>([])
  const [errors, setErrors] = createSignal<ErrorEntry[]>([])
  const [picked, setPicked] = createSignal<PickedElement | undefined>()
  const [location, setLocation] = createSignal<LocationInfo | undefined>()

  // penpal 핸드셰이크 timeout(미지정 시 실패해도 reject 안 됨) + 끊긴 동안 재연결 간격.
  const HANDSHAKE_TIMEOUT_MS = 5000
  const RECONNECT_INTERVAL_MS = 3000
  const PING_INTERVAL_MS = 250
  const PING_ATTEMPTS = 6

  let connection: Connection<ChildMethods> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let pingTimer: ReturnType<typeof setTimeout> | undefined
  let currentIframe: HTMLIFrameElement | undefined

  const methods: ParentMethods = {
    onConsole: (entry) => setConsoles((prev) => [...prev, entry].slice(-MAX_LOG)),
    onError: (entry) => setErrors((prev) => [...prev, entry].slice(-MAX_LOG)),
    onElementPicked: (element) => setPicked(element),
    onLocationChange: (loc) => setLocation(loc),
  }

  const clearRetry = () => {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = undefined
  }

  const teardown = () => {
    clearRetry()
    connection?.destroy()
    connection = undefined
    setConnected(false)
    setChild(undefined)
  }

  const scheduleRetry = () => {
    clearRetry()
    retryTimer = setTimeout(() => {
      if (!connected() && currentIframe) linkConnection(currentIframe)
    }, RECONNECT_INTERVAL_MS)
  }

  const linkConnection = (iframe: HTMLIFrameElement) => {
    currentIframe = iframe
    clearRetry()
    connection?.destroy()
    connection = undefined
    setConnected(false)
    setChild(undefined)
    const remoteWindow = iframe.contentWindow
    const origin = opts.origin()
    if (!remoteWindow || !origin) return scheduleRetry()

    const conn = connect<ChildMethods>({
      messenger: new WindowMessenger({ remoteWindow, allowedOrigins: [origin] }),
      methods,
      timeout: HANDSHAKE_TIMEOUT_MS,
    })
    connection = conn
    conn.promise
      .then((remote) => {
        setChild(() => remote)
        setConnected(true)
      })
      .catch(() => {
        // 자식에 브릿지가 없거나(주입 전) 핸드셰이크 실패/끊김 — 재시도.
        setConnected(false)
        setChild(undefined)
        scheduleRetry()
      })
  }

  const attach = (iframe: HTMLIFrameElement | null) => {
    if (!iframe) {
      currentIframe = undefined
      return teardown()
    }
    const onLoad = () => {
      clearTimeout(pingTimer)
      const current = connection
      if (!current) return linkConnection(iframe)
      let attempts = 0
      const probe = () => {
        if (connection !== current) return
        if (attempts++ >= PING_ATTEMPTS) return linkConnection(iframe)
        const timer = setTimeout(probe, PING_INTERVAL_MS)
        pingTimer = timer
        current.promise
          .then((remote) => remote.ping())
          .then(
            () => clearTimeout(timer),
            () => {},
          )
      }
      probe()
    }
    iframe.addEventListener("load", onLoad)
    // 이미 로드된 경우(캐시) 즉시 시도.
    if (iframe.contentWindow) linkConnection(iframe)
    onCleanup(() => {
      clearTimeout(pingTimer)
      iframe.removeEventListener("load", onLoad)
      teardown()
    })
  }

  onCleanup(teardown)

  const clearLogs = () => {
    setConsoles([])
    setErrors([])
  }

  return { attach, connected, child, consoles, errors, picked, location, clearLogs }
}

export type PreviewBridge = ReturnType<typeof createPreviewBridge>
