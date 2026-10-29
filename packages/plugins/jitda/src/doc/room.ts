import * as Y from "yjs"
import { modifyAwarenessUpdate } from "y-protocols/awareness"
import { CLOSE_SESSION_ENDED, MSG_AWARENESS, MSG_DOC, pack, unpack, unpackLegacy } from "./wire"

// 협업 프롬프트 문서의 메모리 방. 서브문서(스페이스)와 awareness 를 중계한다.
// 커서는 소켓이 닫혀도 바로 지우지 않는다. 탭을 잠깐 옮겼다 돌아오면 같은 clientID 로 다시 붙으므로 유예 동안 기다린다.

export { CLOSE_SESSION_ENDED, MSG_DOC, MSG_AWARENESS }

export type Peer = {
  send: (data: Uint8Array) => void
  close?: (code?: number, reason?: string) => void
  awareness?: Uint8Array
}

type Room = {
  doc: Y.Doc
  peers: Set<Peer>
  leaving: Map<number, ReturnType<typeof setTimeout>>
}

// Yjs 클라이언트 outdatedTimeout(30s)보다 짧게 둔다. 그 이상은 클라이언트가 알아서 지운다.
const AWARENESS_LEAVE_GRACE = 20_000
let graceMs = AWARENESS_LEAVE_GRACE

export function setAwarenessGraceForTest(ms?: number) {
  graceMs = ms ?? AWARENESS_LEAVE_GRACE
}

const rooms = new Map<string, Room>()

function room(id: string) {
  const found = rooms.get(id)
  if (found) return found
  const next: Room = { doc: new Y.Doc({ guid: id }), peers: new Set(), leaving: new Map() }
  rooms.set(id, next)
  return next
}

export function loaded(id: string) {
  return rooms.has(id)
}

// awareness 업데이트에서 clientID 만 뽑는다. 형식: varUint count, 각 클라이언트 { varUint id, varUint clock, varString state }.
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
      readVarUint()
      pos += readVarUint()
      ids.push(clientID)
    }
  } catch {
    return ids
  }
  return ids
}

function reap(id: string, r: Room) {
  if (r.peers.size > 0 || r.leaving.size > 0) return
  r.doc.destroy()
  rooms.delete(id)
}

function target(r: Room, guid: string) {
  if (guid === r.doc.guid) return { doc: r.doc, added: false }
  for (const sub of r.doc.getSubdocs()) {
    if (sub.guid === guid) return { doc: sub, added: false }
  }
  const sub = new Y.Doc({ guid })
  r.doc.getMap("spaces").set(guid, sub)
  return { doc: sub, added: true }
}

export function apply(id: string, guid: string, data: Uint8Array) {
  Y.applyUpdate(target(room(id), guid).doc, data)
}

export function pull(id: string, guid: string, state: Uint8Array) {
  const doc = target(room(id), guid).doc
  const update = Y.encodeStateAsUpdate(doc, state.length > 0 ? state : undefined)
  const vector = Y.encodeStateVector(doc)
  if (update.length === 0) return null
  return { data: update, state: vector }
}

export function push(id: string, guid: string, data: Uint8Array, from?: Peer) {
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

export function awareness(id: string, data: Uint8Array, from?: Peer) {
  const r = room(id)
  if (from) from.awareness = data
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

export function connect(id: string, peer: Peer) {
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

export function closeAll(code?: number, reason?: string) {
  for (const r of rooms.values()) {
    for (const peer of r.peers) peer.close?.(code, reason)
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

export function resetForTest() {
  for (const r of rooms.values()) {
    for (const timer of r.leaving.values()) clearTimeout(timer)
    r.doc.destroy()
  }
  rooms.clear()
}
