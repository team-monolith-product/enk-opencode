import { afterEach, describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { PlanDoc } from "../../src/enk/plan-doc"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

async function fill(sessionID: SessionID, count: number) {
  for (let i = 0; i < count; i++) {
    const id = MessageID.ascending()
    await Session.updateMessage({
      id,
      sessionID,
      role: "user",
      time: { created: Date.now() + i },
      agent: "test",
      model: { providerID: "test", modelID: "test" },
      tools: {},
      mode: "",
    } as unknown as MessageV2.Info)
    await Session.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text: `m${i}`,
    })
  }
}

function generate(body: unknown) {
  return Server.Default().request("/plan-doc/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("planDoc.generate endpoint", () => {
  test("returns 404 for an unknown session id", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await generate({ sessionID: "ses_nonexistent123" })
        expect(response.status).toBe(404)
      },
    })
  })

  test("returns 400 for a malformed session id", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await generate({ sessionID: "not-a-session" })
        expect(response.status).toBe(400)
      },
    })
  })

  test("returns a 200 skeleton for a session with no material", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const response = await generate({ sessionID: session.id })
        expect(response.status).toBe(200)

        const body = (await response.json()) as PlanDoc.Result
        expect(body.sparse).toBe(true)
        expect(body.manualSlots).toEqual([...PlanDoc.BLOCKS])
        expect(body.body).toContain("[[빈칸: 풀고 싶은 문제]]")
        expect(body.caveats.length).toBe(1)
        expect(body.title).toBe("")

        await Session.remove(session.id)
      },
    })
  })

  test("returns a 200 skeleton when no session exists at all", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await generate({})
        expect(response.status).toBe(200)

        const body = (await response.json()) as PlanDoc.Result
        expect(body.sparse).toBe(true)
        expect(body.manualSlots).toEqual([...PlanDoc.BLOCKS])
      },
    })
  })

  test("counts user messages per session in sql", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const quiet = await Session.create({})
        const busy = await Session.create({})
        await fill(quiet.id, 1)
        await fill(busy.id, 3)

        const counts = Session.userMessageCounts([quiet.id, busy.id])
        expect(counts.get(quiet.id)).toBe(1)
        expect(counts.get(busy.id)).toBe(3)
        expect(Session.userMessageCounts([]).size).toBe(0)

        expect(
          PlanDoc.selectPrimary(
            [quiet, busy].map((s) => ({ id: s.id, userCount: counts.get(s.id) ?? 0, updated: s.time.updated })),
          ),
        ).toBe(busy.id)

        await Session.remove(quiet.id)
        await Session.remove(busy.id)
      },
    })
  })
})
