import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Doc } from "../../src/doc"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { Instance } from "../../src/project/instance"
import { Project } from "../../src/project/project"
import { Session } from "../../src/session"
import { archiveSession, removeSession } from "../../src/session/archive"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  mock.restore()
  await Instance.disposeAll()
})

describe("archiveSession", () => {
  // 지운 세션은 아무도 다시 열 수 없다. 응답이 계속 돌면 보이지 않는 대화에서 요금만 나간다.
  test("cancels the in-flight response before archiving", async () => {
    await using tmp = await tmpdir({ config: { ensureSession: true, ensureOneSession: true } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const cancel = spyOn(SessionPrompt, "cancel").mockResolvedValue()

        expect(await archiveSession({ sessionID: session.id })).toBe(true)

        expect(cancel).toHaveBeenCalledWith(session.id)
        expect((await Session.get(session.id)).time.archived).toBeNumber()
      },
    })
  })

  test("does nothing when the session is already archived", async () => {
    await using tmp = await tmpdir({ config: { ensureSession: true, ensureOneSession: true } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await archiveSession({ sessionID: session.id, time: 1000 })

        const cancel = spyOn(SessionPrompt, "cancel").mockResolvedValue()
        expect(await archiveSession({ sessionID: session.id, time: 2000 })).toBe(false)

        expect(cancel).not.toHaveBeenCalled()
        expect((await Session.get(session.id)).time.archived).toBe(1000)
      },
    })
  })

  test("removeSession cancels the run too", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const cancel = spyOn(SessionPrompt, "cancel").mockResolvedValue()

        await removeSession(session.id)

        expect(cancel).toHaveBeenCalledWith(session.id)
      },
    })
  })

  // 동의 투표가 늦게 통과했거나 끊겼던 참가자가 재시도하면, 이미 지워진 세션으로 전송이 들어온다.
  test("prompting an archived session is rejected", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await archiveSession({ sessionID: session.id })

        const run = SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "늦게 도착한 전송" }],
        })

        await expect(run).rejects.toBeInstanceOf(Session.ArchivedError)
      },
    })
  })
})

describe("clear consent vote", () => {
  test("a solo clear vote archives the session right away", async () => {
    await using tmp = await tmpdir({ config: { ensureSession: true, ensureOneSession: true } })
    await Instance.provide({
      directory: tmp.path,
      init: InstanceBootstrap,
      fn: async () => {
        await Project.fromDirectory(tmp.path)
        const session = await Session.create({})
        const { docID } = Doc.prompt(session.id)
        const alice = Doc.actorUpsert({ sessionID: session.id, name: "Alice" })

        const state = Doc.clearSubmitCreate({ sessionID: session.id, docID, actorID: alice.actorID })

        expect(state.status).toBe("sent")
        await Bun.sleep(50)
        expect((await Session.get(session.id)).time.archived).toBeNumber()
      },
    })
  })

  test("everyone agreeing clears the session", async () => {
    await using tmp = await tmpdir({ config: { ensureSession: true, ensureOneSession: true } })
    await Instance.provide({
      directory: tmp.path,
      init: InstanceBootstrap,
      fn: async () => {
        await Project.fromDirectory(tmp.path)
        const session = await Session.create({})
        const { docID } = Doc.prompt(session.id)
        const alice = Doc.actorUpsert({ sessionID: session.id, name: "Alice" })
        const bob = Doc.actorUpsert({ sessionID: session.id, name: "Bob" })
        const close = Doc.submitConnect({
          sessionID: session.id,
          docID,
          actorID: bob.actorID,
          peer: { send: () => {} },
        })

        const state = Doc.clearSubmitCreate({ sessionID: session.id, docID, actorID: alice.actorID })
        expect(state.status).toBe("pending")
        expect((await Session.get(session.id)).time.archived).toBeUndefined()

        const after = Doc.submitRespond({
          sessionID: session.id,
          submitID: state.submitID,
          actorID: bob.actorID,
          action: "approve",
        })
        expect(after.status).toBe("sent")
        await Bun.sleep(50)
        expect((await Session.get(session.id)).time.archived).toBeNumber()
        close()
      },
    })
  })

  // 전송 투표가 도는 중에 세션이 사라지면 참가자들이 서로 다른 것에 동의한 셈이 된다.
  test("clear and other votes cannot overlap", async () => {
    await using tmp = await tmpdir({ config: { ensureSession: true, ensureOneSession: true } })
    await Instance.provide({
      directory: tmp.path,
      init: InstanceBootstrap,
      fn: async () => {
        await Project.fromDirectory(tmp.path)
        const session = await Session.create({})
        const { docID } = Doc.prompt(session.id)
        const alice = Doc.actorUpsert({ sessionID: session.id, name: "Alice" })
        const bob = Doc.actorUpsert({ sessionID: session.id, name: "Bob" })
        const close = Doc.submitConnect({
          sessionID: session.id,
          docID,
          actorID: bob.actorID,
          peer: { send: () => {} },
        })

        const stop = Doc.stopSubmitCreate({ sessionID: session.id, docID, actorID: alice.actorID })
        expect(stop.status).toBe("pending")
        expect(() => Doc.clearSubmitCreate({ sessionID: session.id, docID, actorID: alice.actorID })).toThrow()

        Doc.submitRespond({
          sessionID: session.id,
          submitID: stop.submitID,
          actorID: bob.actorID,
          action: "cancel",
        })

        const clear = Doc.clearSubmitCreate({ sessionID: session.id, docID, actorID: alice.actorID })
        expect(clear.status).toBe("pending")
        expect(() => Doc.stopSubmitCreate({ sessionID: session.id, docID, actorID: alice.actorID })).toThrow()
        close()
      },
    })
  })
})
