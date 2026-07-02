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
// What the hub proxy answers once the session pod is gone and the route no longer exists.
const GONE_STATUSES = new Set([404, 424, 503])

function sessionGone(opts: DocSyncOpts) {
  return opts.client.doc.sync
    .pull(
      { docID: opts.docID, directory: opts.directory, guid: opts.docID },
      { cache: "no-store", throwOnError: false },
    )
    .then((res) => GONE_STATUSES.has(res.response?.status ?? 0))
    .catch(() => false)
}

function notifySessionEnded() {
  if (typeof window === "undefined" || window.parent === window) return
  window.parent.postMessage({ type: "opencode:session-ended" }, "*")
}

// Reconnect state machine shared by the doc and awareness sockets. Backs off exponentially, probes
// whether the session still exists before each attempt, and gives up for good (telling the embedding
// page) once the session is confirmed dead or the deadline since the first failure has passed.
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

export class OpencodeBlobSource implements BlobSource {
  name = "opencode-blob"
  readonly = false

  constructor(private opts: DocSyncOpts) {}

  async get(key: string): Promise<Blob | null> {
    const res = await this.opts.client.doc.asset.get(
      {
        docID: this.opts.docID,
        assetID: key,
        directory: this.opts.directory,
      },
      { cache: "no-store", parseAs: "blob", throwOnError: false },
    )
    if (res.error) {
      if (res.response.status === 404) return null
      throw new Error("doc asset fetch failed")
    }
    return (res.data as Blob | undefined) ?? null
  }

  async set(key: string, value: Blob) {
    await this.opts.client.doc.asset.create({
      docID: this.opts.docID,
      directory: this.opts.directory,
      id: key,
      mime: value.type || "application/octet-stream",
      data: await blobB64(value),
    })
    return key
  }

  async delete(_key: string) {}

  async list() {
    return []
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

    // Returning to a backgrounded tab: the browser may have closed the socket while throttling the
    // reconnect backoff timer, so restart the backoff from scratch instead of waiting it out.
    // Reconnecting re-announces our local awareness state (sent on socket "open"), restoring our
    // cursor for peers.
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
