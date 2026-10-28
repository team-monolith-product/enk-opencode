import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import path from "path"
import { rm } from "fs/promises"
import { Bus } from "../../src/bus"
import { Doc } from "../../src/doc"
import { History } from "../../src/enk/history"
import { HistorySync } from "../../src/enk/history-sync"
import { WorkspaceRepo } from "../../src/enk/workspace-repo"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { Instance } from "../../src/project/instance"
import { Project } from "../../src/project/project"
import { Session } from "../../src/session"
import { SessionStatus } from "../../src/session/status"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const read = (dir: string) => Bun.file(path.join(dir, "index.html")).text()

async function until(fn: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return
    await Bun.sleep(20)
  }
  throw new Error("timed out")
}

async function team(dir: string) {
  await Project.fromDirectory(dir)
  const session = await Session.create({})
  await Bun.write(path.join(dir, "index.html"), "v1")
  const first = await History.commit(dir, { message: "처음" })
  await Bun.write(path.join(dir, "index.html"), "v2")
  await History.commit(dir, { message: "두번째" })
  const { docID } = Doc.prompt(session.id)
  const alice = Doc.actorUpsert({ sessionID: session.id, name: "Alice" })
  return { session, docID, alice, first: first! }
}

describe("rollback consent vote", () => {
  test("a solo vote rolls back right away and tells everyone", async () => {
    await using tmp = await tmpdir({ config: { ensureSession: true, ensureOneSession: true } })
    await Instance.provide({
      directory: tmp.path,
      init: InstanceBootstrap,
      fn: async () => {
        const { session, docID, alice, first } = await team(tmp.path)
        const events: unknown[] = []
        const unsub = Bus.subscribe(HistorySync.Event.Restored, (event) => void events.push(event.properties))

        const state = Doc.rollbackSubmitCreate({
          sessionID: session.id,
          docID,
          actorID: alice.actorID,
          sha: first.sha,
          target: { subject: "처음", time: 0 },
        })

        expect(state.status).toBe("sent")
        await until(async () => (await read(tmp.path)) === "v1")
        await until(async () => events.length > 0)
        expect(events[0]).toMatchObject({
          sessionID: session.id,
          target: first.sha,
          subject: "처음",
          files: 1,
          deps: false,
        })
        expect((await History.list(tmp.path))[0]).toMatchObject({ subject: "되돌리기: 처음", revert: first.sha })
        unsub()
      },
    })
  })

  test("rolling back to what the files already are tells everyone nothing changed", async () => {
    await using tmp = await tmpdir({ config: { ensureSession: true, ensureOneSession: true } })
    await Instance.provide({
      directory: tmp.path,
      init: InstanceBootstrap,
      fn: async () => {
        const { session, docID, alice } = await team(tmp.path)
        const latest = (await History.list(tmp.path))[0]!
        const restored: unknown[] = []
        const failed: unknown[] = []
        const subs = [
          Bus.subscribe(HistorySync.Event.Restored, (event) => void restored.push(event.properties)),
          Bus.subscribe(HistorySync.Event.Failed, (event) => void failed.push(event.properties)),
        ]

        Doc.rollbackSubmitCreate({
          sessionID: session.id,
          docID,
          actorID: alice.actorID,
          sha: latest.sha,
          target: { subject: latest.subject, time: latest.time },
        })

        await until(async () => failed.length > 0)
        expect(failed[0]).toEqual({ sessionID: session.id, code: "same" })
        expect(restored).toEqual([])
        expect((await History.list(tmp.path)).length).toBe(2)
        subs.forEach((unsub) => unsub())
      },
    })
  })

  test("a rollback the rest agreed on still runs when the leaver's grace ends outside any request", async () => {
    await using tmp = await tmpdir({ config: { ensureSession: true, ensureOneSession: true } })
    const failed: unknown[] = []
    let drop!: () => void
    await Instance.provide({
      directory: tmp.path,
      init: InstanceBootstrap,
      fn: async () => {
        const { session, docID, alice, first } = await team(tmp.path)
        const bob = Doc.actorUpsert({ sessionID: session.id, name: "Bob" })
        Doc.submitConnect({ sessionID: session.id, docID, actorID: alice.actorID, peer: { send: () => {} } })
        const close = Doc.submitConnect({
          sessionID: session.id,
          docID,
          actorID: bob.actorID,
          peer: { send: () => {} },
        })
        Bus.subscribe(HistorySync.Event.Failed, (event) => void failed.push(event.properties))

        const state = Doc.rollbackSubmitCreate({
          sessionID: session.id,
          docID,
          actorID: alice.actorID,
          sha: first.sha,
          target: { subject: "처음", time: 0 },
        })
        expect(state.status).toBe("pending")
        drop = close
      },
    })

    try {
      drop()
      setSystemTime(Date.now() + 10_100)
      Doc.leaveSweep()
      await until(async () => (await read(tmp.path)) === "v1")
      expect(failed).toEqual([])
    } finally {
      setSystemTime()
    }
  })

  test("rolling back to a rollback does not stack the title prefix", async () => {
    await using tmp = await tmpdir({ config: { ensureSession: true, ensureOneSession: true } })
    await Instance.provide({
      directory: tmp.path,
      init: InstanceBootstrap,
      fn: async () => {
        const { session, docID, alice, first } = await team(tmp.path)
        const rollTo = (sha: string, subject: string) =>
          Doc.rollbackSubmitCreate({
            sessionID: session.id,
            docID,
            actorID: alice.actorID,
            sha,
            target: { subject, time: 0 },
          })

        rollTo(first.sha, "처음")
        await until(async () => (await History.list(tmp.path))[0]?.subject === "되돌리기: 처음")
        const rolled = (await History.list(tmp.path))[0]!
        await Bun.write(path.join(tmp.path, "index.html"), "v3")
        await History.commit(tmp.path, { message: "세번째", turn: "msg_9" })

        rollTo(rolled.sha, rolled.subject)
        await until(async () => (await History.list(tmp.path))[0]?.revert === rolled.sha)

        expect((await History.list(tmp.path))[0]!.subject).toBe("되돌리기: 처음")
      },
    })
  })

  test("waits until everyone agrees", async () => {
    await using tmp = await tmpdir({ config: { ensureSession: true, ensureOneSession: true } })
    await Instance.provide({
      directory: tmp.path,
      init: InstanceBootstrap,
      fn: async () => {
        const { session, docID, alice, first } = await team(tmp.path)
        const bob = Doc.actorUpsert({ sessionID: session.id, name: "Bob" })
        const close = Doc.submitConnect({
          sessionID: session.id,
          docID,
          actorID: bob.actorID,
          peer: { send: () => {} },
        })

        const state = Doc.rollbackSubmitCreate({
          sessionID: session.id,
          docID,
          actorID: alice.actorID,
          sha: first.sha,
          target: { subject: "처음", time: 0 },
        })
        expect(state.status).toBe("pending")
        expect(state.rollback).toEqual({ sha: first.sha, subject: "처음", time: 0 })
        await Bun.sleep(50)
        expect(await read(tmp.path)).toBe("v2")

        Doc.submitRespond({ sessionID: session.id, submitID: state.submitID, actorID: bob.actorID, action: "approve" })
        await until(async () => (await read(tmp.path)) === "v1")
        close()
      },
    })
  })

  test("rollback and other votes cannot overlap", async () => {
    await using tmp = await tmpdir({ config: { ensureSession: true, ensureOneSession: true } })
    await Instance.provide({
      directory: tmp.path,
      init: InstanceBootstrap,
      fn: async () => {
        const { session, docID, alice, first } = await team(tmp.path)
        const bob = Doc.actorUpsert({ sessionID: session.id, name: "Bob" })
        const close = Doc.submitConnect({
          sessionID: session.id,
          docID,
          actorID: bob.actorID,
          peer: { send: () => {} },
        })

        const stop = Doc.stopSubmitCreate({ sessionID: session.id, docID, actorID: alice.actorID })
        expect(() =>
          Doc.rollbackSubmitCreate({
            sessionID: session.id,
            docID,
            actorID: alice.actorID,
            sha: first.sha,
            target: { subject: "처음", time: 0 },
          }),
        ).toThrow()
        Doc.submitRespond({ sessionID: session.id, submitID: stop.submitID, actorID: bob.actorID, action: "cancel" })

        const rollback = Doc.rollbackSubmitCreate({
          sessionID: session.id,
          docID,
          actorID: alice.actorID,
          sha: first.sha,
          target: { subject: "처음", time: 0 },
        })
        expect(rollback.status).toBe("pending")
        expect(() => Doc.stopSubmitCreate({ sessionID: session.id, docID, actorID: alice.actorID })).toThrow()
        const latest = (await History.list(tmp.path))[0]!
        expect(() =>
          Doc.rollbackSubmitCreate({
            sessionID: session.id,
            docID,
            actorID: bob.actorID,
            sha: latest.sha,
            target: { subject: latest.subject, time: latest.time },
          }),
        ).toThrow(Doc.VoteConflictError)
        close()
      },
    })
  })

  test("holds the session busy while rolling back, like a shell command", async () => {
    await using tmp = await tmpdir({ config: { ensureSession: true, ensureOneSession: true } })
    await Instance.provide({
      directory: tmp.path,
      init: InstanceBootstrap,
      fn: async () => {
        const { session, docID, alice, first } = await team(tmp.path)
        const seen: string[] = []
        const unsub = Bus.subscribe(SessionStatus.Event.Status, (event) => {
          if (event.properties.sessionID === session.id) seen.push(event.properties.status.type)
        })

        Doc.rollbackSubmitCreate({
          sessionID: session.id,
          docID,
          actorID: alice.actorID,
          sha: first.sha,
          target: { subject: "처음", time: 0 },
        })

        await until(async () => seen.includes("idle"))
        expect(seen).toEqual(["busy", "idle"])
        expect(await read(tmp.path)).toBe("v1")
        unsub()
      },
    })
  })

  test("tells everyone when the agreed rollback can no longer run", async () => {
    await using tmp = await tmpdir({ config: { ensureSession: true, ensureOneSession: true } })
    await Instance.provide({
      directory: tmp.path,
      init: InstanceBootstrap,
      fn: async () => {
        const { session, docID, alice, first } = await team(tmp.path)
        const bob = Doc.actorUpsert({ sessionID: session.id, name: "Bob" })
        const close = Doc.submitConnect({
          sessionID: session.id,
          docID,
          actorID: bob.actorID,
          peer: { send: () => {} },
        })
        const failed: unknown[] = []
        const unsub = Bus.subscribe(HistorySync.Event.Failed, (event) => void failed.push(event.properties))

        const state = Doc.rollbackSubmitCreate({
          sessionID: session.id,
          docID,
          actorID: alice.actorID,
          sha: first.sha,
          target: { subject: "처음", time: 0 },
        })
        await rm(WorkspaceRepo.open(tmp.path).root, { recursive: true, force: true })
        Doc.submitRespond({ sessionID: session.id, submitID: state.submitID, actorID: bob.actorID, action: "approve" })

        await until(async () => failed.length > 0)
        expect(failed).toEqual([{ sessionID: session.id, code: "missing" }])
        expect(await read(tmp.path)).toBe("v2")
        unsub()
        close()
      },
    })
  })
})

describe("HistorySync.check", () => {
  test("refuses a version that is not in the history", async () => {
    await using tmp = await tmpdir({ config: { ensureSession: true, ensureOneSession: true } })
    await Instance.provide({
      directory: tmp.path,
      init: InstanceBootstrap,
      fn: async () => {
        const { session } = await team(tmp.path)

        await expect(HistorySync.check({ sessionID: session.id, sha: "0".repeat(40) })).rejects.toMatchObject({
          code: "missing",
        })
      },
    })
  })
})
