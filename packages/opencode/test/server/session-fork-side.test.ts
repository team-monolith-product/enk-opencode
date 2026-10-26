import { afterEach, describe, expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Log } from "../../src/util/log"
import { isSideSession } from "../../src/tool/handoff"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const model = { providerID: ProviderID.make("test"), modelID: ModelID.make("test") }

async function user(sessionID: SessionID, text: string) {
  const msg = await Session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model,
    time: { created: Date.now() },
  })
  await Session.updatePart({ id: PartID.ascending(), sessionID, messageID: msg.id, type: "text", text })
  return msg
}

async function assistant(sessionID: SessionID, parentID: MessageID, completed: boolean) {
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: model.modelID,
    providerID: model.providerID,
    parentID,
    time: completed ? { created: Date.now(), completed: Date.now() } : { created: Date.now() },
    ...(completed ? { finish: "end_turn" } : {}),
  }
  await Session.updateMessage(msg)
  await Session.updatePart({ id: PartID.ascending(), sessionID, messageID: msg.id, type: "text", text: "reply" })
  return msg
}

async function fork(sessionID: SessionID, body: Record<string, unknown>) {
  const res = await Server.Default().request(`/session/${sessionID}/fork`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as Session.Info
}

describe("POST /session/:id/fork side", () => {
  test("side fork is a hidden read-only child that skips the in-flight reply", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const main = await Session.create({})
        const first = await user(main.id, "first")
        await assistant(main.id, first.id, true)
        const second = await user(main.id, "second")
        // 메인이 아직 응답을 쓰는 중
        await assistant(main.id, second.id, false)

        const side = await fork(main.id, { side: true })

        expect(side.parentID).toBe(main.id)
        expect(side.permission).toEqual(Agent.sidePermission())
        const copied = await Session.messages({ sessionID: side.id })
        expect(copied.map((m) => m.info.role)).toEqual(["user", "assistant", "user"])
        expect(copied.every((m) => m.info.role !== "assistant" || m.info.time.completed !== undefined)).toBe(true)
      },
    })
  })

  // 메인이 슬래시 명령 서브태스크를 돌리는 중에 열면, 복사된 subtask 파트를 사이드의 첫 턴이 집어 쓰기 권한 있는
  // 하위 에이전트로 다시 실행한다. 맥락으로만 복사해야 한다.
  test("side fork drops executable task parts copied from the main turn", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const main = await Session.create({})
        const msg = await user(main.id, "/review")
        await Session.updatePart({
          id: PartID.ascending(),
          sessionID: main.id,
          messageID: msg.id,
          type: "subtask",
          prompt: "review the code",
          description: "review",
          agent: "general",
        })
        await assistant(main.id, msg.id, false)

        const side = await fork(main.id, { side: true })

        const copied = await Session.messages({ sessionID: side.id })
        expect(copied.flatMap((m) => m.parts.map((part) => part.type))).toEqual(["text"])
        expect(isSideSession(side)).toBe(true)
        expect(isSideSession(main)).toBe(false)
      },
    })
  })

  // 끝난 압축의 경계(compaction 파트)를 지우면 filterCompacted 가 옛 기록을 자르지 못해 사이드 첫 질문에
  // 압축 전 기록이 통째로 실린다. 끝난 경계는 남기고 꼬리 참조도 새 ID 로 옮겨야 한다.
  test("side fork keeps completed compaction boundaries", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const main = await Session.create({})
        const old = await user(main.id, "old turn")
        await assistant(main.id, old.id, true)
        const tail = await user(main.id, "kept tail")
        await assistant(main.id, tail.id, true)
        const compact = await user(main.id, "compact")
        await Session.updatePart({
          id: PartID.ascending(),
          sessionID: main.id,
          messageID: compact.id,
          type: "compaction",
          auto: true,
          tail_start_id: tail.id,
        })
        const summary = await assistant(main.id, compact.id, true)
        await Session.updateMessage({ ...summary, summary: true })
        const next = await user(main.id, "after compaction")
        await assistant(main.id, next.id, true)

        const side = await fork(main.id, { side: true })

        const effective = (id: SessionID) =>
          MessageV2.filterCompacted(MessageV2.stream(id)).then((list) =>
            list.map((msg) => msg.parts.find((part) => part.type === "text")?.text),
          )
        const [mainView, sideView] = await Promise.all([effective(main.id), effective(side.id)])
        expect(sideView).toEqual(mainView)
        expect(sideView).not.toContain("old turn")
      },
    })
  })

  test("session permission keeps the side chat read-only whatever agent runs it", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const main = await Session.create({})
        await user(main.id, "hello")
        const side = await fork(main.id, { side: true })
        const build = await Agent.get("build")
        // 세션 규칙은 에이전트 규칙 뒤에 적용된다(prompt.ts, llm.ts).
        const ruleset = Permission.merge(build.permission, side.permission ?? [])
        const disabled = Permission.disabled(["bash", "edit", "write", "task", "read", "grep", "handoff"], ruleset)
        expect([...disabled].sort()).toEqual(["bash", "edit", "task", "write"])
      },
    })
  })

  test("plain fork stays a root session and copies everything", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const main = await Session.create({})
        const msg = await user(main.id, "hello")
        await assistant(main.id, msg.id, false)

        const forked = await fork(main.id, {})

        expect(forked.parentID).toBeUndefined()
        expect(forked.permission).toBeUndefined()
        expect((await Session.messages({ sessionID: forked.id })).length).toBe(2)
      },
    })
  })
})
