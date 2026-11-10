import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { SessionSummary } from "../../src/session/summary"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

async function turn(sessionID: SessionID, root: string) {
  const user = await Session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: { providerID: "test", modelID: "test" },
    time: { created: Date.now() },
  } as MessageV2.User)
  await Session.updatePart({ id: PartID.ascending(), messageID: user.id, sessionID, type: "text", text: "hello" })
  const assistant = await Session.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    parentID: user.id,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "test",
    providerID: "test",
    time: { created: Date.now() },
  } as MessageV2.Assistant)
  await Session.updatePart({ id: PartID.ascending(), messageID: assistant.id, sessionID, type: "step-start" })
  return user
}

function diffs(sessionID: SessionID) {
  const seen: unknown[] = []
  const unsubscribe = Bus.subscribe(Session.Event.Diff, (evt) => {
    if (evt.properties.sessionID === sessionID) seen.push(evt.properties.diff)
  })
  return { seen, unsubscribe }
}

describe("SessionSummary.summarize", () => {
  test("snapshot 이 꺼져 있으면 세션을 읽지 않고 빈 요약만 남긴다", async () => {
    await using tmp = await tmpdir({ git: true, config: { snapshot: false } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const user = await turn(session.id, tmp.path)
        const events = diffs(session.id)
        const read = spyOn(Session, "messages")

        await SessionSummary.summarize({ sessionID: session.id, messageID: user.id })

        expect(read).not.toHaveBeenCalled()
        read.mockRestore()
        events.unsubscribe()
        expect(events.seen).toEqual([[]])
        expect((await Session.get(session.id)).summary).toMatchObject({ additions: 0, deletions: 0, files: 0 })
        const stored = (await Session.messages({ sessionID: session.id })).find((m) => m.info.id === user.id)
        expect(stored?.info.role === "user" && stored.info.summary).toBeFalsy()
      },
    })
  })

  test("snapshot 이 켜져 있으면 턴 diff 는 여전히 질문 메시지에 남긴다", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const user = await turn(session.id, tmp.path)
        const events = diffs(session.id)

        await SessionSummary.summarize({ sessionID: session.id, messageID: user.id })

        events.unsubscribe()
        expect(events.seen).toEqual([[]])
        expect((await Session.get(session.id)).summary).toMatchObject({ additions: 0, deletions: 0, files: 0 })
        const stored = (await Session.messages({ sessionID: session.id })).find((m) => m.info.id === user.id)
        expect(stored?.info.role === "user" && stored.info.summary?.diffs).toEqual([])
      },
    })
  })
})

describe("SessionSummary.diff", () => {
  test("세션 전체 diff 는 비어 있고, 턴 diff 는 질문 메시지에 저장된 값을 돌려준다", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const user = await turn(session.id, tmp.path)
        const info = (await Session.messages({ sessionID: session.id })).find((m) => m.info.id === user.id)!
          .info as MessageV2.User
        await Session.updateMessage({
          ...info,
          summary: { diffs: [{ file: '"dir/\\303\\251.txt"', additions: 1, deletions: 0 }] },
        })

        expect(await SessionSummary.diff({ sessionID: session.id })).toEqual([])
        expect(await SessionSummary.diff({ sessionID: session.id, messageID: user.id })).toEqual([
          { file: "dir/é.txt", additions: 1, deletions: 0 },
        ])
      },
    })
  })
})
