import { afterEach, describe, expect, test } from "bun:test"
import { liveSocket } from "./doc-submit"

// The consent socket IS this client's membership in a vote, so the interesting cases are the ones
// where the connection is gone but the browser has not noticed: on a real device that is a wifi
// handover or a proxy dropping the tunnel, and the socket sits in OPEN for minutes while the server
// has already dropped the participant from the vote (no dialog, no casts, no reconnect).

class FakeSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeSocket[] = []

  readyState = FakeSocket.CONNECTING
  sent: string[] = []
  private listeners: Record<string, ((event: unknown) => void)[]> = {}

  constructor(public url: URL | string) {
    FakeSocket.instances.push(this)
  }

  addEventListener(type: string, fn: (event: unknown) => void) {
    ;(this.listeners[type] ??= []).push(fn)
  }
  removeEventListener() {}
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.readyState = FakeSocket.CLOSED
  }

  private emit(type: string, event: unknown) {
    for (const fn of this.listeners[type] ?? []) fn(event)
  }
  /** Server accepted the connection. */
  open() {
    this.readyState = FakeSocket.OPEN
    this.emit("open", {})
  }
  message(data: string) {
    this.emit("message", { data })
  }
  /** The socket closes and tells us about it — the case that always worked. */
  serverClose() {
    this.readyState = FakeSocket.CLOSED
    this.emit("close", {})
  }
}

const original = globalThis.WebSocket
const install = () => {
  FakeSocket.instances = []
  // @ts-expect-error — test double
  globalThis.WebSocket = FakeSocket
}
afterEach(() => {
  globalThis.WebSocket = original
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const url = () => new URL("wss://example.test/submit/connect")

describe("liveSocket", () => {
  test("gives up on a socket that goes silent, even while it claims to be OPEN", async () => {
    install()
    const socket = liveSocket({ url: url(), onMessage: () => {}, silenceMs: 40 })
    const first = FakeSocket.instances[0]!
    first.open()
    expect(first.readyState).toBe(FakeSocket.OPEN)

    // Nothing arrives — not even the server's 2s ping. The browser still reports OPEN.
    await wait(120)
    expect(first.readyState).toBe(FakeSocket.CLOSED)
    expect(FakeSocket.instances.length).toBeGreaterThan(1)
    socket.close()
  })

  test("keeps a socket that is still hearing pings", async () => {
    install()
    const socket = liveSocket({ url: url(), onMessage: () => {}, silenceMs: 60 })
    const first = FakeSocket.instances[0]!
    first.open()
    for (let i = 0; i < 4; i++) {
      await wait(25)
      first.message('{"type":"ping"}')
    }
    expect(FakeSocket.instances.length).toBe(1)
    expect(first.readyState).toBe(FakeSocket.OPEN)
    // A ping is answered, and is not handed to the consumer.
    expect(first.sent).toEqual(['{"type":"pong"}', '{"type":"pong"}', '{"type":"pong"}', '{"type":"pong"}'])
    socket.close()
  })

  test("reconnects after a close and replays through onOpen", async () => {
    install()
    const seen: string[] = []
    const socket = liveSocket({
      url: url(),
      onMessage: (data) => seen.push(data),
      onOpen: (ws) => ws.send("hello"),
      silenceMs: 5_000,
    })
    const first = FakeSocket.instances[0]!
    first.open()
    first.message('{"type":"created"}')
    first.serverClose()

    await wait(700)
    const second = FakeSocket.instances[1]
    expect(second).toBeDefined()
    second!.open()
    expect(second!.sent).toEqual(["hello"])
    expect(seen).toEqual(['{"type":"created"}'])
    socket.close()
  })

  test("comes back immediately when the network returns", async () => {
    install()
    const socket = liveSocket({ url: url(), onMessage: () => {}, silenceMs: 5_000 })
    const first = FakeSocket.instances[0]!
    first.open()
    first.serverClose()
    // A retry is scheduled half a second out; the `online` event should not wait for it.
    window.dispatchEvent(new Event("online"))
    await wait(20)
    expect(FakeSocket.instances.length).toBe(2)
    socket.close()
  })

  test("stops reconnecting once closed", async () => {
    install()
    const socket = liveSocket({ url: url(), onMessage: () => {}, silenceMs: 30 })
    FakeSocket.instances[0]!.open()
    socket.close()
    window.dispatchEvent(new Event("online"))
    await wait(120)
    expect(FakeSocket.instances.length).toBe(1)
  })
})
