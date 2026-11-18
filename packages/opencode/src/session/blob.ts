import { createHash } from "node:crypto"
import { and, eq, exists, inArray, notExists, sql, type SQL } from "drizzle-orm"
import type { Database } from "@/storage/db"
import { Instance } from "@/project/instance"
import type { MessageID, SessionID } from "./schema"
import { BlobRefTable, BlobTable, PartTable } from "./session.sql"
import { SessionStored } from "./stored"

export namespace SessionBlob {
  type Db = Database.TxOrDb
  type File = { type: "file"; mime: string; filename?: string; url: string }
  type Stored = Record<string, any>
  type Blobs = ReadonlyMap<string, string>
  type Pending = Map<string, typeof BlobTable.$inferInsert>

  const BATCH = 500
  const DATA_URI = /^data:[^,]*;base64,(.*)$/s

  function batches<T>(items: readonly T[]) {
    const out: T[][] = []
    for (let i = 0; i < items.length; i += BATCH) out.push(items.slice(i, i + BATCH))
    return out
  }

  const configured = new Map<string, boolean>()

  function fromEnv() {
    const items = (process.env.OPENCODE_FLAGS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
    if (items.includes("-media_blob")) return false
    if (items.includes("media_blob") || items.includes("all")) return true
  }

  export function configure(directory: string, value: boolean | undefined) {
    if (value === undefined) configured.delete(directory)
    else configured.set(directory, value)
  }

  export function enabled() {
    const env = fromEnv()
    if (env !== undefined) return env
    const directory = (() => {
      try {
        return Instance.directory
      } catch {
        return undefined
      }
    })()
    return directory === undefined ? false : (configured.get(directory) ?? false)
  }

  const isFile = (value: unknown): value is File =>
    typeof value === "object" &&
    value !== null &&
    (value as File).type === "file" &&
    typeof (value as File).url === "string"

  const isFileRef = (value: unknown): value is File & { url: SessionStored.Ref } =>
    isFile(value) && SessionStored.isRef(value.url)

  function attachments(part: Stored): unknown[] {
    if (part.type !== "tool") return []
    const state = part.state
    if (!state || (state.status !== "completed" && state.status !== "error")) return []
    return Array.isArray(state.attachments) ? state.attachments : []
  }

  function collect(part: Stored, hashes: Set<string>) {
    if (isFileRef(part)) hashes.add(SessionStored.refHash(part.url))
    for (const item of attachments(part)) if (isFileRef(item)) hashes.add(SessionStored.refHash(item.url))
  }

  const hashesOf = (parts: Iterable<Stored>) => {
    const hashes = new Set<string>()
    for (const part of parts) collect(part, hashes)
    return hashes
  }

  const unavailable = (mime: string, name?: string) =>
    `[media unavailable: ${name === undefined ? mime : `${name} (${mime})`}]`

  function unavailableFile<T extends File>(file: T): T {
    const text = Buffer.from(unavailable(file.mime, file.filename)).toString("base64")
    return { ...file, mime: "text/plain", url: `data:text/plain;base64,${text}` }
  }

  function inlineFile<T extends File>(file: T, blobs: Blobs): T {
    if (!isFileRef(file)) return file
    const data = blobs.get(SessionStored.refHash(file.url))
    if (data === undefined) return unavailableFile(file)
    return { ...file, url: `data:${file.mime};base64,${data}` }
  }

  function rewrite<T extends Stored>(part: T, file: (file: File) => File): T {
    if (isFileRef(part)) return file(part as unknown as File) as unknown as T
    const items = attachments(part)
    if (!items.some(isFileRef)) return part
    return {
      ...part,
      state: { ...part.state, attachments: items.map((item) => (isFileRef(item) ? file(item) : item)) },
    }
  }

  const view = (data: Uint8Array) =>
    Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength)

  function load(db: Db, hashes: ReadonlySet<string>) {
    const blobs = new Map<string, string>()
    for (const batch of batches([...hashes])) {
      const found = db
        .select({ hash: BlobTable.hash, data: BlobTable.data })
        .from(BlobTable)
        .where(inArray(BlobTable.hash, batch))
        .all()
      for (const blob of found) blobs.set(blob.hash, view(blob.data).toString("base64"))
    }
    return blobs
  }

  export function hydrate<T extends Stored>(db: Db, parts: readonly T[]): T[] {
    const hashes = hashesOf(parts)
    if (hashes.size === 0) return [...parts]
    const blobs = load(db, hashes)
    return parts.map((part) => rewrite(part, (file) => inlineFile(file, blobs)))
  }

  export interface Meta {
    readonly bytes: number
    readonly width: number | null
    readonly height: number | null
  }

  const referenced = (db: Db) =>
    exists(
      db
        .select({ one: sql`1` })
        .from(BlobRefTable)
        .where(eq(BlobRefTable.hash, BlobTable.hash)),
    )

  function loadMeta(db: Db, hashes: ReadonlySet<string>) {
    const meta = new Map<string, Meta>()
    for (const batch of batches([...hashes])) {
      const found = db
        .select({ hash: BlobTable.hash, bytes: BlobTable.bytes, width: BlobTable.width, height: BlobTable.height })
        .from(BlobTable)
        .where(and(inArray(BlobTable.hash, batch), referenced(db)))
        .all()
      for (const { hash, ...rest } of found) meta.set(hash, rest)
    }
    return meta
  }

  export function keepRefs<T extends Stored>(db: Db, parts: readonly T[]): T[] {
    const hashes = hashesOf(parts)
    if (hashes.size === 0) return [...parts]
    const meta = loadMeta(db, hashes)
    return parts.map((part) =>
      rewrite(part, (file) =>
        meta.has(SessionStored.refHash(file.url as SessionStored.Ref)) ? file : unavailableFile(file),
      ),
    )
  }

  export function read(db: Db, hash: string) {
    const blob = db
      .select({ mime: BlobTable.mime, data: BlobTable.data })
      .from(BlobTable)
      .where(and(eq(BlobTable.hash, hash), referenced(db)))
      .get()
    return blob && { mime: blob.mime, data: view(blob.data) }
  }

  export const hashBytes = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex")

  export interface Owner {
    readonly sessionID: SessionID
    readonly messageID: MessageID
    readonly seq: number
  }

  function take(pending: Pending, raw: Buffer, mime: string) {
    const hash = hashBytes(raw)
    if (!pending.has(hash)) pending.set(hash, { hash, mime, bytes: raw.byteLength, data: raw })
    return SessionStored.ref(hash)
  }

  function toRef<T extends File>(pending: Pending, file: T): T {
    if (isFileRef(file)) return file
    const data = DATA_URI.exec(file.url)?.[1]
    return data === undefined ? file : { ...file, url: take(pending, Buffer.from(data, "base64"), file.mime) }
  }

  function partRefs<T extends Stored>(pending: Pending, part: T): T {
    if (isFile(part)) return toRef(pending, part as unknown as File) as unknown as T
    const items = attachments(part)
    if (!items.some((item) => isFile(item) && DATA_URI.test(item.url))) return part
    return {
      ...part,
      state: { ...part.state, attachments: items.map((item) => (isFile(item) ? toRef(pending, item) : item)) },
    }
  }

  export function save(db: Db, blobs: ReadonlyArray<typeof BlobTable.$inferInsert>) {
    for (const blob of blobs) db.insert(BlobTable).values(blob).onConflictDoNothing().run()
  }

  export function externalize<T extends Stored>(db: Db, part: T): T {
    if (!enabled()) return part
    const pending: Pending = new Map()
    const stored = partRefs(pending, part)
    if (pending.size === 0) return part
    save(db, [...pending.values()])
    return stored
  }

  export function recordHashes(db: Db, owner: Owner, hashes: ReadonlySet<string>) {
    const found: Array<{ hash: string }> = []
    for (const batch of batches([...hashes]))
      found.push(...db.select({ hash: BlobTable.hash }).from(BlobTable).where(inArray(BlobTable.hash, batch)).all())
    for (const { hash } of found)
      db.insert(BlobRefTable)
        .values({ session_id: owner.sessionID, message_id: owner.messageID, hash, seq: owner.seq })
        .onConflictDoUpdate({
          target: [BlobRefTable.session_id, BlobRefTable.message_id, BlobRefTable.hash],
          set: { seq: owner.seq },
        })
        .run()
  }

  export function recordRefs(db: Db, owner: Owner, part: Stored) {
    const hashes = hashesOf([part])
    if (hashes.size > 0) recordHashes(db, owner, hashes)
  }

  const own = (owner: Pick<Owner, "sessionID" | "messageID">) =>
    [eq(BlobRefTable.session_id, owner.sessionID), eq(BlobRefTable.message_id, owner.messageID)] as const

  export function holds(db: Db, owner: Pick<Owner, "sessionID" | "messageID">) {
    return (
      db
        .select({ one: sql`1` })
        .from(BlobRefTable)
        .where(and(...own(owner)))
        .limit(1)
        .get() !== undefined
    )
  }

  export function drops(before: Stored, after: Stored) {
    const kept = hashesOf([after])
    return [...hashesOf([before])].some((hash) => !kept.has(hash))
  }

  export function syncMessage(db: Db, owner: Pick<Owner, "sessionID" | "messageID">) {
    const present = hashesOf(
      db
        .select({ data: PartTable.data })
        .from(PartTable)
        .where(eq(PartTable.message_id, owner.messageID))
        .all()
        .map((row) => row.data as Stored),
    )
    if (present.size === 0) return release(db, ...own(owner))
    const stale = db
      .select({ hash: BlobRefTable.hash })
      .from(BlobRefTable)
      .where(and(...own(owner)))
      .all()
      .flatMap((ref) => (present.has(ref.hash) ? [] : [ref.hash]))
    for (const batch of batches(stale)) release(db, ...own(owner), inArray(BlobRefTable.hash, batch))
  }

  function release(db: Db, ...where: readonly [SQL, ...SQL[]]) {
    const released = db
      .delete(BlobRefTable)
      .where(and(...where))
      .returning({ hash: BlobRefTable.hash })
      .all()
    for (const batch of batches([...new Set(released.map((ref) => ref.hash))]))
      db.delete(BlobTable)
        .where(
          and(
            inArray(BlobTable.hash, batch),
            notExists(
              db
                .select({ one: sql`1` })
                .from(BlobRefTable)
                .where(eq(BlobRefTable.hash, BlobTable.hash)),
            ),
          ),
        )
        .run()
  }

  export const releaseMessage = (db: Db, sessionID: SessionID, messageID: MessageID) =>
    release(db, eq(BlobRefTable.session_id, sessionID), eq(BlobRefTable.message_id, messageID))

  export const releaseSession = (db: Db, sessionID: SessionID) => release(db, eq(BlobRefTable.session_id, sessionID))
}
