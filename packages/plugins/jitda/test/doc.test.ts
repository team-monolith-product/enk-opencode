import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import * as Y from "yjs"
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness"
import { Doc, Recorder, Room, Store, Wire } from "../src/doc"

const SESSION = "ses_test1"
const prompt = { text: "hi" }

type Event = Doc.SubmitEvent
type ChannelEvent = { type: string; draft?: Record<string, any>; presence?: Record<string, any>[] }

let calls: { method: string; args: unknown[] }[] = []
let emitted: { type: string; properties: Record<string, unknown> }[] = []
let promptImpl: (sessionID: string, body: Record<string, unknown>) => Promise<{ messageID?: string } | undefined>

function fakeHost(): Doc.Host {
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args })
      return Promise.resolve(undefined)
    }
  return {
    prompt: (sessionID, body) => {
      calls.push({ method: "prompt", args: [sessionID, body] })
      return promptImpl(sessionID, body)
    },
    interrupt: record("interrupt"),
    formReply: record("formReply"),
    formCancel: record("formCancel"),
    archive: record("archive"),
    emit: (event) => {
      emitted.push(event)
    },
  }
}

const called = (method: string) => calls.filter((call) => call.method === method)
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const flush = () => wait(5)
const collect =
  <T,>(list: T[]) =>
  (data: string) => {
    const value = JSON.parse(data) as T & { type?: string }
    if (value.type !== "ping") list.push(value)
  }

function listen(docID: string, actorID: string, observer?: boolean) {
  const events: Event[] = []
  const stop = Doc.submitConnect({
    sessionID: SESSION,
    docID,
    actorID,
    observer,
    peer: { send: collect(events) },
  })
  return { events, stop }
}

function quiet(docID: string, actorID: string) {
  return Doc.submitConnect({ sessionID: SESSION, docID, actorID, peer: { send: () => undefined } })
}

function team(...names: string[]) {
  return names.map((name) => Doc.actorUpsert({ sessionID: SESSION, name }))
}

beforeEach(() => {
  Store.open(":memory:")
  Doc.resetForTest()
  calls = []
  emitted = []
  promptImpl = () => Promise.resolve({})
  Doc.setHost(fakeHost())
})

afterEach(() => {
  Doc.resetForTest()
  Room.setAwarenessGraceForTest()
  setSystemTime()
  Store.close()
})

describe("Doc prompt doc and actors", () => {
  test("prompt doc and session actor are session-scoped", () => {
    const first = Doc.prompt(SESSION)
    const second = Doc.prompt(SESSION)
    expect(second.docID).toBe(first.docID)
    expect(Doc.prompt("ses_other").docID).not.toBe(first.docID)

    const actor = Doc.actorUpsert({ sessionID: SESSION, name: "Alice" })
    expect(actor.sessionID).toBe(SESSION)
    expect(actor.name).toBe("Alice")

    const again = Doc.actorUpsert({ sessionID: SESSION, actorID: actor.actorID })
    expect(again.actorID).toBe(actor.actorID)
    expect(again.name).toBe("Alice")

    const list = Doc.actorList(SESSION)
    expect(list.length).toBe(1)
    expect(list[0]?.actorID).toBe(actor.actorID)
    expect(Doc.actorList("ses_other")).toEqual([])
  })

  test("prompt advance rotates session doc after ready", () => {
    const first = Doc.prompt(SESSION)
    const second = Doc.promptAdvance({ sessionID: SESSION })
    expect(second.docID).not.toBe(first.docID)
    expect(Doc.prompt(SESSION).docID).toBe(first.docID)

    const ready = Doc.promptReady({ sessionID: SESSION, docID: second.docID, clientID: "c1" })
    expect(ready.docID).toBe(second.docID)
    expect(Doc.prompt(SESSION).docID).toBe(second.docID)
    expect(emitted).toEqual([
      { type: "doc.prompt.rotated", properties: { sessionID: SESSION, docID: second.docID, clientID: "c1" } },
    ])
  })

  test("promptReady and get reject unknown docs", () => {
    expect(() => Doc.get("doc_missing")).toThrow(Doc.NotFoundError)
    expect(() => Doc.promptReady({ sessionID: SESSION, docID: "doc_missing" })).toThrow(Doc.NotFoundError)
    expect(() => Doc.syncPull({ docID: "doc_missing", guid: "doc_missing", state: new Uint8Array() })).toThrow(
      Doc.NotFoundError,
    )
  })

  test("actor identity: userID reuses one actor across tabs, explicit actorID wins", () => {
    const tab1 = Doc.actorUpsert({ sessionID: SESSION, userID: "u1", name: "Alice" })
    const tab2 = Doc.actorUpsert({ sessionID: SESSION, userID: "u1" })
    expect(tab2.actorID).toBe(tab1.actorID)
    expect(tab2.name).toBe("Alice")
    expect(tab2.userID).toBe("u1")

    const other = Doc.actorUpsert({ sessionID: SESSION, userID: "u2", name: "Bob" })
    expect(other.actorID).not.toBe(tab1.actorID)

    const explicit = Doc.actorUpsert({ sessionID: SESSION, actorID: "act_explicit", userID: "u1" })
    expect(explicit.actorID).toBe("act_explicit")

    const guest = Doc.actorUpsert({ sessionID: SESSION })
    expect(guest.name).toBe(`Guest-${guest.actorID.slice(-4)}`)
    expect(guest.userID).toBeUndefined()

    const long = Doc.actorUpsert({ sessionID: SESSION, name: `  ${"x".repeat(200)}  ` })
    expect(long.name.length).toBe(64)

    const listed = Doc.actorList(SESSION).find((item) => item.actorID === tab1.actorID)
    expect(listed).toEqual({ actorID: tab1.actorID, sessionID: SESSION, userID: "u1", name: "Alice", color: tab1.color })
    expect(Doc.actorList(SESSION).find((item) => item.actorID === guest.actorID)).not.toHaveProperty("userID")
  })

  test("actor colors stay distinct among recently active actors and honor a valid preferred hex", () => {
    const t0 = 1_700_000_000_000
    setSystemTime(t0)
    const [alice, bob] = team("Alice", "Bob")
    expect(alice!.color).toBe("#e03131")
    expect(bob!.color).toBe("#c2255c")
    expect(Doc.actorUpsert({ sessionID: SESSION, actorID: alice!.actorID }).color).toBe("#e03131")

    const picked = Doc.actorUpsert({ sessionID: SESSION, name: "Carol", color: "#123456" })
    expect(picked.color).toBe("#123456")
    const invalid = Doc.actorUpsert({ sessionID: SESSION, name: "Dave", color: "red" })
    expect(invalid.color).toBe("#9c36b5")

    const clash = Doc.actorUpsert({ sessionID: SESSION, name: "Eve", color: "#e03131" })
    expect(clash.color).toBe("#e03131")
    const healed = Doc.actorUpsert({ sessionID: SESSION, actorID: alice!.actorID })
    expect(healed.color).not.toBe("#e03131")
    expect(healed.color).toBe("#6741d9")

    setSystemTime(t0 + 2 * 60 * 60 * 1000)
    const late = Doc.actorUpsert({ sessionID: SESSION, name: "Late" })
    expect(late.color).toBe("#e03131")
  })

  test("submit state reads the actor's live session color", () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob] = team("Alice", "Bob")
    const stop = quiet(docID, bob!.actorID)
    const state = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt })
    expect(state.actors.find((actor) => actor.actorID === bob!.actorID)?.color).toBe(bob!.color)
    Doc.actorUpsert({ sessionID: SESSION, actorID: bob!.actorID, color: "#abcdef" })
    const next = Doc.submitActive({ sessionID: SESSION, docID, actorID: alice!.actorID })
    expect(next?.actors.find((actor) => actor.actorID === bob!.actorID)?.color).toBe("#abcdef")
    stop()
  })
})

describe("Doc sync", () => {
  test("sync push and pull round-trip", () => {
    const { docID } = Doc.prompt(SESSION)
    const ydoc = new Y.Doc()
    ydoc.getText("t").insert(0, "hi")
    Doc.syncPush({ docID, guid: docID, data: Y.encodeStateAsUpdate(ydoc) })

    const pulled = Doc.syncPull({ docID, guid: docID, state: new Uint8Array() })
    expect(pulled).not.toBeNull()
    const remote = new Y.Doc()
    Y.applyUpdate(remote, pulled!.data)
    expect(remote.getText("t").toString()).toBe("hi")

  })

  test("page subdoc push registers root subdoc", () => {
    const { docID } = Doc.prompt(SESSION)
    const page = new Y.Doc({ guid: "page" })
    page.getText("t").insert(0, "hi")
    Doc.syncPush({ docID, guid: "page", data: Y.encodeStateAsUpdate(page) })

    const root = Doc.syncPull({ docID, guid: docID, state: new Uint8Array() })
    expect(root).not.toBeNull()
    const remote = new Y.Doc({ guid: docID })
    Y.applyUpdate(remote, root!.data)
    expect(Array.from(remote.getSubdocs()).map((doc) => doc.guid)).toContain("page")

    const pulled = Doc.syncPull({ docID, guid: "page", state: new Uint8Array() })
    expect(pulled).not.toBeNull()
    const next = new Y.Doc({ guid: "page" })
    Y.applyUpdate(next, pulled!.data)
    expect(next.getText("t").toString()).toBe("hi")
  })

  test("persisted updates (root, subdoc and legacy unframed rows) reload after the room is dropped", () => {
    const { docID } = Doc.prompt(SESSION)
    const root = new Y.Doc()
    root.getText("t").insert(0, "root")
    Doc.syncPush({ docID, guid: docID, data: Y.encodeStateAsUpdate(root) })
    const page = new Y.Doc({ guid: "page" })
    page.getText("t").insert(0, "page")
    Doc.syncPush({ docID, guid: "page", data: Y.encodeStateAsUpdate(page) })

    const legacy = new Y.Doc()
    legacy.getText("old").insert(0, "legacy")
    Store.db().run("INSERT INTO doc_update (id, doc_id, data, time_created) VALUES (?, ?, ?, ?)", [
      "zzzz_legacy",
      docID,
      Y.encodeStateAsUpdate(legacy),
      Date.now() + 1,
    ])

    Room.resetForTest()
    expect(Room.loaded(docID)).toBe(false)

    const pulled = Doc.syncPull({ docID, guid: docID, state: new Uint8Array() })
    const remote = new Y.Doc({ guid: docID })
    Y.applyUpdate(remote, pulled!.data)
    expect(remote.getText("t").toString()).toBe("root")
    expect(remote.getText("old").toString()).toBe("legacy")
    expect(Array.from(remote.getSubdocs()).map((doc) => doc.guid)).toContain("page")

    const sub = Doc.syncPull({ docID, guid: "page", state: new Uint8Array() })
    const next = new Y.Doc({ guid: "page" })
    Y.applyUpdate(next, sub!.data)
    expect(next.getText("t").toString()).toBe("page")
  })

  test("sync push relays to other room peers but not the sender", () => {
    const { docID } = Doc.prompt(SESSION)
    const first: Uint8Array[] = []
    const second: Uint8Array[] = []
    const one: Room.Peer = { send: (data) => first.push(data) }
    const two: Room.Peer = { send: (data) => second.push(data) }
    const stopOne = Room.connect(docID, one)
    const stopTwo = Room.connect(docID, two)
    first.length = 0
    second.length = 0

    const ydoc = new Y.Doc()
    ydoc.getText("t").insert(0, "x")
    Doc.syncPush({ docID, guid: docID, data: Y.encodeStateAsUpdate(ydoc), peer: one })
    expect(first.length).toBe(0)
    expect(second.length).toBe(1)
    expect(Room.decode(second[0]!, docID)?.type).toBe(Room.MSG_DOC)

    stopTwo()
    stopOne()
  })
})

describe("Doc assets", () => {
  test("doc asset stores data for other clients", () => {
    const { docID } = Doc.prompt(SESSION)
    const data = new Uint8Array([1, 2, 3])

    const asset = Doc.assetCreate({ docID, mime: "image/png", data })
    expect(asset.url).toBe(`/doc/${docID}/asset/${asset.assetID}`)
    expect(asset.assetID.startsWith("ast_")).toBe(true)

    const next = Doc.assetGet({ docID, assetID: asset.assetID })
    expect(next.mime).toBe("image/png")
    expect(next.size).toBe(3)
    expect(Array.from(next.data)).toEqual([1, 2, 3])

    const keyed = Doc.assetCreate({ docID, assetID: "hash", mime: "image/png", data })
    expect(keyed.assetID).toBe("hash")
    expect(Doc.assetGet({ docID, assetID: "hash" }).size).toBe(3)

    Doc.assetCreate({ docID, assetID: "hash", mime: "application/pdf", data: new Uint8Array([10, 11, 12, 13]) })
    const replaced = Doc.assetGet({ docID, assetID: "hash" })
    expect(replaced.mime).toBe("application/pdf")
    expect(Array.from(replaced.data)).toEqual([10, 11, 12, 13])

    expect(() => Doc.assetGet({ docID, assetID: "missing" })).toThrow(Doc.NotFoundError)
    expect(() => Doc.assetCreate({ docID: "doc_missing", mime: "image/png", data })).toThrow(Doc.NotFoundError)
    const other = Doc.prompt("ses_other").docID
    expect(() => Doc.assetGet({ docID: other, assetID: "hash" })).toThrow(Doc.NotFoundError)
  })
})

function awarenessUpdate() {
  const doc = new Y.Doc()
  const aware = new Awareness(doc)
  aware.setLocalStateField("user", { actorID: "actor", name: "Tester" })
  const update = encodeAwarenessUpdate(aware, [aware.clientID])
  const clientID = aware.clientID
  aware.destroy()
  doc.destroy()
  return { update, clientID }
}

const awarenessCount = (messages: Uint8Array[], docID: string) =>
  messages.filter((data) => Room.decode(data, docID)?.type === Room.MSG_AWARENESS).length

describe("Room", () => {
  test("new peers receive current awareness state", () => {
    const docID = Store.ascending("doc")
    const second: Uint8Array[] = []
    const one: Room.Peer = { send: () => undefined }
    const two: Room.Peer = { send: (data) => second.push(data) }

    const stopOne = Room.connect(docID, one)
    Room.awareness(docID, new Uint8Array([1, 2, 3]), one)
    const stopTwo = Room.connect(docID, two)

    expect(second.some((data) => Room.decode(data, docID)?.type === Room.MSG_AWARENESS)).toBe(true)

    stopTwo()
    stopOne()
  })

  test("awareness removal waits out the grace window, then fires", async () => {
    Room.setAwarenessGraceForTest(50)
    const docID = Store.ascending("doc")
    const messages: Uint8Array[] = []
    const one: Room.Peer = { send: () => undefined }
    const two: Room.Peer = { send: (data) => messages.push(data) }
    const { update } = awarenessUpdate()

    const stopOne = Room.connect(docID, one)
    Room.awareness(docID, update, one)
    const stopTwo = Room.connect(docID, two)
    messages.length = 0

    stopOne()
    expect(awarenessCount(messages, docID)).toBe(0)

    await wait(120)
    expect(awarenessCount(messages, docID)).toBe(1)

    stopTwo()
    expect(Room.loaded(docID)).toBe(false)
  })

  test("reconnect within the grace window cancels the awareness removal", async () => {
    Room.setAwarenessGraceForTest(80)
    const docID = Store.ascending("doc")
    const messages: Uint8Array[] = []
    const one: Room.Peer = { send: () => undefined }
    const two: Room.Peer = { send: (data) => messages.push(data) }
    const { update } = awarenessUpdate()

    const stopOne = Room.connect(docID, one)
    Room.awareness(docID, update, one)
    const stopTwo = Room.connect(docID, two)
    messages.length = 0

    stopOne()
    const oneAgain: Room.Peer = { send: () => undefined }
    const stopOneAgain = Room.connect(docID, oneAgain)
    Room.awareness(docID, update, oneAgain)
    messages.length = 0

    await wait(140)
    expect(awarenessCount(messages, docID)).toBe(0)

    stopOneAgain()
    stopTwo()
  })

  test("closeAll sends the session-ended close code to connected doc peers", () => {
    const { docID } = Doc.prompt(SESSION)
    const closed: { code?: number; reason?: string }[] = []
    const stop = Room.connect(docID, { send: () => undefined, close: (code, reason) => closed.push({ code, reason }) })
    Room.closeAll(Room.CLOSE_SESSION_ENDED, "session ended")
    expect(closed).toEqual([{ code: 4001, reason: "session ended" }])
    stop()
  })

  test("wire framing round-trips and legacy frames decode onto the root guid", () => {
    const packed = Wire.pack(Wire.MSG_DOC, "guid-1", new Uint8Array([7, 8]))
    expect(Wire.unpack(packed)).toEqual({ type: Wire.MSG_DOC, guid: "guid-1", data: new Uint8Array([7, 8]) })
    expect(Wire.unpack(new Uint8Array([0, 1]))).toBeUndefined()
    expect(Room.decode(packed, "root")).toEqual({ type: Room.MSG_DOC, guid: "guid-1", data: new Uint8Array([7, 8]) })
    expect(Room.decode(new Uint8Array([Wire.MSG_DOC, 5]), "root")).toEqual({
      type: Room.MSG_DOC,
      guid: "root",
      data: new Uint8Array([5]),
    })
    expect(Room.decode(new Uint8Array([9]), "root")).toBeUndefined()
  })
})

describe("Doc submit votes", () => {
  test("submit approval broadcasts created and reconnect receives pending state", () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob] = team("Alice", "Bob")
    const bobPeer = listen(docID, bob!.actorID)

    const state = Doc.submitCreate({
      sessionID: SESSION,
      docID,
      actorID: alice!.actorID,
      actorIDs: [alice!.actorID, bob!.actorID],
      prompt,
    })
    expect(state.status).toBe("pending")
    expect(bobPeer.events[0]?.type).toBe("created")
    expect(bobPeer.events[0]?.state.submitID).toBe(state.submitID)

    const again = listen(docID, bob!.actorID)
    expect(again.events[0]?.type).toBe("created")
    expect(again.events[0]?.state.submitID).toBe(state.submitID)

    again.stop()
    bobPeer.stop()
  })

  test("recover expires overdue pending submits after a restart", () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob] = team("Alice", "Bob")
    const bobPeer = listen(docID, bob!.actorID)
    const state = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt })
    expect(state.status).toBe("pending")

    Store.db().run("UPDATE doc_submit SET expires_at = ? WHERE id = ?", [Date.now() - 1_000, state.submitID])
    bobPeer.events.length = 0

    Doc.recover()

    expect(bobPeer.events.some((event) => event.type === "expired")).toBe(true)
    expect(Doc.submitActive({ sessionID: SESSION, docID, actorID: alice!.actorID })).toBeUndefined()

    const next = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt })
    expect(next.status).toBe("pending")
    expect(next.submitID).not.toBe(state.submitID)

    bobPeer.stop()
  })

  test("a pending submit expires once its deadline passes", () => {
    const t0 = 1_000_000
    setSystemTime(t0)
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob] = team("Alice", "Bob")
    const bobPeer = listen(docID, bob!.actorID)
    const state = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt })
    expect(state.expiresAt).toBe(t0 + Doc.DEFAULT)

    setSystemTime(t0 + Doc.DEFAULT - 1)
    expect(Doc.submitActive({ sessionID: SESSION, docID, actorID: alice!.actorID })?.status).toBe("pending")

    setSystemTime(t0 + Doc.DEFAULT + 1)
    expect(Doc.submitActive({ sessionID: SESSION, docID, actorID: alice!.actorID })).toBeUndefined()
    expect(bobPeer.events.at(-1)?.type).toBe("expired")
    const late = Doc.submitRespond({
      sessionID: SESSION,
      submitID: state.submitID,
      actorID: bob!.actorID,
      action: "approve",
    })
    expect(late.status).toBe("expired")
    expect(called("prompt").length).toBe(0)
    bobPeer.stop()
  })

  test("submit approval replays a just-resolved terminal state on reconnect", () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob] = team("Alice", "Bob")
    const stopBob = quiet(docID, bob!.actorID)
    const state = Doc.submitCreate({
      sessionID: SESSION,
      docID,
      actorID: alice!.actorID,
      actorIDs: [alice!.actorID, bob!.actorID],
      prompt,
    })

    Doc.submitRespond({ sessionID: SESSION, submitID: state.submitID, actorID: bob!.actorID, action: "cancel" })

    const replay = listen(docID, alice!.actorID)
    expect(replay.events[0]?.type).toBe("cancelled")
    expect(replay.events[0]?.state.submitID).toBe(state.submitID)
    expect(replay.events[0]?.state.cancelledBy?.actorID).toBe(bob!.actorID)

    const [carol] = team("Carol")
    const none = listen(docID, carol!.actorID)
    expect(none.events.length).toBe(0)

    none.stop()
    replay.stop()
    stopBob()
  })

  test("terminal replay stops after the replay window", () => {
    const t0 = 1_000_000
    setSystemTime(t0)
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob] = team("Alice", "Bob")
    const stopBob = quiet(docID, bob!.actorID)
    const state = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt })
    Doc.submitRespond({ sessionID: SESSION, submitID: state.submitID, actorID: bob!.actorID, action: "cancel" })

    setSystemTime(t0 + Doc.REPLAY_WINDOW)
    const inside = listen(docID, alice!.actorID)
    expect(inside.events[0]?.type).toBe("cancelled")
    inside.stop()

    setSystemTime(t0 + Doc.REPLAY_WINDOW + 1)
    const outside = listen(docID, alice!.actorID)
    expect(outside.events.length).toBe(0)
    outside.stop()
    stopBob()
  })

  test("submit approval only targets connected peers", () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob, carol] = team("Alice", "Bob", "Carol")
    const stop = quiet(docID, bob!.actorID)

    const state = Doc.submitCreate({
      sessionID: SESSION,
      docID,
      actorID: alice!.actorID,
      actorIDs: [alice!.actorID, bob!.actorID, carol!.actorID],
      prompt,
    })

    const ids = state.actors.map((actor) => actor.actorID)
    expect(ids).toContain(alice!.actorID)
    expect(ids).toContain(bob!.actorID)
    expect(ids).not.toContain(carol!.actorID)

    stop()
  })

  test("observer receives casts but is never a target", () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob] = team("Alice", "Bob")
    const viewerID = "actviewer000000000000000001"
    const viewer = listen(docID, viewerID, true)
    const stopBob = quiet(docID, bob!.actorID)

    const state = Doc.submitCreate({
      sessionID: SESSION,
      docID,
      actorID: alice!.actorID,
      actorIDs: [alice!.actorID, bob!.actorID, viewerID],
      prompt,
    })

    const ids = state.actors.map((actor) => actor.actorID)
    expect(ids).toContain(alice!.actorID)
    expect(ids).toContain(bob!.actorID)
    expect(ids).not.toContain(viewerID)
    expect(viewer.events.some((event) => event.type === "created" && event.state.submitID === state.submitID)).toBe(
      true,
    )

    const late = listen(docID, "actviewer000000000000000009", true)
    expect(late.events[0]?.type).toBe("created")
    expect(late.events[0]?.state.submitID).toBe(state.submitID)
    expect(
      Doc.submitActive({ sessionID: SESSION, docID, actorID: alice!.actorID })?.actors.map((actor) => actor.actorID),
    ).not.toContain("actviewer000000000000000009")

    Doc.submitRespond({ sessionID: SESSION, submitID: state.submitID, actorID: bob!.actorID, action: "approve" })
    expect(viewer.events.at(-1)?.type).toBe("sent")

    late.stop()
    viewer.stop()
    stopBob()
  })

  test("submit approval caps overly long names", () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob] = team("Alice", "Bob")
    const stop = quiet(docID, bob!.actorID)

    const state = Doc.submitCreate({
      sessionID: SESSION,
      docID,
      actorID: alice!.actorID,
      actorIDs: [alice!.actorID, bob!.actorID],
      names: { [bob!.actorID]: "x".repeat(200) },
      prompt,
    })

    expect(state.actors.find((actor) => actor.actorID === bob!.actorID)?.name.length).toBe(64)
    stop()
  })

  test("submit approval uses presence names over stored actor fallback", () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice] = team("Alice")
    const bob = Doc.actorUpsert({ sessionID: SESSION })
    const stop = quiet(docID, bob.actorID)

    const state = Doc.submitCreate({
      sessionID: SESSION,
      docID,
      actorID: alice!.actorID,
      actorIDs: [alice!.actorID, bob.actorID],
      names: { [bob.actorID]: "Bob" },
      prompt,
    })

    const stored = state.actors.find((actor) => actor.actorID === bob.actorID)
    expect(stored?.name).toBe("Bob")
    expect(stored?.name).not.toBe(bob.actorID)
    expect(state.actors.find((actor) => actor.actorID === alice!.actorID)?.name).toBe("Alice")
    stop()
  })

  test("a leaver is marked left on the roster; only the requester leaving fails the vote", async () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob, carol] = team("Alice", "Bob", "Carol")
    const stopAlice = quiet(docID, alice!.actorID)
    let stopBob = quiet(docID, bob!.actorID)
    const carolPeer = listen(docID, carol!.actorID)

    const state = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt })
    expect(state.status).toBe("pending")
    expect(state.actors.length).toBe(3)

    stopBob()
    stopBob = quiet(docID, bob!.actorID)
    await wait(Doc.LEAVE_GRACE + 200)
    const held = Doc.submitActive({ sessionID: SESSION, docID, actorID: alice!.actorID })
    expect(held?.status).toBe("pending")
    expect(held?.actors.length).toBe(3)
    expect(held?.actors.every((actor) => actor.status !== "left")).toBe(true)

    stopBob()
    await wait(Doc.LEAVE_GRACE + 200)

    const updated = carolPeer.events.findLast((event) => event.type === "updated")
    expect(updated?.state.actors.find((actor) => actor.actorID === bob!.actorID)?.status).toBe("left")
    const survived = Doc.submitActive({ sessionID: SESSION, docID, actorID: alice!.actorID })
    expect(survived?.status).toBe("pending")
    expect(survived?.actors.length).toBe(3)

    stopAlice()
    await wait(Doc.LEAVE_GRACE + 200)

    const left = carolPeer.events.find((event) => event.type === "left")
    expect(left).toBeDefined()
    expect(left?.state.status).toBe("left")
    expect(left?.state.cancelledBy?.actorID).toBe(alice!.actorID)
    expect(left?.state.cancelledBy?.name).toBe("Alice")
    expect(Doc.submitActive({ sessionID: SESSION, docID, actorID: carol!.actorID })).toBeUndefined()
    expect(called("prompt").length).toBe(0)

    carolPeer.stop()
  }, 15_000)

  test("an approved member leaving changes nothing", async () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob, carol] = team("Alice", "Bob", "Carol")
    const stopAlice = quiet(docID, alice!.actorID)
    const stopBob = quiet(docID, bob!.actorID)
    const stopCarol = quiet(docID, carol!.actorID)
    const state = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt })
    Doc.submitRespond({ sessionID: SESSION, submitID: state.submitID, actorID: bob!.actorID, action: "approve" })

    stopBob()
    await wait(Doc.LEAVE_GRACE + 200)
    const held = Doc.submitActive({ sessionID: SESSION, docID, actorID: alice!.actorID })
    expect(held?.actors.find((actor) => actor.actorID === bob!.actorID)?.status).toBe("approved")

    stopCarol()
    stopAlice()
  }, 10_000)

  test("a departure never sends by itself; the requester's exclude action does", async () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob] = team("Alice", "Bob")
    const alicePeer = listen(docID, alice!.actorID)
    const stopBob = quiet(docID, bob!.actorID)

    const state = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt })
    expect(state.status).toBe("pending")

    stopBob()
    await wait(Doc.LEAVE_GRACE + 200)

    expect(alicePeer.events.some((event) => event.type === "sent")).toBe(false)
    const held = Doc.submitActive({ sessionID: SESSION, docID, actorID: alice!.actorID })
    expect(held?.status).toBe("pending")
    expect(held?.actors.find((actor) => actor.actorID === bob!.actorID)?.status).toBe("left")
    expect(called("prompt").length).toBe(0)

    expect(() =>
      Doc.submitRespond({ sessionID: SESSION, submitID: state.submitID, actorID: bob!.actorID, action: "exclude" }),
    ).toThrow(Doc.NotFoundError)

    const sent = Doc.submitRespond({
      sessionID: SESSION,
      submitID: state.submitID,
      actorID: alice!.actorID,
      action: "exclude",
    })
    expect(sent.status).toBe("sent")
    expect(sent.actors.map((actor) => actor.actorID)).toEqual([alice!.actorID])
    expect(Doc.submitActive({ sessionID: SESSION, docID, actorID: alice!.actorID })).toBeUndefined()
    expect(called("prompt").length).toBe(1)

    alicePeer.stop()
  }, 10_000)

  test("exclude is a no-op while a present member is still deciding", async () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob, carol] = team("Alice", "Bob", "Carol")
    const stopAlice = quiet(docID, alice!.actorID)
    const stopBob = quiet(docID, bob!.actorID)
    const stopCarol = quiet(docID, carol!.actorID)

    const state = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt })

    stopBob()
    await wait(Doc.LEAVE_GRACE + 200)
    const held = Doc.submitRespond({
      sessionID: SESSION,
      submitID: state.submitID,
      actorID: alice!.actorID,
      action: "exclude",
    })
    expect(held.status).toBe("pending")
    expect(held.actors.length).toBe(3)

    stopCarol()
    stopAlice()
  }, 10_000)

  test("exclude is a no-op when nobody has left", () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob] = team("Alice", "Bob")
    const stopBob = quiet(docID, bob!.actorID)
    const state = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt })
    const held = Doc.submitRespond({
      sessionID: SESSION,
      submitID: state.submitID,
      actorID: alice!.actorID,
      action: "exclude",
    })
    expect(held.status).toBe("pending")
    expect(held.actors.length).toBe(2)
    stopBob()
  })

  test("a left member who reconnects becomes pending again and can complete the vote", async () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob] = team("Alice", "Bob")
    const stopAlice = quiet(docID, alice!.actorID)
    const stopBob = quiet(docID, bob!.actorID)

    const state = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt })

    stopBob()
    await wait(Doc.LEAVE_GRACE + 200)
    expect(
      Doc.submitActive({ sessionID: SESSION, docID, actorID: alice!.actorID })?.actors.find(
        (actor) => actor.actorID === bob!.actorID,
      )?.status,
    ).toBe("left")

    const bobAgain = listen(docID, bob!.actorID)
    const replay = bobAgain.events.find((event) => event.type === "created")
    expect(replay?.state.actors.find((actor) => actor.actorID === bob!.actorID)?.status).toBe("pending")

    const sent = Doc.submitRespond({
      sessionID: SESSION,
      submitID: state.submitID,
      actorID: bob!.actorID,
      action: "approve",
    })
    expect(sent.status).toBe("sent")

    bobAgain.stop()
    stopAlice()
  }, 10_000)

  test("membership changes top the countdown up by 3s, capped at one full window", () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob, carol, dave] = team("Alice", "Bob", "Carol", "Dave")

    const t0 = 1_000_000
    setSystemTime(t0)
    const stopAlice = quiet(docID, alice!.actorID)
    const stopBob = quiet(docID, bob!.actorID)

    const state = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt, timeoutMs: 10_000 })
    expect(state.expiresAt).toBe(t0 + 10_000)

    const stopCarol = quiet(docID, carol!.actorID)
    expect(Doc.submitActive({ sessionID: SESSION, docID, actorID: alice!.actorID })?.expiresAt).toBe(t0 + 10_000)

    setSystemTime(t0 + 5_000)
    const stopDave = quiet(docID, dave!.actorID)
    expect(Doc.submitActive({ sessionID: SESSION, docID, actorID: alice!.actorID })?.expiresAt).toBe(t0 + 13_000)

    stopDave()
    stopCarol()
    stopBob()
    stopAlice()
  })

  test("membership churn cannot push the deadline past the original + 30s", () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob] = team("Alice", "Bob")

    const t0 = 1_000_000
    setSystemTime(t0)
    const stops = [alice!, bob!].map((actor) => quiet(docID, actor.actorID))

    const state = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt, timeoutMs: 10_000 })
    expect(state.expiresAt).toBe(t0 + 10_000)

    const active = () => Doc.submitActive({ sessionID: SESSION, docID, actorID: alice!.actorID })
    for (let i = 1; i <= 18; i++) {
      setSystemTime(t0 + i * 2_000)
      if (!active()) break
      const joiner = Doc.actorUpsert({ sessionID: SESSION, name: `Joiner ${i}` })
      stops.push(quiet(docID, joiner.actorID))
    }

    expect(active()?.expiresAt).toBe(t0 + 40_000)
    setSystemTime(t0 + 40_001)
    expect(active()).toBeUndefined()

    for (const stop of stops) stop()
  })

  test("a late joiner is added to the pending vote and can complete it", () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob, carol] = team("Alice", "Bob", "Carol")
    const stopAlice = quiet(docID, alice!.actorID)
    const bobPeer = listen(docID, bob!.actorID)

    const state = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt })
    expect(state.status).toBe("pending")
    expect(state.actors.map((actor) => actor.actorID).sort()).toEqual([alice!.actorID, bob!.actorID].sort())

    const carolPeer = listen(docID, carol!.actorID)
    const replay = carolPeer.events.find((event) => event.type === "created")
    expect(replay?.state.submitID).toBe(state.submitID)
    expect(replay?.state.actors.map((actor) => actor.actorID)).toContain(carol!.actorID)
    expect(replay?.state.actors.find((actor) => actor.actorID === carol!.actorID)?.status).toBe("pending")
    expect(replay?.state.actors.find((actor) => actor.actorID === carol!.actorID)?.name).toBe("Carol")
    const grew = bobPeer.events.findLast((event) => event.type === "updated")
    expect(grew?.state.actors.map((actor) => actor.actorID)).toContain(carol!.actorID)

    const partial = Doc.submitRespond({
      sessionID: SESSION,
      submitID: state.submitID,
      actorID: bob!.actorID,
      action: "approve",
    })
    expect(partial.status).toBe("pending")
    const sent = Doc.submitRespond({
      sessionID: SESSION,
      submitID: state.submitID,
      actorID: carol!.actorID,
      action: "approve",
    })
    expect(sent.status).toBe("sent")

    carolPeer.stop()
    bobPeer.stop()
    stopAlice()
  })

  test("submit approval clamps timeout and auto-approves initiator", () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob] = team("Alice", "Bob")
    const stop = quiet(docID, bob!.actorID)

    const min = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt, timeoutMs: 1 })
    expect(min.timeoutMs).toBe(10_000)
    expect(min.actors.find((actor) => actor.actorID === alice!.actorID)?.status).toBe("approved")
    expect(min.actors.find((actor) => actor.actorID === bob!.actorID)?.status).toBe("pending")
    Doc.submitRespond({ sessionID: SESSION, submitID: min.submitID, actorID: bob!.actorID, action: "cancel" })

    const max = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt, timeoutMs: 900_000 })
    expect(max.timeoutMs).toBe(600_000)
    Doc.submitRespond({ sessionID: SESSION, submitID: max.submitID, actorID: bob!.actorID, action: "cancel" })

    const base = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt })
    expect(base.timeoutMs).toBe(30_000)
    stop()
  })

  test("submit approval sends on last approval and ignores later cancel", () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob] = team("Alice", "Bob")
    const stop = quiet(docID, bob!.actorID)
    const state = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt })

    const sent = Doc.submitRespond({
      sessionID: SESSION,
      submitID: state.submitID,
      actorID: bob!.actorID,
      action: "approve",
    })
    expect(sent.status).toBe("sent")

    const next = Doc.submitRespond({
      sessionID: SESSION,
      submitID: state.submitID,
      actorID: bob!.actorID,
      action: "cancel",
    })
    expect(next.status).toBe("sent")
    expect(called("prompt").length).toBe(1)
    stop()
  })

  test("submit approval sends the prompt with jitda metadata, links the user message and rotates the doc", async () => {
    promptImpl = () => Promise.resolve({ messageID: "msg_user_sent" })
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob] = team("Alice", "Bob")
    const stop = quiet(docID, bob!.actorID)
    const state = Doc.submitCreate({
      sessionID: SESSION,
      docID,
      actorID: alice!.actorID,
      prompt: { text: "hi", metadata: { source: "doc" } },
    })

    const sent = Doc.submitRespond({
      sessionID: SESSION,
      submitID: state.submitID,
      actorID: bob!.actorID,
      action: "approve",
    })
    expect(sent.status).toBe("sent")
    expect(called("prompt")).toEqual([
      {
        method: "prompt",
        args: [
          SESSION,
          {
            text: "hi",
            metadata: { source: "doc", jitda: { docID, submitID: state.submitID, actorID: alice!.actorID } },
          },
        ],
      },
    ])

    await flush()
    const rotated = Doc.prompt(SESSION).docID
    expect(rotated).not.toBe(docID)
    expect(emitted).toContainEqual({
      type: "doc.prompt.rotated",
      properties: { sessionID: SESSION, docID: rotated, init: true },
    })
    const row = Store.db()
      .query<{ user_message_id: string | null }, [string]>("SELECT user_message_id FROM doc_submit WHERE id = ?")
      .get(state.submitID)
    expect(row?.user_message_id).toBe("msg_user_sent")
    stop()
  })

  test("the doc does not rotate until the host has accepted the prompt", async () => {
    let accept!: (value: { messageID?: string }) => void
    promptImpl = () => new Promise((resolve) => (accept = resolve))
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob] = team("Alice", "Bob")
    const stop = quiet(docID, bob!.actorID)
    const state = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt })
    Doc.submitRespond({ sessionID: SESSION, submitID: state.submitID, actorID: bob!.actorID, action: "approve" })

    await flush()
    expect(Doc.prompt(SESSION).docID).toBe(docID)
    accept({ messageID: "msg_later" })
    await flush()
    expect(Doc.prompt(SESSION).docID).not.toBe(docID)
    stop()
  })

  test("a failing host prompt surfaces doc.error and keeps the doc", async () => {
    promptImpl = () => Promise.reject(new Error("boom"))
    const { docID } = Doc.prompt(SESSION)
    const [alice] = team("Alice")
    const state = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt })
    expect(state.status).toBe("sent")

    await flush()
    expect(emitted).toContainEqual({
      type: "doc.error",
      properties: { sessionID: SESSION, error: { name: "UnknownError", data: { message: "boom" } } },
    })
    expect(Doc.prompt(SESSION).docID).toBe(docID)
  })

  test("a lone sender skips the vote and sends immediately", async () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice] = team("Alice")
    const alicePeer = listen(docID, alice!.actorID)
    const state = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt })
    expect(state.status).toBe("sent")
    expect(state.actors).toEqual([{ actorID: alice!.actorID, name: "Alice", color: alice!.color, status: "approved" }])
    expect(alicePeer.events.at(-1)?.type).toBe("sent")
    expect(called("prompt").length).toBe(1)
    await flush()
    alicePeer.stop()
  })

  test("submit approval cancels for everyone and ignores later approval", () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob] = team("Alice", "Bob")
    const alicePeer = listen(docID, alice!.actorID)
    const stop = quiet(docID, bob!.actorID)
    const state = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt })

    const cancelled = Doc.submitRespond({
      sessionID: SESSION,
      submitID: state.submitID,
      actorID: bob!.actorID,
      action: "cancel",
    })
    expect(cancelled.status).toBe("cancelled")
    expect(cancelled.cancelledBy?.actorID).toBe(bob!.actorID)
    expect(alicePeer.events.at(-1)?.type).toBe("cancelled")

    const next = Doc.submitRespond({
      sessionID: SESSION,
      submitID: state.submitID,
      actorID: alice!.actorID,
      action: "approve",
    })
    expect(next.status).toBe("cancelled")
    expect(called("prompt").length).toBe(0)
    alicePeer.stop()
    stop()
  })

  test("submit approval ignores disconnected actors from stale client snapshots", () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob, charlie] = team("Alice", "Bob", "Charlie")
    const stop = quiet(docID, bob!.actorID)

    const state = Doc.submitCreate({
      sessionID: SESSION,
      docID,
      actorID: alice!.actorID,
      actorIDs: [alice!.actorID, bob!.actorID, charlie!.actorID],
      prompt,
    })

    expect(state.status).toBe("pending")
    expect(state.actors.map((actor) => actor.actorID).sort()).toEqual([alice!.actorID, bob!.actorID].sort())
    stop()
  })

  test("a second create on the same doc returns the in-flight vote", () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob] = team("Alice", "Bob")
    const stop = quiet(docID, bob!.actorID)
    const first = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt })
    const second = Doc.submitCreate({ sessionID: SESSION, docID, actorID: bob!.actorID, prompt: { text: "other" } })
    expect(second.submitID).toBe(first.submitID)
    expect(second.actorID).toBe(alice!.actorID)
    stop()
  })

  test("submitRespond rejects unknown submits, wrong sessions and non-members", () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob] = team("Alice", "Bob")
    const stop = quiet(docID, bob!.actorID)
    const state = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt })
    expect(() =>
      Doc.submitRespond({ sessionID: SESSION, submitID: "sub_missing", actorID: bob!.actorID, action: "approve" }),
    ).toThrow(Doc.NotFoundError)
    expect(() =>
      Doc.submitRespond({ sessionID: "ses_other", submitID: state.submitID, actorID: bob!.actorID, action: "approve" }),
    ).toThrow(Doc.NotFoundError)
    expect(() =>
      Doc.submitRespond({ sessionID: SESSION, submitID: state.submitID, actorID: "act_stranger", action: "approve" }),
    ).toThrow(Doc.NotFoundError)
    expect(() => Doc.submitCreate({ sessionID: SESSION, docID: "doc_missing", actorID: alice!.actorID, prompt })).toThrow(
      Doc.NotFoundError,
    )
    stop()
  })

  test("heartbeat reaps a peer that stops ponging, keeps peers that pong", () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob, ghost] = team("Alice", "Bob", "Ghost")

    const t0 = 1_000_000
    setSystemTime(t0)
    const pings: string[] = []
    let stopAlice!: Doc.Handle
    let stopBob!: Doc.Handle
    let stopGhost!: Doc.Handle
    stopAlice = Doc.submitConnect({
      sessionID: SESSION,
      docID,
      actorID: alice!.actorID,
      peer: { send: (data) => pings.push(data), close: () => stopAlice() },
    })
    stopBob = Doc.submitConnect({
      sessionID: SESSION,
      docID,
      actorID: bob!.actorID,
      peer: { send: () => undefined, close: () => stopBob() },
    })
    stopGhost = Doc.submitConnect({
      sessionID: SESSION,
      docID,
      actorID: ghost!.actorID,
      peer: { send: () => undefined, close: () => stopGhost() },
    })

    setSystemTime(t0 + 3_000)
    Doc.heartbeatSweep()
    expect(pings).toContain(JSON.stringify({ type: "ping" }))
    stopAlice.pong()
    stopBob.pong()

    setSystemTime(t0 + 6_000)
    Doc.heartbeatSweep()

    const state = Doc.submitCreate({
      sessionID: SESSION,
      docID,
      actorID: alice!.actorID,
      actorIDs: [alice!.actorID, bob!.actorID, ghost!.actorID],
      prompt,
    })
    expect(state.status).toBe("pending")
    expect(state.actors.map((actor) => actor.actorID).sort()).toEqual([alice!.actorID, bob!.actorID].sort())

    stopAlice()
    stopBob()
  })

  test("doc submit transitions to sent and casts when all approve", () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob] = team("Alice", "Bob")
    const alicePeer = listen(docID, alice!.actorID)
    const bobPeer = listen(docID, bob!.actorID)

    const state = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt })
    expect(state.status).toBe("pending")

    const sent = Doc.submitRespond({
      sessionID: SESSION,
      submitID: state.submitID,
      actorID: bob!.actorID,
      action: "approve",
    })
    expect(sent.status).toBe("sent")
    expect(alicePeer.events.at(-1)?.type).toBe("sent")
    expect(bobPeer.events.at(-1)?.type).toBe("sent")

    alicePeer.stop()
    bobPeer.stop()
  })

  test("a stale zombie peer joins the vote but is reaped and marked left, so the requester can finish", async () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob, ghost] = team("Alice", "Bob", "Ghost")

    const t0 = 1_000_000
    setSystemTime(t0)
    const aliceEvents: Event[] = []
    let stopA!: Doc.Handle
    let stopB!: Doc.Handle
    let stopG!: Doc.Handle
    stopA = Doc.submitConnect({
      sessionID: SESSION,
      docID,
      actorID: alice!.actorID,
      peer: { send: collect(aliceEvents), close: () => stopA() },
    })
    stopB = Doc.submitConnect({
      sessionID: SESSION,
      docID,
      actorID: bob!.actorID,
      peer: { send: () => undefined, close: () => stopB() },
    })
    stopG = Doc.submitConnect({
      sessionID: SESSION,
      docID,
      actorID: ghost!.actorID,
      peer: { send: () => undefined, close: () => stopG() },
    })

    const state = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt })
    expect(state.actors.map((actor) => actor.actorID).sort()).toEqual(
      [alice!.actorID, bob!.actorID, ghost!.actorID].sort(),
    )

    const partial = Doc.submitRespond({
      sessionID: SESSION,
      submitID: state.submitID,
      actorID: bob!.actorID,
      action: "approve",
    })
    expect(partial.status).toBe("pending")

    setSystemTime(t0 + 3_000)
    Doc.heartbeatSweep()
    stopA.pong()
    stopB.pong()
    setSystemTime(t0 + 6_000)
    Doc.heartbeatSweep()

    await wait(Doc.LEAVE_GRACE + 200)
    const marked = aliceEvents.findLast((event) => event.type === "updated")
    expect(marked?.state.actors.find((actor) => actor.actorID === ghost!.actorID)?.status).toBe("left")

    const sent = Doc.submitRespond({
      sessionID: SESSION,
      submitID: state.submitID,
      actorID: alice!.actorID,
      action: "exclude",
    })
    expect(sent.status).toBe("sent")
    expect(sent.actors.map((actor) => actor.actorID)).not.toContain(ghost!.actorID)

    stopA()
    stopB()
  }, 15_000)
})

describe("Doc stop, clear and question votes", () => {
  test("stop vote routes through the doc submit socket and interrupts on consensus", () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob] = team("Alice", "Bob")
    const alicePeer = listen(docID, alice!.actorID)
    const stopB = quiet(docID, bob!.actorID)

    const state = Doc.stopSubmitCreate({
      sessionID: SESSION,
      docID,
      actorID: alice!.actorID,
      actorIDs: [alice!.actorID, bob!.actorID],
    })
    expect(state.status).toBe("pending")
    expect(state.targetKind).toBe("stop")
    expect(state.targetID).toBe(docID)
    expect(state.questionAction).toBeUndefined()
    expect(alicePeer.events[0]?.type).toBe("created")

    const send = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt })
    expect(send.targetKind).toBe("doc")
    expect(send.submitID).not.toBe(state.submitID)

    const sent = Doc.submitRespond({
      sessionID: SESSION,
      submitID: state.submitID,
      actorID: bob!.actorID,
      action: "approve",
    })
    expect(sent.status).toBe("sent")
    expect(alicePeer.events.some((event) => event.type === "sent" && event.state.submitID === state.submitID)).toBe(
      true,
    )
    expect(called("interrupt")).toEqual([{ method: "interrupt", args: [SESSION] }])
    expect(called("prompt").length).toBe(0)

    alicePeer.stop()
    stopB()
  })

  test("clear vote cannot overlap any other vote and archives the session on consensus", () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob] = team("Alice", "Bob")
    const stopA = quiet(docID, alice!.actorID)
    const stopB = quiet(docID, bob!.actorID)

    const send = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt })
    expect(() => Doc.clearSubmitCreate({ sessionID: SESSION, docID, actorID: bob!.actorID })).toThrow(
      Doc.VoteConflictError,
    )
    Doc.submitRespond({ sessionID: SESSION, submitID: send.submitID, actorID: bob!.actorID, action: "cancel" })

    const clear = Doc.clearSubmitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID })
    expect(clear.status).toBe("pending")
    expect(clear.targetKind).toBe("clear")

    expect(() => Doc.submitCreate({ sessionID: SESSION, docID, actorID: bob!.actorID, prompt })).toThrow(
      Doc.VoteConflictError,
    )
    expect(() => Doc.stopSubmitCreate({ sessionID: SESSION, docID, actorID: bob!.actorID })).toThrow(
      Doc.VoteConflictError,
    )
    expect(() =>
      Doc.questionSubmitCreate({
        sessionID: SESSION,
        requestID: "que_1",
        actorID: bob!.actorID,
        payload: { requestID: "que_1", answers: [["A"]] },
      }),
    ).toThrow(Doc.VoteConflictError)
    expect(Doc.clearSubmitCreate({ sessionID: SESSION, docID, actorID: bob!.actorID }).submitID).toBe(clear.submitID)

    const sent = Doc.submitRespond({
      sessionID: SESSION,
      submitID: clear.submitID,
      actorID: bob!.actorID,
      action: "approve",
    })
    expect(sent.status).toBe("sent")
    expect(called("archive")).toEqual([{ method: "archive", args: [SESSION] }])

    expect(Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt }).status).toBe("pending")
    stopA()
    stopB()
  })

  test("a vote in another session does not block a clear", () => {
    const { docID } = Doc.prompt(SESSION)
    const other = Doc.prompt("ses_other").docID
    const [alice, bob] = team("Alice", "Bob")
    const stopOther = Doc.submitConnect({
      sessionID: "ses_other",
      docID: other,
      actorID: bob!.actorID,
      peer: { send: () => undefined },
    })
    const elsewhere = Doc.submitCreate({ sessionID: "ses_other", docID: other, actorID: alice!.actorID, prompt })
    expect(elsewhere.status).toBe("pending")
    const stopB = quiet(docID, bob!.actorID)
    expect(Doc.clearSubmitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID }).status).toBe("pending")
    stopB()
    stopOther()
  })

  test("question consent vote keys on requestID and replies once all approve", () => {
    const [alice, bob] = team("Alice", "Bob")
    const requestID = "question_vote_1"
    const events: Event[] = []
    const stop = Doc.questionSubmitConnect({
      sessionID: SESSION,
      requestID,
      actorID: bob!.actorID,
      peer: { send: collect(events) },
    })
    const draftEvents: ChannelEvent[] = []
    const stopDraft = Doc.questionDraftConnect({
      sessionID: SESSION,
      requestID,
      actorID: bob!.actorID,
      peer: { send: collect(draftEvents) },
    })
    Doc.questionDraftApply({ sessionID: SESSION, requestID, op: { kind: "single", q: 0, value: "B" } })

    const state = Doc.questionSubmitCreate({
      sessionID: SESSION,
      requestID,
      actorID: alice!.actorID,
      actorIDs: [alice!.actorID, bob!.actorID],
      payload: { requestID, answers: [["B"]] },
    })
    expect(state.status).toBe("pending")
    expect(state.targetKind).toBe("question")
    expect(state.targetID).toBe(requestID)
    expect(state.questionAction).toBe("send")
    expect(events[0]?.type).toBe("created")
    expect(Doc.questionSubmitActive({ sessionID: SESSION, requestID, actorID: bob!.actorID })?.submitID).toBe(
      state.submitID,
    )

    const again = Doc.questionSubmitCreate({
      sessionID: SESSION,
      requestID,
      actorID: bob!.actorID,
      payload: { requestID, answers: [["B"]] },
    })
    expect(again.submitID).toBe(state.submitID)

    const sent = Doc.submitRespond({
      sessionID: SESSION,
      submitID: state.submitID,
      actorID: bob!.actorID,
      action: "approve",
    })
    expect(sent.status).toBe("sent")
    expect(events.at(-1)?.type).toBe("sent")
    expect(called("formReply")).toEqual([{ method: "formReply", args: [SESSION, requestID, [["B"]]] }])
    expect(draftEvents.at(-1)).toEqual({ type: "presence", presence: [] })

    const late: ChannelEvent[] = []
    const stopLate = Doc.questionDraftConnect({
      sessionID: SESSION,
      requestID,
      actorID: alice!.actorID,
      peer: { send: collect(late) },
    })
    expect(late.find((event) => event.type === "draft")).toBeUndefined()

    stopLate()
    stopDraft()
    stop()
  })

  test("question dismiss vote cancels the form", () => {
    const [alice, bob] = team("Alice", "Bob")
    const requestID = "question_dismiss"
    const stop = Doc.questionSubmitConnect({
      sessionID: SESSION,
      requestID,
      actorID: bob!.actorID,
      peer: { send: () => undefined },
    })
    const state = Doc.questionSubmitCreate({
      sessionID: SESSION,
      requestID,
      actorID: alice!.actorID,
      payload: { requestID, reject: true },
    })
    expect(state.questionAction).toBe("dismiss")
    Doc.submitRespond({ sessionID: SESSION, submitID: state.submitID, actorID: bob!.actorID, action: "approve" })
    expect(called("formCancel")).toEqual([{ method: "formCancel", args: [SESSION, requestID] }])
    expect(called("formReply").length).toBe(0)
    stop()
  })

  test("question back vote moves the shared step and keeps the draft", () => {
    const [alice, bob] = team("Alice", "Bob")
    const requestID = "question_back"
    const stop = Doc.questionSubmitConnect({
      sessionID: SESSION,
      requestID,
      actorID: bob!.actorID,
      peer: { send: () => undefined },
    })
    Doc.questionDraftApply({ sessionID: SESSION, requestID, op: { kind: "single", q: 0, value: "A" } })
    Doc.questionDraftApply({ sessionID: SESSION, requestID, op: { kind: "step", value: 2 } })
    const state = Doc.questionSubmitCreate({
      sessionID: SESSION,
      requestID,
      actorID: alice!.actorID,
      payload: { requestID, step: 1 },
    })
    expect(state.questionAction).toBe("back")
    Doc.submitRespond({ sessionID: SESSION, submitID: state.submitID, actorID: bob!.actorID, action: "approve" })
    expect(called("formReply").length).toBe(0)
    expect(called("formCancel").length).toBe(0)

    const snapshot: ChannelEvent[] = []
    const stopDraft = Doc.questionDraftConnect({
      sessionID: SESSION,
      requestID,
      actorID: alice!.actorID,
      peer: { send: collect(snapshot) },
    })
    const draft = snapshot.find((event) => event.type === "draft")?.draft
    expect(draft?.step).toBe(1)
    expect(draft?.answers[0]).toEqual(["A"])
    stopDraft()
    stop()
  })

  test("a solo question submit replies immediately", () => {
    const [alice] = team("Alice")
    const state = Doc.questionSubmitCreate({
      sessionID: SESSION,
      requestID: "question_route_1",
      actorID: alice!.actorID,
      actorIDs: [alice!.actorID],
      payload: { requestID: "question_route_1", answers: [["A"]] },
    })
    expect(state.targetKind).toBe("question")
    expect(state.targetID).toBe("question_route_1")
    expect(state.status).toBe("sent")
    expect(called("formReply")).toEqual([{ method: "formReply", args: [SESSION, "question_route_1", [["A"]]] }])
  })

  test("a failing form reply surfaces doc.error", async () => {
    Doc.setHost({ ...fakeHost(), formReply: () => Promise.reject(new Error("gone")) })
    const [alice] = team("Alice")
    Doc.questionSubmitCreate({
      sessionID: SESSION,
      requestID: "question_gone",
      actorID: alice!.actorID,
      payload: { requestID: "question_gone", answers: [] },
    })
    await flush()
    expect(emitted).toContainEqual({
      type: "doc.error",
      properties: { sessionID: SESSION, error: { name: "UnknownError", data: { message: "gone" } } },
    })
  })
})

describe("Doc question drafts", () => {
  test("question draft relays shared answers: single is LWW, multi toggles are commutative", () => {
    const [alice, bob] = team("Alice", "Bob")
    const requestID = "question_draft_1"
    const seen: ChannelEvent[] = []
    const stopA = Doc.questionDraftConnect({
      sessionID: SESSION,
      requestID,
      actorID: alice!.actorID,
      peer: { send: collect(seen) },
    })
    const stopB = Doc.questionDraftConnect({
      sessionID: SESSION,
      requestID,
      actorID: bob!.actorID,
      peer: { send: () => undefined },
    })

    Doc.questionDraftApply({ sessionID: SESSION, requestID, op: { kind: "single", q: 0, value: "A" } })
    Doc.questionDraftApply({ sessionID: SESSION, requestID, op: { kind: "single", q: 0, value: "B" } })
    expect(seen.filter((event) => event.type === "draft").at(-1)?.draft?.answers[0]).toEqual(["B"])

    Doc.questionDraftApply({ sessionID: SESSION, requestID, op: { kind: "toggle", q: 1, label: "X", on: true } })
    Doc.questionDraftApply({ sessionID: SESSION, requestID, op: { kind: "toggle", q: 1, label: "Y", on: true } })
    expect(seen.filter((event) => event.type === "draft").at(-1)?.draft?.answers[1]).toEqual(["X", "Y"])
    Doc.questionDraftApply({ sessionID: SESSION, requestID, op: { kind: "toggle", q: 1, label: "X", on: false } })
    const afterMulti = seen.filter((event) => event.type === "draft").at(-1)?.draft
    expect(afterMulti?.answers[1]).toEqual(["Y"])
    expect(afterMulti?.rev).toBe(5)

    const late: ChannelEvent[] = []
    const stopC = Doc.questionDraftConnect({
      sessionID: SESSION,
      requestID,
      actorID: bob!.actorID,
      peer: { send: collect(late) },
    })
    expect(late.find((event) => event.type === "draft")?.draft?.answers[0]).toEqual(["B"])

    stopA()
    stopB()
    stopC()
  })

  test("custom text and step ops", () => {
    const requestID = "question_custom"
    let draft = Doc.questionDraftApply({
      sessionID: SESSION,
      requestID,
      op: { kind: "custom", q: 0, text: "mine", on: true, multi: false },
    })
    expect(draft.answers[0]).toEqual(["mine"])
    expect(draft.custom[0]).toBe("mine")
    expect(draft.customOn[0]).toBe(true)
    draft = Doc.questionDraftApply({ sessionID: SESSION, requestID, op: { kind: "single", q: 0, value: "A" } })
    expect(draft.answers[0]).toEqual(["A"])
    expect(draft.customOn[0]).toBe(false)
    draft = Doc.questionDraftApply({ sessionID: SESSION, requestID, op: { kind: "single", q: 0, value: null } })
    expect(draft.answers[0]).toEqual([])

    Doc.questionDraftApply({ sessionID: SESSION, requestID, op: { kind: "toggle", q: 1, label: "X", on: true } })
    draft = Doc.questionDraftApply({
      sessionID: SESSION,
      requestID,
      op: { kind: "custom", q: 1, text: "foo", on: true, multi: true },
    })
    expect(draft.answers[1]).toEqual(["X", "foo"])
    draft = Doc.questionDraftApply({
      sessionID: SESSION,
      requestID,
      op: { kind: "custom", q: 1, text: "bar", on: true, multi: true },
    })
    expect(draft.answers[1]).toEqual(["X", "bar"])
    draft = Doc.questionDraftApply({
      sessionID: SESSION,
      requestID,
      op: { kind: "custom", q: 1, text: "bar", on: false, multi: true },
    })
    expect(draft.answers[1]).toEqual(["X"])
    expect(draft.custom[1]).toBe("bar")

    expect(Doc.questionDraftApply({ sessionID: SESSION, requestID, op: { kind: "step", value: 1.7 } }).step).toBe(1)
    expect(Doc.questionDraftApply({ sessionID: SESSION, requestID, op: { kind: "step", value: -3 } }).step).toBe(0)
  })

  test("question presence is snapshotted to late joiners and GC'd on resolve", () => {
    const [alice] = team("Alice")
    const requestID = "question_presence_1"
    const stopA = Doc.questionDraftConnect({
      sessionID: SESSION,
      requestID,
      actorID: alice!.actorID,
      peer: { send: () => undefined },
    })
    Doc.questionPresenceSet({
      sessionID: SESSION,
      requestID,
      entry: { actorID: alice!.actorID, name: "Alice", color: "#fff", qIndex: 0, selection: ["A"], customFocused: false },
    })

    const late: ChannelEvent[] = []
    const stopB = Doc.questionDraftConnect({
      sessionID: SESSION,
      requestID,
      actorID: "actor_late",
      peer: { send: collect(late) },
    })
    const presence = late.find((event) => event.type === "presence")?.presence
    expect(presence?.[0]?.actorID).toBe(alice!.actorID)
    expect(presence?.[0]?.selection).toEqual(["A"])

    Doc.questionDraftReset(requestID)
    const after: ChannelEvent[] = []
    const stopC = Doc.questionDraftConnect({
      sessionID: SESSION,
      requestID,
      actorID: "actor_late2",
      peer: { send: collect(after) },
    })
    expect(after.find((event) => event.type === "draft")).toBeUndefined()
    expect(after.find((event) => event.type === "presence")).toBeUndefined()

    stopA()
    stopB()
    stopC()
  })

  test("question presence is dropped only after the leave grace", async () => {
    const requestID = "question_presence_grace"
    const watcher: ChannelEvent[] = []
    const stopW = Doc.questionDraftConnect({
      sessionID: SESSION,
      requestID,
      actorID: "act_watcher",
      peer: { send: collect(watcher) },
    })
    let stopA = Doc.questionDraftConnect({
      sessionID: SESSION,
      requestID,
      actorID: "act_a",
      peer: { send: () => undefined },
    })
    Doc.questionPresenceSet({
      sessionID: SESSION,
      requestID,
      entry: { actorID: "act_a", name: "A", color: "#fff", qIndex: 0, selection: [], customFocused: true },
    })
    stopA()
    stopA = Doc.questionDraftConnect({ sessionID: SESSION, requestID, actorID: "act_a", peer: { send: () => undefined } })
    stopA()
    watcher.length = 0
    await wait(Doc.LEAVE_GRACE / 2)
    expect(watcher.length).toBe(0)
    await wait(Doc.LEAVE_GRACE / 2 + 300)
    expect(watcher).toEqual([{ type: "presence", presence: [] }])
    stopW()
  }, 10_000)
})

describe("Doc env drafts", () => {
  test("a non-actor (spectator) is refused", () => {
    let closed = 0
    const handle = Doc.envDraftConnect({
      sessionID: SESSION,
      requestID: "env_1",
      actorID: "act_viewer",
      key: "API_KEY",
      peer: { send: () => undefined, close: () => closed++ },
    })
    expect(handle).toBeUndefined()
    expect(closed).toBe(1)
  })

  test("actors share one LWW draft, late joiners get the snapshot and reset clears it", () => {
    const [alice, bob, carol] = team("Alice", "Bob", "Carol")
    const requestID = "env_shared"
    const aliceEvents: ChannelEvent[] = []
    const stopA = Doc.envDraftConnect({
      sessionID: SESSION,
      requestID,
      actorID: alice!.actorID,
      key: "API_KEY",
      peer: { send: collect(aliceEvents) },
    })!
    expect(aliceEvents[0]).toEqual({
      type: "draft",
      draft: { requestID, sessionID: SESSION, key: "API_KEY", value: "", rev: 0 },
    })

    Doc.envDraftApply({ sessionID: SESSION, requestID, key: "API_KEY", op: { kind: "value", text: "secret" } })
    Doc.envDraftApply({ sessionID: SESSION, requestID, key: "API_KEY", op: { kind: "key", text: "OPENAI_KEY" } })
    expect(aliceEvents.at(-1)?.draft).toEqual({
      requestID,
      sessionID: SESSION,
      key: "OPENAI_KEY",
      value: "secret",
      rev: 2,
    })

    Doc.envPresenceSet({
      sessionID: SESSION,
      requestID,
      entry: { actorID: alice!.actorID, name: "Alice", color: "#fff", editing: true },
    })
    expect(aliceEvents.at(-1)?.type).toBe("presence")

    const bobEvents: ChannelEvent[] = []
    const stopB = Doc.envDraftConnect({
      sessionID: SESSION,
      requestID,
      actorID: bob!.actorID,
      key: "API_KEY",
      peer: { send: collect(bobEvents) },
    })!
    expect(bobEvents[0]?.draft?.value).toBe("secret")
    expect(bobEvents[0]?.draft?.key).toBe("OPENAI_KEY")
    expect(bobEvents[1]?.presence?.[0]?.actorID).toBe(alice!.actorID)

    Doc.envDraftReset(requestID)
    expect(aliceEvents.at(-1)).toEqual({ type: "presence", presence: [] })
    expect(bobEvents.at(-1)).toEqual({ type: "presence", presence: [] })

    const carolEvents: ChannelEvent[] = []
    const stopC = Doc.envDraftConnect({
      sessionID: SESSION,
      requestID,
      actorID: carol!.actorID,
      key: "API_KEY",
      peer: { send: collect(carolEvents) },
    })!
    expect(carolEvents).toEqual([
      { type: "draft", draft: { requestID, sessionID: SESSION, key: "API_KEY", value: "", rev: 0 } },
    ])

    stopA()
    stopB()
    stopC()
  })

  test("an actor in another session is refused", () => {
    const outsider = Doc.actorUpsert({ sessionID: "ses_other", name: "Outsider" })
    let closed = 0
    const handle = Doc.envDraftConnect({
      sessionID: SESSION,
      requestID: "env_2",
      actorID: outsider.actorID,
      key: "K",
      peer: { send: () => undefined, close: () => closed++ },
    })
    expect(handle).toBeUndefined()
    expect(closed).toBe(1)
  })

  test("env presence is dropped after the leave grace", async () => {
    const [alice, bob] = team("Alice", "Bob")
    const requestID = "env_grace"
    const bobEvents: ChannelEvent[] = []
    const stopB = Doc.envDraftConnect({
      sessionID: SESSION,
      requestID,
      actorID: bob!.actorID,
      key: "K",
      peer: { send: collect(bobEvents) },
    })!
    const stopA = Doc.envDraftConnect({
      sessionID: SESSION,
      requestID,
      actorID: alice!.actorID,
      key: "K",
      peer: { send: () => undefined },
    })!
    Doc.envPresenceSet({
      sessionID: SESSION,
      requestID,
      entry: { actorID: alice!.actorID, name: "Alice", color: "#fff", editing: true },
    })
    stopA()
    bobEvents.length = 0
    await wait(Doc.LEAVE_GRACE + 300)
    expect(bobEvents).toEqual([{ type: "presence", presence: [] }])
    stopB()
  }, 10_000)

  test("heartbeat reaps silent draft peers too", () => {
    const [alice] = team("Alice")
    const t0 = 1_000_000
    setSystemTime(t0)
    let closedQuestion = 0
    let closedEnv = 0
    const stopQ = Doc.questionDraftConnect({
      sessionID: SESSION,
      requestID: "q_hb",
      actorID: alice!.actorID,
      peer: { send: () => undefined, close: () => closedQuestion++ },
    })
    const stopE = Doc.envDraftConnect({
      sessionID: SESSION,
      requestID: "e_hb",
      actorID: alice!.actorID,
      key: "K",
      peer: { send: () => undefined, close: () => closedEnv++ },
    })!
    setSystemTime(t0 + 3_000)
    Doc.heartbeatSweep()
    stopQ.pong()
    setSystemTime(t0 + 6_000)
    Doc.heartbeatSweep()
    expect(closedQuestion).toBe(0)
    expect(closedEnv).toBe(1)
    stopQ()
    stopE()
  })
})

type Turn = { id: string; text: string; created: number; metadata?: Record<string, unknown>; files?: Recorder.Message["files"] }
type Step = {
  id: string
  created: number
  completed?: number
  text?: string
  cost?: number
  tokens?: { input: number; output: number; reasoning?: number; cache?: { read: number; write: number } }
  error?: { type: string; message?: string }
}

function user(turn: Turn): Recorder.Message {
  return {
    id: turn.id,
    type: "user",
    text: turn.text,
    ...(turn.files ? { files: turn.files } : {}),
    ...(turn.metadata ? { metadata: turn.metadata } : {}),
    time: { created: turn.created },
  }
}

function assistant(step: Step): Recorder.Message {
  return {
    id: step.id,
    type: "assistant",
    model: { id: "claude-sonnet-4-6", providerID: "anthropic" },
    content: step.text === undefined ? [] : [{ type: "text", text: step.text }],
    cost: step.cost ?? 0.01,
    tokens: {
      input: step.tokens?.input ?? 1,
      output: step.tokens?.output ?? 1,
      reasoning: step.tokens?.reasoning ?? 0,
      cache: step.tokens?.cache ?? { read: 0, write: 0 },
    },
    ...(step.error ? { error: step.error } : {}),
    time: { created: step.created, ...(step.completed === undefined ? {} : { completed: step.completed }) },
  }
}

const cycles = () => Recorder.list({ sessionID: SESSION })

describe("Recorder", () => {
  test("records a prompt cycle when an assistant turn finishes", () => {
    const written = Recorder.record({
      sessionID: SESSION,
      directory: "/workspace/app",
      messages: [
        user({ id: "msg_user_1", text: "hello there", created: 1000 }),
        assistant({
          id: "msg_assistant_1",
          created: 1200,
          completed: 2000,
          text: "hello back",
          cost: 0.0123,
          tokens: { input: 10, output: 20 },
        }),
      ],
    })
    expect(written).toBe(1)

    const cycle = cycles()[0]
    expect(cycle).toBeDefined()
    expect(cycle!.inputs).toHaveLength(1)
    expect(cycle!.inputs[0]!.docID).toBeNull()
    expect(cycle!.inputs[0]!.prompt).toBe("hello there")
    expect(cycle!.inputs[0]!.userMessageID).toBe("msg_user_1")
    expect(cycle!.inputs[0]!.seq).toBe(0)
    expect(cycle!.inputs[0]!.actorIDs).toBeNull()
    expect(cycle!.inputs[0]!.consentMs).toBeNull()
    expect(cycle!.inputs[0]!.assets).toBeNull()
    expect(cycle!.response).toBe("hello back")
    expect(cycle!.assistantMessageID).toBe("msg_assistant_1")
    expect(cycle!.modelID).toBe("claude-sonnet-4-6")
    expect(cycle!.providerID).toBe("anthropic")
    expect(cycle!.tokensInput).toBe(10)
    expect(cycle!.tokensOutput).toBe(20)
    expect(cycle!.costTotal).toBeCloseTo(0.0123)
    expect(cycle!.ttftMs).toBe(200)
    expect(cycle!.timeCompleted).toBe(2000)
    expect(cycle!.aborted).toBe(false)
    expect(cycle!.status).toBe("completed")
    expect(cycle!.error).toBeNull()
    const stored = Store.db()
      .query<{ path: string | null }, [string]>("SELECT path FROM prompt_cycle WHERE id = ?")
      .get(cycle!.id)?.path
    expect(stored).toBe("/workspace/app")

    expect(Recorder.get(cycle!.id)).toEqual(cycle!)
    expect(Recorder.get("cyc_unknown")).toBeNull()
  })

  test("fills docID from the session's prompt doc even without consent", () => {
    const { docID } = Doc.prompt(SESSION)
    Recorder.record({
      sessionID: SESSION,
      messages: [user({ id: "msg_user_d", text: "hi", created: 1000 }), assistant({ id: "msg_a_d", created: 1000, completed: 1500, text: "yo" })],
    })
    const cycle = cycles()[0]
    expect(cycle?.inputs[0]!.docID).toBe(docID)
    expect(Recorder.list({ docID }).map((item) => item.id)).toContain(cycle!.id)
    expect(Recorder.list({ docID: "doc_other" })).toEqual([])
    expect(cycle?.inputs[0]!.actorIDs).toBeNull()
    expect(cycle?.inputs[0]!.consentMs).toBeNull()
  })

  test("docID comes from the prompt's authored doc (metadata), not the rotated session doc", () => {
    const { docID: rotated } = Doc.prompt(SESSION)
    Recorder.record({
      sessionID: SESSION,
      messages: [
        user({ id: "msg_user_meta", text: "hi", created: 1000, metadata: { jitda: { docID: "doc_authored" } } }),
        assistant({ id: "msg_a_meta", created: 1000, completed: 1500, text: "yo" }),
      ],
    })
    const input = cycles()[0]!.inputs[0]!
    expect(input.docID).toBe("doc_authored")
    expect(input.docID).not.toBe(rotated)
  })

  test("solo send fills actorIDs with the single sender from message metadata", () => {
    const me = Doc.actorUpsert({ sessionID: SESSION, name: "Me" })
    Recorder.record({
      sessionID: SESSION,
      messages: [
        user({ id: "msg_user_solo", text: "hi", created: 1000, metadata: { jitda: { actorID: me.actorID } } }),
        assistant({ id: "msg_a_solo", created: 1000, completed: 1500, text: "yo" }),
      ],
    })
    const input = cycles()[0]!.inputs[0]!
    expect(input.actorIDs).toEqual([me.actorID])
    expect(input.initiatorActorID).toBe(me.actorID)
    expect(input.submitID).toBeNull()
    expect(input.actorCount).toBe(1)
    expect(input.consentMs).toBeNull()
  })

  test("multi-party consent fills actorIDs with all approved actors", () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob] = team("Alice", "Bob")
    Store.db().run(
      `INSERT INTO doc_submit (id, session_id, target_kind, target_id, doc_id, actor_id, status, prompt, timeout_ms, expires_at, cancelled_by, user_message_id, time_created, time_updated)
       VALUES ('sub_multi', ?, 'doc', ?, ?, ?, 'sent', '{}', 1000, 9999999999999, NULL, 'msg_user_multi', 900, 1000)`,
      [SESSION, docID, docID, alice!.actorID],
    )
    for (const actor of [alice!, bob!])
      Store.db().run(
        "INSERT INTO doc_submit_actor (submit_id, actor_id, name, status, time_responded) VALUES ('sub_multi', ?, 'x', 'approved', 1000)",
        [actor.actorID],
      )

    Recorder.record({
      sessionID: SESSION,
      messages: [
        user({ id: "msg_user_multi", text: "team prompt", created: 950 }),
        assistant({ id: "msg_a_multi", created: 1200, completed: 3000, text: "answer", cost: 0.5 }),
      ],
    })

    const cycle = cycles()[0]!
    const input = cycle.inputs[0]!
    expect((input.actorIDs as string[]).sort()).toEqual([alice!.actorID, bob!.actorID].sort())
    expect(input.initiatorActorID).toBe(alice!.actorID)
    expect(input.submitID).toBe("sub_multi")
    expect(input.actorCount).toBe(2)
    expect(input.timeConsented).toBe(1000)
    expect(input.consentMs).toBe(100)
    expect(cycle.ttftMs).toBe(200)
  })

  test("a real consent vote links its user message to the recorded cycle", async () => {
    promptImpl = () => Promise.resolve({ messageID: "msg_user_vote" })
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob] = team("Alice", "Bob")
    const stop = quiet(docID, bob!.actorID)
    const state = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt: { text: "together" } })
    Doc.submitRespond({ sessionID: SESSION, submitID: state.submitID, actorID: bob!.actorID, action: "approve" })
    await flush()
    const body = called("prompt")[0]!.args[1] as { text: string; metadata: Record<string, unknown> }

    Recorder.record({
      sessionID: SESSION,
      messages: [
        user({ id: "msg_user_vote", text: body.text, created: Date.now(), metadata: body.metadata }),
        assistant({ id: "msg_a_vote", created: Date.now() + 10, completed: Date.now() + 20, text: "ok" }),
      ],
    })
    const input = cycles()[0]!.inputs[0]!
    expect(input.submitID).toBe(state.submitID)
    expect(input.docID).toBe(docID)
    expect((input.actorIDs as string[]).sort()).toEqual([alice!.actorID, bob!.actorID].sort())
    expect(input.initiatorActorID).toBe(alice!.actorID)
    expect(input.actorCount).toBe(2)
    stop()
  })

  test("consent falls back to metadata submitID when the host returned no message id", async () => {
    const { docID } = Doc.prompt(SESSION)
    const [alice, bob] = team("Alice", "Bob")
    const stop = quiet(docID, bob!.actorID)
    const state = Doc.submitCreate({ sessionID: SESSION, docID, actorID: alice!.actorID, prompt })
    Doc.submitRespond({ sessionID: SESSION, submitID: state.submitID, actorID: bob!.actorID, action: "approve" })
    await flush()
    const body = called("prompt")[0]!.args[1] as { metadata: Record<string, unknown> }

    Recorder.record({
      sessionID: SESSION,
      messages: [
        user({ id: "msg_user_nolink", text: "hi", created: 1000, metadata: body.metadata }),
        assistant({ id: "msg_a_nolink", created: 1100, completed: 1200, text: "ok" }),
      ],
    })
    const input = cycles()[0]!.inputs[0]!
    expect(input.submitID).toBe(state.submitID)
    expect(input.actorCount).toBe(2)
    stop()
  })

  test("captures prompt assets (attachments) on the input", () => {
    Recorder.record({
      sessionID: SESSION,
      messages: [
        user({
          id: "msg_user_asset",
          text: "look at this",
          created: 1000,
          files: [{ mime: "image/png", name: "pic.png", source: { uri: "/doc/doc_x/asset/ast_pic1" } }],
        }),
        assistant({ id: "msg_a_asset", created: 1000, completed: 1500, text: "ok" }),
      ],
    })
    expect(cycles()[0]!.inputs[0]!.assets).toEqual([
      { assetID: "ast_pic1", mime: "image/png", filename: "pic.png", url: "/doc/doc_x/asset/ast_pic1" },
    ])
  })

  test("assetID is extracted robustly from urls with query strings / trailing slashes", () => {
    Recorder.record({
      sessionID: SESSION,
      messages: [
        user({
          id: "msg_user_assetq",
          text: "x",
          created: 1000,
          files: [
            { mime: "image/png", name: "q.png", source: { uri: "/doc/doc_x/asset/ast_q1?sig=abc" } },
            { mime: "image/png", source: { uri: "/doc/doc_x/asset/ast_q2/#frag" } },
            { mime: "text/plain", source: { uri: "https://cdn.example.com/files/plain.txt" } },
          ],
        }),
        assistant({ id: "msg_a_assetq", created: 1000, completed: 1500, text: "ok" }),
      ],
    })
    const assets = cycles()[0]!.inputs[0]!.assets as { assetID?: string; filename?: string }[]
    expect(assets[0]!.assetID).toBe("ast_q1")
    expect(assets[1]!.assetID).toBe("ast_q2")
    expect(assets[1]).not.toHaveProperty("filename")
    expect(assets[2]!.assetID).toBe("plain.txt")
  })

  test("inline data: attachments are recorded without the base64 blob", () => {
    Recorder.record({
      sessionID: SESSION,
      messages: [
        user({
          id: "msg_user_data",
          text: "describe",
          created: 1000,
          files: [{ mime: "image/jpeg", name: "shot.jpg", source: { uri: "data:image/jpeg;base64,/9j/HUGEBLOB" } }],
        }),
        assistant({ id: "msg_a_data", created: 1000, completed: 1500, text: "ok" }),
      ],
    })
    expect(cycles()[0]!.inputs[0]!.assets).toEqual([{ mime: "image/jpeg", filename: "shot.jpg" }])
  })

  test("recording is idempotent per turn", () => {
    const messages = [
      user({ id: "msg_user_x", text: "hi", created: 1000 }),
      assistant({ id: "msg_a_x", created: 1000, completed: 1500, text: "yo" }),
    ]
    Recorder.record({ sessionID: SESSION, messages })
    Recorder.record({ sessionID: SESSION, messages })
    const list = cycles()
    expect(list).toHaveLength(1)
    expect(list[0]!.inputs).toHaveLength(1)
    const count = Store.db().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM prompt_cycle_input").get()?.n
    expect(count).toBe(1)
  })

  test("marks a cycle aborted when the step error is an abort", () => {
    Recorder.record({
      sessionID: SESSION,
      messages: [
        user({ id: "msg_user_2", text: "go", created: 1000 }),
        assistant({
          id: "msg_a_2",
          created: 1000,
          completed: 1500,
          text: "partial",
          cost: 0,
          tokens: { input: 5, output: 0 },
          error: { type: "MessageAbortedError", message: "stopped" },
        }),
      ],
    })
    const cycle = cycles()[0]
    expect(cycle?.status).toBe("aborted")
    expect(cycle?.aborted).toBe(true)
    expect(cycle?.error).toBe("stopped")
    expect(cycle?.response).toBe("partial")
  })

  test("interrupted marks only the last turn aborted", () => {
    Recorder.record({
      sessionID: SESSION,
      interrupted: true,
      messages: [
        user({ id: "msg_user_i1", text: "one", created: 1000 }),
        assistant({ id: "msg_a_i1", created: 1100, completed: 1200, text: "first" }),
        user({ id: "msg_user_i2", text: "two", created: 2000 }),
        assistant({ id: "msg_a_i2", created: 2100, completed: 2200, text: "second" }),
      ],
    })
    const byUser = new Map(cycles().map((cycle) => [cycle.inputs[0]!.userMessageID, cycle]))
    expect(byUser.get("msg_user_i1")?.status).toBe("completed")
    expect(byUser.get("msg_user_i2")?.status).toBe("aborted")
    expect(byUser.get("msg_user_i2")?.aborted).toBe(true)
    expect(byUser.get("msg_user_i2")?.error).toBeNull()
  })

  test("a non-abort error is recorded as error", () => {
    Recorder.record({
      sessionID: SESSION,
      messages: [
        user({ id: "msg_user_err", text: "go", created: 1000 }),
        assistant({ id: "msg_a_err", created: 1000, completed: 1500, error: { type: "ProviderError", message: "rate limited" } }),
      ],
    })
    const cycle = cycles()[0]
    expect(cycle?.status).toBe("error")
    expect(cycle?.aborted).toBe(false)
    expect(cycle?.error).toBe("rate limited")
  })

  test("aggregates a multi-step agent turn into ONE cycle", () => {
    const step1 = assistant({
      id: "msg_a_step1",
      created: 1100,
      completed: 1200,
      text: "",
      cost: 0.02,
      tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 1, write: 0 } },
    })
    const step2 = assistant({
      id: "msg_a_step2",
      created: 1300,
      completed: 1500,
      text: "final answer",
      cost: 0.04,
      tokens: { input: 200, output: 30, reasoning: 7, cache: { read: 2, write: 3 } },
    })
    const first = user({ id: "msg_user_multistep", text: "do the thing", created: 1000 })
    Recorder.record({ sessionID: SESSION, messages: [first, step1] })
    Recorder.record({ sessionID: SESSION, messages: [first, step1, step2] })

    const list = cycles()
    expect(list).toHaveLength(1)
    const cycle = list[0]!
    expect(cycle.inputs).toHaveLength(1)
    expect(cycle.inputs[0]!.prompt).toBe("do the thing")
    expect(cycle.response).toBe("final answer")
    expect(cycle.assistantMessageID).toBe("msg_a_step2")
    expect(cycle.tokensInput).toBe(300)
    expect(cycle.tokensOutput).toBe(40)
    expect(cycle.tokensReasoning).toBe(12)
    expect(cycle.tokensCacheRead).toBe(3)
    expect(cycle.tokensCacheWrite).toBe(3)
    expect(cycle.costTotal).toBeCloseTo(0.06)
    expect(cycle.timeOutputStart).toBe(1100)
    expect(cycle.timeCompleted).toBe(1500)
    expect(cycle.ttftMs).toBe(100)
    expect(cycle.status).toBe("completed")
  })

  test("one cycle per turn; unfinished steps and turns are skipped", () => {
    const written = Recorder.record({
      sessionID: SESSION,
      messages: [
        user({ id: "msg_u1", text: "first", created: 1000 }),
        assistant({ id: "msg_a1", created: 1100, completed: 1200, text: "one" }),
        user({ id: "msg_u2", text: "second", created: 2000 }),
        assistant({ id: "msg_a2", created: 2100, completed: 2200, text: "two" }),
        assistant({ id: "msg_a2b", created: 2300, text: "still running" }),
        user({ id: "msg_u3", text: "third", created: 3000 }),
        assistant({ id: "msg_a3", created: 3100 }),
      ],
    })
    expect(written).toBe(2)
    const list = cycles()
    expect(list.map((cycle) => cycle.inputs[0]!.prompt)).toEqual(["second", "first"])
    expect(list[0]!.response).toBe("two")
    expect(list[0]!.assistantMessageID).toBe("msg_a2")
    expect(Recorder.list({ sessionID: SESSION, status: "completed", limit: 1 })).toHaveLength(1)
    expect(Recorder.list({ sessionID: SESSION, limit: 1, offset: 1 })[0]!.inputs[0]!.prompt).toBe("first")
  })

  test("string timestamps are parsed", () => {
    Recorder.record({
      sessionID: SESSION,
      messages: [
        { id: "msg_u_iso", type: "user", text: "iso", time: { created: "2026-10-19T00:00:00.000Z" } },
        {
          id: "msg_a_iso",
          type: "assistant",
          content: [{ type: "text", text: "ok" }],
          time: { created: "2026-10-19T00:00:01.000Z", completed: "2026-10-19T00:00:02.000Z" },
        },
      ],
    })
    const cycle = cycles()[0]!
    expect(cycle.timeCreated).toBe(Date.parse("2026-10-19T00:00:00.000Z"))
    expect(cycle.ttftMs).toBe(1000)
    expect(cycle.modelID).toBeNull()
  })
})

describe("Store", () => {
  const dirs: string[] = []
  afterEach(async () => {
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
  })

  async function legacyFile() {
    const dir = await mkdtemp(path.join(tmpdir(), "jitda-doc-legacy-"))
    dirs.push(dir)
    const file = path.join(dir, "opencode.db")
    const db = new Database(file, { create: true })
    db.run("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT)")
    db.run(
      "CREATE TABLE doc (id TEXT PRIMARY KEY, kind TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, legacy_only TEXT)",
    )
    db.run("CREATE TABLE doc_update (id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, data BLOB NOT NULL, time_created INTEGER NOT NULL)")
    db.run("CREATE TABLE session_prompt_doc (session_id TEXT PRIMARY KEY, doc_id TEXT NOT NULL)")
    db.run(
      "CREATE TABLE session_actor (session_id TEXT NOT NULL, actor_id TEXT NOT NULL, user_id TEXT, name TEXT NOT NULL, color TEXT NOT NULL, time_created INTEGER NOT NULL, time_seen INTEGER NOT NULL, PRIMARY KEY (session_id, actor_id))",
    )
    db.run(
      "CREATE TABLE doc_submit (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, target_kind TEXT NOT NULL DEFAULT 'doc', target_id TEXT NOT NULL, doc_id TEXT, actor_id TEXT NOT NULL, status TEXT NOT NULL, prompt TEXT NOT NULL, timeout_ms INTEGER NOT NULL, expires_at INTEGER NOT NULL, cancelled_by TEXT, user_message_id TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)",
    )
    db.run(
      "CREATE TABLE doc_submit_actor (submit_id TEXT NOT NULL, actor_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, time_responded INTEGER, PRIMARY KEY (submit_id, actor_id))",
    )
    db.run(
      "CREATE TABLE prompt_cycle (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_message_id TEXT NOT NULL, path TEXT, time_created INTEGER NOT NULL, assistant_message_id TEXT NOT NULL, response TEXT, model_id TEXT, provider_id TEXT, time_output_start INTEGER, time_completed INTEGER, ttft_ms INTEGER, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost_total REAL, status TEXT NOT NULL DEFAULT 'running', aborted INTEGER NOT NULL DEFAULT 0, error TEXT)",
    )
    db.run(
      "CREATE TABLE prompt_cycle_input (id TEXT NOT NULL, cycle_id TEXT NOT NULL, session_id TEXT NOT NULL, doc_id TEXT, submit_id TEXT, actor_ids TEXT, initiator_actor_id TEXT, seq INTEGER NOT NULL DEFAULT 0, prompt TEXT NOT NULL, assets TEXT, actor_count INTEGER NOT NULL DEFAULT 1, user_message_id TEXT, time_created INTEGER NOT NULL, time_consented INTEGER, consent_ms INTEGER, PRIMARY KEY (cycle_id, id))",
    )

    const ydoc = new Y.Doc({ guid: "doc_legacy" })
    ydoc.getText("t").insert(0, "from v1")
    db.run("INSERT INTO session (id, title) VALUES ('ses_legacy', 'old')")
    db.run("INSERT INTO doc VALUES ('doc_legacy', 'prompt', 100, 200, 'ignored')")
    db.run("INSERT INTO doc_update VALUES ('upd_1', 'doc_legacy', ?, 150)", [
      Wire.pack(Wire.MSG_DOC, "doc_legacy", Y.encodeStateAsUpdate(ydoc)),
    ])
    db.run("INSERT INTO session_prompt_doc VALUES ('ses_legacy', 'doc_legacy')")
    db.run("INSERT INTO session_actor VALUES ('ses_legacy', 'act_legacy', 'u1', 'Old Alice', '#e03131', 100, 100)")
    db.run(
      "INSERT INTO doc_submit VALUES ('sub_legacy', 'ses_legacy', 'doc', 'doc_legacy', 'doc_legacy', 'act_legacy', 'sent', '{}', 30000, 30100, NULL, 'msg_legacy', 100, 120)",
    )
    db.run("INSERT INTO doc_submit_actor VALUES ('sub_legacy', 'act_legacy', 'Old Alice', 'approved', 120)")
    db.run(
      "INSERT INTO prompt_cycle (id, session_id, user_message_id, time_created, assistant_message_id, response, status, aborted) VALUES ('cyc_legacy', 'ses_legacy', 'msg_legacy', 100, 'msg_legacy_a', 'old answer', 'completed', 0)",
    )
    db.run(
      `INSERT INTO prompt_cycle_input (id, cycle_id, session_id, doc_id, submit_id, actor_ids, initiator_actor_id, prompt, actor_count, user_message_id, time_created)
       VALUES ('cin_legacy', 'cyc_legacy', 'ses_legacy', 'doc_legacy', 'sub_legacy', '["act_legacy"]', 'act_legacy', 'old prompt', 1, 'msg_legacy', 100)`,
    )
    db.close()
    return { dir, file }
  }

  test("importLegacy copies V1 rows once and a second import is a no-op", async () => {
    const { file } = await legacyFile()
    expect(Store.importLegacy(Store.db(), file)).toBe(8)

    expect(Doc.prompt("ses_legacy").docID).toBe("doc_legacy")
    expect(Doc.get("doc_legacy").time_created).toBe(100)
    const pulled = Doc.syncPull({ docID: "doc_legacy", guid: "doc_legacy", state: new Uint8Array() })
    const remote = new Y.Doc()
    Y.applyUpdate(remote, pulled!.data)
    expect(remote.getText("t").toString()).toBe("from v1")
    expect(Doc.actorList("ses_legacy")).toEqual([
      { actorID: "act_legacy", sessionID: "ses_legacy", userID: "u1", name: "Old Alice", color: "#e03131" },
    ])
    const [cycle] = Recorder.list({ sessionID: "ses_legacy" })
    expect(cycle?.response).toBe("old answer")
    expect(cycle?.inputs[0]!.actorIDs).toEqual(["act_legacy"])
    expect(cycle?.inputs[0]!.submitID).toBe("sub_legacy")
    expect(
      Store.db().query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'").get(),
    ).toBeNull()

    const legacy = new Database(file)
    legacy.run("INSERT INTO doc VALUES ('doc_new', 'prompt', 300, 300, NULL)")
    legacy.close()
    expect(Store.importLegacy(Store.db(), file)).toBe(0)
    expect(() => Doc.get("doc_new")).toThrow(Doc.NotFoundError)
  })

  test("open with a legacy path imports into a file store only on first open", async () => {
    const { dir, file } = await legacyFile()
    const target = path.join(dir, "nested", "jitda.db")
    Store.open(target, file)
    expect(Doc.prompt("ses_legacy").docID).toBe("doc_legacy")
    const meta = Store.db().query<{ value: string }, []>("SELECT value FROM jitda_meta WHERE key = 'legacy_import'").get()
    expect(meta?.value).toBeDefined()

    const legacy = new Database(file)
    legacy.run("INSERT INTO doc VALUES ('doc_new', 'prompt', 300, 300, NULL)")
    legacy.close()
    Store.open(target, file)
    expect(Store.ready()).toBe(true)
    expect(() => Doc.get("doc_new")).toThrow(Doc.NotFoundError)
    expect(Doc.get("doc_legacy").id).toBe("doc_legacy")
  })

  test("a missing legacy file imports nothing and is still marked done", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "jitda-doc-legacy-"))
    dirs.push(dir)
    expect(Store.importLegacy(Store.db(), path.join(dir, "missing.db"))).toBe(0)
    expect(Store.db().query("SELECT value FROM jitda_meta WHERE key = 'legacy_import'").get()).not.toBeNull()
  })

  test("ascending ids keep the prefix and sort in creation order", () => {
    const ids = Array.from({ length: 200 }, () => Store.ascending("sub"))
    expect(ids.every((id) => id.startsWith("sub_"))).toBe(true)
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
    expect(Store.valid("sub", ids[0])).toBe(true)
    expect(Store.valid("doc", ids[0])).toBe(false)
    expect(Store.valid("sub", 1)).toBe(false)
  })

  test("db throws when the store is closed", () => {
    Store.close()
    expect(Store.ready()).toBe(false)
    expect(() => Store.db()).toThrow()
    Store.open(":memory:")
  })
})
