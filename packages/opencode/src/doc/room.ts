import * as Y from "yjs"
import { modifyAwarenessUpdate } from "y-protocols/awareness"
import type { DocID } from "./schema"
import { MSG_AWARENESS, MSG_DOC, pack, unpack, unpackLegacy } from "./wire"

export { MSG_DOC, MSG_AWARENESS }

export type Peer = {
  send: (data: Uint8Array) => void
  awareness?: Uint8Array
}

type Room = {
  doc: Y.Doc
  peers: Set<Peer>
  // Pending awareness removals, keyed by Yjs clientID. A peer's cursor is not removed the instant its
  // socket closes (a backgrounded tab closes/freezes the WS within seconds); instead we wait out a
  // grace window so a quick tab-switch + reconnect never makes the cursor flicker for other peers.
  // A reconnect — an awareness update carrying the same clientID — cancels the pending removal.
  leaving: Map<number, ReturnType<typeof setTimeout>>
}

// Kept under the Yjs client `outdatedTimeout` (30s): past that, peers prune the stale cursor on their
// own, so a longer server grace buys nothing. Mirrors the LEAVE_GRACE idea in doc/index.ts.
const AWARENESS_LEAVE_GRACE = 20_000
let graceMs = AWARENESS_LEAVE_GRACE

// Test-only: shrink the grace so expiry/cancel can be asserted without a 20s wait. Call with no
// argument to restore the default.
export function setAwarenessGraceForTest(ms?: number) {
  graceMs = ms ?? AWARENESS_LEAVE_GRACE
}

type Target = {
  doc: Y.Doc
  added: boolean
}

const rooms = new Map<DocID, Room>()

function room(id: DocID) {
  let r = rooms.get(id)
  if (r) return r
  r = {
    doc: new Y.Doc({ guid: id }),
    peers: new Set(),
    leaving: new Map(),
  }
  rooms.set(id, r)
  return r
}

// Pull the Yjs clientIDs out of an encoded awareness update without depending on lib0 (not a direct
// dependency here). Wire format: varUint count, then per client { varUint clientID, varUint clock,
// varString state }, where varString is a varUint byte-length followed by that many bytes.
function clients(update: Uint8Array): number[] {
  let pos = 0
  const readVarUint = () => {
    let num = 0
    let mult = 1
    for (;;) {
      const byte = update[pos++]
      if (byte === undefined) throw new Error("eof")
      num += (byte & 0x7f) * mult
      if (byte < 0x80) return num
      mult *= 128
    }
  }
  const ids: number[] = []
  try {
    const count = readVarUint()
    for (let i = 0; i < count; i++) {
      const clientID = readVarUint()
      readVarUint() // clock
      pos += readVarUint() // skip the state bytes
      ids.push(clientID)
    }
  } catch {
    return ids
  }
  return ids
}

// Tear the room down only once it has no live peers AND no pending grace removals, so a peer that
// reconnects mid-grace still finds the same room (and its `leaving` timers) to cancel against.
function reap(id: DocID, r: Room) {
  if (r.peers.size > 0 || r.leaving.size > 0) return
  r.doc.destroy()
  rooms.delete(id)
}

function target(r: Room, guid: string): Target {
  if (guid === r.doc.guid) return { doc: r.doc, added: false }
  for (const sub of r.doc.getSubdocs()) {
    if (sub.guid === guid) return { doc: sub, added: false }
  }
  const sub = new Y.Doc({ guid })
  r.doc.getMap("spaces").set(guid, sub)
  return { doc: sub, added: true }
}

export function apply(id: DocID, guid: string, data: Uint8Array) {
  Y.applyUpdate(target(room(id), guid).doc, data)
}

export function pull(id: DocID, guid: string, state: Uint8Array) {
  const doc = target(room(id), guid).doc
  const update = Y.encodeStateAsUpdate(doc, state.length > 0 ? state : undefined)
  const vector = Y.encodeStateVector(doc)
  if (update.length === 0) return null
  return { data: update, state: vector }
}

export function push(id: DocID, guid: string, data: Uint8Array, from?: Peer) {
  const r = room(id)
  const next = target(r, guid)
  Y.applyUpdate(next.doc, data)
  const root = next.added ? pack(MSG_DOC, r.doc.guid, Y.encodeStateAsUpdate(r.doc)) : undefined
  const payload = pack(MSG_DOC, guid, data)
  for (const peer of r.peers) {
    if (peer === from) continue
    if (root) peer.send(root)
    peer.send(payload)
  }
}

export function awareness(id: DocID, data: Uint8Array, from?: Peer) {
  const r = room(id)
  if (from) from.awareness = data
  // A still-active (or just-reconnected) client cancels any pending removal for its clientID, so its
  // grace timer never fires and the cursor stays put.
  for (const clientID of clients(data)) {
    const timer = r.leaving.get(clientID)
    if (!timer) continue
    clearTimeout(timer)
    r.leaving.delete(clientID)
  }
  const payload = pack(MSG_AWARENESS, "", data)
  for (const peer of r.peers) {
    if (peer === from) continue
    peer.send(payload)
  }
}

function remove(data: Uint8Array) {
  try {
    return modifyAwarenessUpdate(data, () => null)
  } catch {
    return
  }
}

export function connect(id: DocID, peer: Peer) {
  const r = room(id)
  r.peers.add(peer)
  peer.send(pack(MSG_DOC, r.doc.guid, Y.encodeStateAsUpdate(r.doc)))
  for (const sub of r.doc.getSubdocs()) {
    peer.send(pack(MSG_DOC, sub.guid, Y.encodeStateAsUpdate(sub)))
  }
  for (const next of r.peers) {
    if (next === peer || !next.awareness) continue
    peer.send(pack(MSG_AWARENESS, "", next.awareness))
  }
  return () => {
    r.peers.delete(peer)
    // Defer the cursor removal: only broadcast it if the same client hasn't reconnected within the
    // grace window. `awareness()` cancels the timer on reconnect.
    const data = peer.awareness
    const ids = data ? clients(data) : []
    for (const clientID of ids) {
      const existing = r.leaving.get(clientID)
      if (existing) clearTimeout(existing)
      const timer = setTimeout(() => {
        r.leaving.delete(clientID)
        const left = remove(data!)
        if (left) {
          const payload = pack(MSG_AWARENESS, "", left)
          for (const next of r.peers) next.send(payload)
        }
        reap(id, r)
      }, graceMs)
      timer.unref?.()
      r.leaving.set(clientID, timer)
    }
    reap(id, r)
  }
}

export function decode(buf: Uint8Array, root: string) {
  const next = unpack(buf)
  if (next) {
    if (next.type === MSG_DOC) return { type: MSG_DOC, guid: next.guid, data: next.data }
    if (next.type === MSG_AWARENESS) return { type: MSG_AWARENESS, guid: next.guid, data: next.data }
    return
  }
  const legacy = unpackLegacy(buf)
  if (!legacy) return
  if (legacy.type === MSG_DOC) return { type: MSG_DOC, guid: root, data: legacy.data }
  if (legacy.type === MSG_AWARENESS) return { type: MSG_AWARENESS, guid: root, data: legacy.data }
}
