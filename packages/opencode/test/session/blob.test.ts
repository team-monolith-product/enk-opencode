import { afterEach, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import path from "path"
import { eq } from "drizzle-orm"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionBlob } from "../../src/session/blob"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { BlobRefTable, BlobTable, PartTable } from "../../src/session/session.sql"
import { Database } from "../../src/storage/db"
import { Log } from "../../src/util/log"

const root = path.join(__dirname, "../..")
Log.init({ print: false })

afterEach(() => SessionBlob.configure(root, undefined))

const png = () => randomBytes(256)
const dataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString("base64")}`

async function message(sessionID: SessionID) {
  const id = MessageID.ascending()
  await Session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as MessageV2.Info)
  return id
}

async function screenshot(sessionID: SessionID, messageID: MessageID, bytes: Buffer) {
  const id = PartID.ascending()
  await Session.updatePart({
    id,
    sessionID,
    messageID,
    type: "tool",
    callID: `call_${id}`,
    tool: "read",
    state: {
      status: "completed",
      input: { filePath: "/tmp/shot.png" },
      output: "Image read successfully",
      title: "shot.png",
      metadata: {},
      time: { start: 1, end: 2 },
      attachments: [
        { id: PartID.ascending(), sessionID, messageID, type: "file", mime: "image/png", url: dataUrl(bytes) },
      ],
    },
  } as MessageV2.ToolPart)
  return id
}

const stored = (id: PartID) =>
  Database.use((db) => db.select().from(PartTable).where(eq(PartTable.id, id)).get()!.data as MessageV2.ToolPart)

const attachment = (part: MessageV2.Part) =>
  part.type === "tool" && part.state.status === "completed" ? part.state.attachments?.[0]?.url : undefined

const hashOf = (bytes: Buffer) => SessionBlob.hashBytes(bytes)

const blobExists = (hash: string) =>
  Database.use((db) => db.select({ hash: BlobTable.hash }).from(BlobTable).where(eq(BlobTable.hash, hash)).get()) !==
  undefined

describe("session media blobs", () => {
  test("stores tool media once as a media ref and reads it back inline", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        SessionBlob.configure(root, true)
        const session = await Session.create({})
        const bytes = png()
        const first = await message(session.id)
        const a = await screenshot(session.id, first, bytes)
        const second = await message(session.id)
        await screenshot(session.id, second, bytes)

        expect(attachment(stored(a) as MessageV2.Part)).toBe(`media:${hashOf(bytes)}`)
        expect(
          Database.use((db) =>
            db
              .select()
              .from(BlobRefTable)
              .where(eq(BlobRefTable.hash, hashOf(bytes)))
              .all(),
          ),
        ).toHaveLength(2)

        const page = await MessageV2.page({ sessionID: session.id, limit: 10 })
        expect(page.items.map((item) => attachment(item.parts[0]))).toEqual([dataUrl(bytes), dataUrl(bytes)])

        const refs = await MessageV2.page({ sessionID: session.id, limit: 10, refs: true })
        expect(attachment(refs.items[0].parts[0])).toBe(`media:${hashOf(bytes)}`)
        expect(Database.use((db) => SessionBlob.read(db, hashOf(bytes)))?.mime).toBe("image/png")

        await Session.remove(session.id)
      },
    })
  })

  test("keeps media inline while the flag is off", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const bytes = png()
        const id = await screenshot(session.id, await message(session.id), bytes)

        expect(attachment(stored(id) as MessageV2.Part)).toBe(dataUrl(bytes))
        expect(blobExists(hashOf(bytes))).toBe(false)

        await Session.remove(session.id)
      },
    })
  })

  test("releases a blob when the last message that names it goes away", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        SessionBlob.configure(root, true)
        const session = await Session.create({})
        const bytes = png()
        const first = await message(session.id)
        await screenshot(session.id, first, bytes)
        const second = await message(session.id)
        const part = await screenshot(session.id, second, bytes)

        await Session.removeMessage({ sessionID: session.id, messageID: first })
        expect(blobExists(hashOf(bytes))).toBe(true)

        await Session.removePart({ sessionID: session.id, messageID: second, partID: part })
        expect(blobExists(hashOf(bytes))).toBe(false)

        await Session.remove(session.id)
      },
    })
  })

  test("releases every blob of a deleted session", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        SessionBlob.configure(root, true)
        const session = await Session.create({})
        const bytes = png()
        await screenshot(session.id, await message(session.id), bytes)

        await Session.remove(session.id)
        expect(blobExists(hashOf(bytes))).toBe(false)
      },
    })
  })

  test("drops the blob of a part update that lands after its message is gone", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        SessionBlob.configure(root, true)
        const session = await Session.create({})
        const bytes = png()
        await screenshot(session.id, MessageID.ascending(), bytes)

        expect(blobExists(hashOf(bytes))).toBe(false)

        await Session.remove(session.id)
      },
    })
  })

  test("reads a ref whose blob is gone as an unavailable placeholder", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        SessionBlob.configure(root, true)
        const session = await Session.create({})
        const bytes = png()
        await screenshot(session.id, await message(session.id), bytes)
        Database.use((db) =>
          db
            .delete(BlobTable)
            .where(eq(BlobTable.hash, hashOf(bytes)))
            .run(),
        )

        const page = await MessageV2.page({ sessionID: session.id, limit: 10 })
        const url = attachment(page.items[0].parts[0])!
        expect(url.startsWith("data:text/plain;base64,")).toBe(true)
        expect(Buffer.from(url.split(",")[1], "base64").toString()).toBe("[media unavailable: image/png]")

        await Session.remove(session.id)
      },
    })
  })
})
