import type { AwarenessSource, BlobSource, DocSource } from "@blocksuite/sync"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { CLOSE_SESSION_ENDED, MSG_AWARENESS, MSG_DOC, pack, unpack } from "./doc-sync-protocol"
import { apiUrl } from "@/utils/api-url"

// Eagerly resolved so we can encode an awareness removal SYNCHRONOUSLY during page unload
// (`pagehide`), where an async dynamic import would never resolve before the page is torn down.
let awarenessMod: typeof import("y-protocols/awareness") | undefined
void import("y-protocols/awareness").then((mod) => {
  awarenessMod = mod
})

export type DocSyncOpts = {
  docID: string
  baseUrl: string
  directory: string
  client: OpencodeClient
  actorID: string
  name?: string
  color: string
}

function b64(input: Uint8Array) {
  let binary = ""
  for (const byte of input) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromB64(value: string) {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function url(opts: DocSyncOpts, path: string) {
  const next = apiUrl(opts.baseUrl, path)
  next.searchParams.set("directory", opts.directory)
  return next
}

async function blobB64(blob: Blob) {
  return b64(new Uint8Array(await blob.arrayBuffer()))
}

const RETRY_BASE = 250
const RETRY_MAX = 4_000
const RETRY_DEADLINE = 60_000
// 세션 pod이 죽어 라우트가 사라졌을 때 허브 프록시가 반환하는 상태 코드. 503은 의도적으로 제외:
// 프록시 재시작·스케일링 중 일시적으로 발생할 수 있어 gone으로 취급하면 살아있는 세션을 영구
// 중단시킨다. 모호한 케이스는 재시도 데드라인이 흡수한다.
const GONE_STATUSES = new Set([404, 424])

function sessionGone(opts: DocSyncOpts) {
  return opts.client.doc.cycle
    .list(
      { docID: opts.docID, directory: opts.directory, limit: 1 },
      { cache: "no-store", throwOnError: false },
    )
    .then((res) => GONE_STATUSES.has(res.response?.status ?? 0))
    .catch(() => false)
}

function notifySessionEnded() {
  if (typeof window === "undefined" || window.parent === window) return
  window.parent.postMessage({ type: "opencode:session-ended" }, "*")
}

// doc/awareness 소켓이 공유하는 재연결 상태 머신. 지수 백오프로 재시도하고, 매 시도 전에 세션
// 생존을 프로브하며, 세션 사망이 확정되거나 최초 실패 후 데드라인이 지나면 (임베딩 페이지에
// 알리고) 영구 중단한다.
function reconnector(input: { connect: () => void; stop: () => void; gone: () => Promise<boolean> }) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let tries = 0
  let firstFailure: number | undefined
  let disposed = false

  const ended = () => {
    notifySessionEnded()
    input.stop()
  }

  const retry = () => {
    if (disposed || timer) return
    const now = Date.now()
    firstFailure ??= now
    if (now - firstFailure > RETRY_DEADLINE) {
      ended()
      return
    }
    const ms = Math.min(RETRY_BASE * 2 ** Math.min(tries, 4), RETRY_MAX)
    timer = setTimeout(async () => {
      timer = undefined
      if (disposed) return
      if (await input.gone()) {
        if (disposed) return
        ended()
        return
      }
      if (disposed) return
      tries += 1
      input.connect()
    }, ms)
  }

  return {
    retry,
    reset() {
      tries = 0
      firstFailure = undefined
      if (timer) clearTimeout(timer)
      timer = undefined
    },
    close(code: number) {
      if (code === 1000) {
        input.stop()
        return
      }
      if (code === CLOSE_SESSION_ENDED) {
        ended()
        return
      }
      retry()
    },
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}

export class OpencodeDocSource implements DocSource {
  name = "opencode"
  ready = Promise.resolve()
  private ws?: WebSocket
  private unsub?: () => void
  private _closed = false

  constructor(private opts: DocSyncOpts) {}

  async pull(docId: string, state: Uint8Array) {
    let delay = 500
    while (!this._closed) {
      try {
        const res = await this.opts.client.doc.sync.pull(
          {
            docID: this.opts.docID,
            directory: this.opts.directory,
            guid: docId,
            ...(state.length > 0 ? { state: b64(state) } : {}),
          },
          { cache: "no-store" },
        )
        const json = res.data
        if (!json) return null
        return {
          data: fromB64(json.data),
          state: json.state ? fromB64(json.state) : undefined,
        }
      } catch {
        if (this._closed) return null
        await new Promise<void>((r) => setTimeout(r, delay))
        delay = Math.min(delay * 2, 8000)
      }
    }
    return null
  }

  async push(docId: string, data: Uint8Array) {
    const ws = this.ws
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(pack(MSG_DOC, docId, data))
      return
    }
    await this.opts.client.doc.sync.push({
      docID: this.opts.docID,
      directory: this.opts.directory,
      data: b64(data),
      guid: docId,
    })
  }

  subscribe(cb: (docId: string, data: Uint8Array) => void, _disconnect: (reason: string) => void) {
    const next = url(this.opts, `/doc/${this.opts.docID}/connect`)
    next.searchParams.set("kind", "doc")
    next.protocol = next.protocol === "https:" ? "wss:" : "ws:"
    let done = false
    let closed = false
    let ready: ((stop: () => void) => void) | undefined
    let ws: WebSocket | undefined
    this.ready = Promise.resolve()

    const onMsg = (event: MessageEvent) => {
      const raw =
        event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : typeof event.data === "string"
            ? new TextEncoder().encode(event.data)
            : undefined
      if (!raw || raw.length === 0) return
      const msg = unpack(raw)
      if (msg?.type === MSG_DOC) {
        cb(msg.guid, msg.data)
        return
      }
      if (raw[0] === MSG_DOC) cb(this.opts.docID, raw.subarray(1))
    }

    const stop = () => {
      closed = true
      recon.dispose()
      ws?.removeEventListener("message", onMsg)
      if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) ws.close(1000)
      if (done) return
      done = true
      ready?.(stop)
    }
    this.unsub = stop

    const connect = () => {
      if (closed) return
      const socket = new WebSocket(next)
      socket.binaryType = "arraybuffer"
      ws = socket
      this.ws = socket
      socket.addEventListener("message", onMsg)
      socket.addEventListener("open", () => {
        recon.reset()
        if (done) return
        done = true
        ready?.(stop)
      })
      socket.addEventListener("close", (event) => {
        if (ws === socket) this.ws = undefined
        if (closed) return
        recon.close(event.code)
      })
      socket.addEventListener("error", () => {
        if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) socket.close()
        recon.retry()
      })
    }

    const recon = reconnector({ connect, stop, gone: () => sessionGone(this.opts) })

    connect()

    return new Promise<() => void>((resolve) => {
      if (done) {
        resolve(stop)
        return
      }
      ready = resolve
    })
  }

  close() {
    this._closed = true
    this.unsub?.()
    this.unsub = undefined
    this.ws = undefined
  }
}

export type BlobUploadOpts = {
  /** Bytes put on the wire so far / in total. Reported only on the XHR path (see progressFetch). */
  onProgress?: (loaded: number, total: number) => void
  signal?: AbortSignal
}

function headers(raw: string) {
  const out = new Headers()
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(":")
    if (idx <= 0) continue
    try {
      out.append(line.slice(0, idx).trim(), line.slice(idx + 1).trim())
    } catch {}
  }
  return out
}

// fetch() cannot report request-body progress, so an upload that takes 30s on a slow line looks
// identical to one that never started. XHR does report it — hand this to the SDK as a one-off
// `fetch` for the asset POST and the client's own Request (auth headers, directory rewrite,
// interceptors) is preserved; only the transport changes.
function progressFetch(onProgress: (loaded: number, total: number) => void): typeof fetch {
  const send = (input: URL | RequestInfo) =>
    new Promise<Response>((resolve, reject) => {
      const req = input as Request
      const xhr = new XMLHttpRequest()
      xhr.open(req.method, req.url, true)
      xhr.responseType = "text"
      req.headers.forEach((value, name) => {
        try {
          xhr.setRequestHeader(name, value)
        } catch {}
      })
      xhr.upload.addEventListener("progress", (event) => {
        onProgress(event.loaded, event.lengthComputable ? event.total : 0)
      })
      xhr.addEventListener("load", () => {
        resolve(
          new Response(xhr.responseText, {
            status: xhr.status,
            statusText: xhr.statusText,
            headers: headers(xhr.getAllResponseHeaders()),
          }),
        )
      })
      // A transport-level failure (offline, CORS — desktop shells route fetch through the platform
      // and reject a raw XHR) is a TypeError, exactly what fetch() throws. The caller retries once
      // on the client's own fetch, so this stays a progress upgrade rather than a hard dependency.
      xhr.addEventListener("error", () => reject(new TypeError("doc asset upload failed")))
      xhr.addEventListener("timeout", () => reject(new TypeError("doc asset upload timed out")))
      xhr.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
      const signal = req.signal
      if (signal) {
        if (signal.aborted) {
          reject(new DOMException("aborted", "AbortError"))
          return
        }
        signal.addEventListener("abort", () => xhr.abort(), { once: true })
      }
      req
        .text()
        .then((body) => xhr.send(body))
        .catch(reject)
    })
  // The SDK only ever calls its `fetch` with a Request; the extra statics on the runtime's fetch
  // type (preconnect) are never touched.
  return send as unknown as typeof fetch
}

export class OpencodeBlobSource implements BlobSource {
  name = "opencode-blob"
  readonly = false
  // Blobs this client attached. The block references its asset the moment it is added — before the
  // bytes reach the server — so our own get() would 404 on a file we just picked. Keeping the blob
  // here is what lets the author see their own image while it is still uploading.
  private local = new Map<string, Blob>()

  /**
   * Answers "does the server have these bytes?" every time a fetch settles it. A 404 is normal while
   * an upload is still on the wire, and permanent when the tab was closed mid-transfer: the block
   * reached the server over the doc socket, the bytes never did. The editor turns the standing
   * answer into the block's error mark and into the submit gate, because BlockSuite cannot — a null
   * blob leaves its image spinning forever (retry and `error` live on the throw path only).
   */
  onAssetMissing?: (key: string, missing: boolean) => void

  constructor(private opts: DocSyncOpts) {}

  async get(key: string): Promise<Blob | null> {
    const own = this.local.get(key)
    if (own) return own
    const res = await this.opts.client.doc.asset.get(
      {
        docID: this.opts.docID,
        assetID: key,
        directory: this.opts.directory,
      },
      { cache: "no-store", parseAs: "blob", throwOnError: false },
    )
    if (res.error) {
      // Only a 404 is an answer. A transport failure or a 5xx says nothing about what the server
      // holds, so it must not mark the asset gone and block the prompt.
      if (res.response.status === 404) {
        this.onAssetMissing?.(key, true)
        return null
      }
      throw new Error("doc asset fetch failed")
    }
    this.onAssetMissing?.(key, false)
    return (res.data as Blob | undefined) ?? null
  }

  async set(key: string, value: Blob) {
    await this.upload(key, value)
    return key
  }

  /** Cache the blob locally without uploading — for a block that renders before its upload starts. */
  remember(key: string, value: Blob) {
    this.local.set(key, value)
  }

  async upload(key: string, value: Blob, opts: BlobUploadOpts = {}) {
    this.local.set(key, value)
    const data = await blobB64(value)
    const body = {
      docID: this.opts.docID,
      directory: this.opts.directory,
      id: key,
      mime: value.type || "application/octet-stream",
      data,
    }
    const send = (transport?: typeof fetch) =>
      this.opts.client.doc.asset.create(body, {
        throwOnError: true,
        ...(transport ? { fetch: transport } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
    // `data` is what actually travels, so its length — not the raw file size — is the byte total.
    const total = data.length
    try {
      await send(progressFetch((loaded, size) => opts.onProgress?.(loaded, size || total)))
    } catch (err) {
      if (opts.signal?.aborted) throw err
      // XHR is unreachable in shells that proxy fetch (Tauri/Electron). Retry once on the client's
      // own transport; the upload still completes, just without a percentage.
      await send()
    }
    opts.onProgress?.(total, total)
    this.onAssetMissing?.(key, false)
    return key
  }

  async delete(_key: string) {}

  /**
   * The ids this doc's asset store actually holds — ids only, no bytes.
   *
   * This is the authoritative answer to "is it already up there?", which the doc's own blocks are
   * not: a block whose upload was aborted mid-flight (tab closed, session switched) stays in the doc
   * with nothing behind it.
   */
  async list() {
    const res = await this.opts.client.doc.asset.list(
      { docID: this.opts.docID, directory: this.opts.directory },
      { cache: "no-store", throwOnError: false },
    )
    return res.data ?? []
  }
}

export class OpencodeAwarenessSource implements AwarenessSource {
  name = "opencode-awareness"
  private awareness?: import("y-protocols/awareness").Awareness
  private ws?: WebSocket
  private stop?: () => void

  constructor(private opts: DocSyncOpts) {}

  connect(awareness: import("y-protocols/awareness").Awareness) {
    this.awareness = awareness
    const next = url(this.opts, `/doc/${this.opts.docID}/connect`)
    next.searchParams.set("kind", "awareness")
    next.protocol = next.protocol === "https:" ? "wss:" : "ws:"
    let closed = false
    let ws: WebSocket | undefined

    const onUpdate = (
      changes: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      if (origin === "remote") return
      if (ws?.readyState !== WebSocket.OPEN) return
      const changed = changes.added.concat(changes.updated, changes.removed)
      if (changed.length === 0) return
      void import("y-protocols/awareness").then((mod) => {
        const update = mod.encodeAwarenessUpdate(awareness, changed)
        ws?.send(pack(MSG_AWARENESS, "", update))
      })
    }

    awareness.on("update", onUpdate)

    const onMsg = (event: MessageEvent) => {
      const raw =
        event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : typeof event.data === "string"
            ? new TextEncoder().encode(event.data)
            : undefined
      if (!raw || raw.length === 0) return
      const msg = unpack(raw)
      const data = msg?.type === MSG_AWARENESS ? msg.data : raw[0] === MSG_AWARENESS ? raw.subarray(1) : undefined
      if (!data) return
      void import("y-protocols/awareness").then((mod) => {
        mod.applyAwarenessUpdate(awareness, data, "remote")
      })
    }

    const connect = () => {
      if (closed) return
      const socket = new WebSocket(next)
      socket.binaryType = "arraybuffer"
      ws = socket
      this.ws = socket
      socket.addEventListener("open", () => {
        recon.reset()
        void import("y-protocols/awareness").then((mod) => {
          socket.send(pack(MSG_AWARENESS, "", mod.encodeAwarenessUpdate(awareness, [awareness.clientID])))
        })
      })
      socket.addEventListener("message", onMsg)
      socket.addEventListener("close", (event) => {
        if (ws === socket) this.ws = undefined
        if (closed) return
        recon.close(event.code)
      })
      socket.addEventListener("error", () => {
        if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) socket.close()
        recon.retry()
      })
    }

    const recon = reconnector({ connect, stop: () => stop(), gone: () => sessionGone(this.opts) })

    connect()

    // 백그라운드 탭에서 복귀: 브라우저가 백오프 타이머를 스로틀링하는 동안 소켓을 닫았을 수
    // 있으므로, 타이머를 기다리는 대신 백오프를 처음부터 다시 시작한다. 재연결되면 소켓 "open"
    // 시점에 로컬 awareness 상태를 다시 알려 피어들에게 내 커서가 복원된다.
    const onVisible = () => {
      if (closed) return
      if (typeof document === "undefined" || document.visibilityState !== "visible") return
      if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) return
      recon.reset()
      recon.retry()
    }
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible)

    // Clear our local state and broadcast the removal so peers drop our cursor right away. Synchronous
    // (uses the eagerly-loaded encoder) so it works even during page unload. The grace window on the
    // server exists only to ride out an AMBIGUOUS close (tab switch / network blip / freeze) where we
    // never got to signal; an explicit removal here makes a real leave immediate.
    const announceLeave = () => {
      const sock = ws
      if (!awarenessMod || sock?.readyState !== WebSocket.OPEN) {
        awareness.setLocalState(null)
        return
      }
      awareness.off("update", onUpdate)
      awareness.setLocalState(null)
      try {
        sock.send(pack(MSG_AWARENESS, "", awarenessMod.encodeAwarenessUpdate(awareness, [awareness.clientID])))
      } catch {}
    }

    // A real browser/tab close or navigation fires `pagehide` (a mere tab switch does NOT). Skip the
    // bfcache case (`persisted`) since the page may be restored with our cursor intact.
    const onPageHide = (event: PageTransitionEvent) => {
      if (closed || event.persisted) return
      announceLeave()
    }
    if (typeof window !== "undefined") window.addEventListener("pagehide", onPageHide)

    const stop = () => {
      if (closed) return
      closed = true
      recon.dispose()
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible)
      if (typeof window !== "undefined") window.removeEventListener("pagehide", onPageHide)
      // CLEAN disconnect (unmount/navigation): drop our cursor on peers immediately instead of letting
      // the server's grace timer leave it as a ghost.
      announceLeave()
      awareness.off("update", onUpdate)
      if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) ws.close(1000)
    }
    this.stop = stop
  }

  disconnect() {
    this.stop?.()
    this.stop = undefined
    this.ws = undefined
    this.awareness = undefined
  }
}
