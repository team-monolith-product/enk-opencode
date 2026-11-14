import { afterEach, describe, expect, mock, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { Session } from "../../src/session"
import { Doc } from "../../src/doc"
import { Project } from "../../src/project/project"
import { tmpdir } from "../fixture/fixture"

const prompt = {
  noReply: true,
  parts: [{ type: "text" as const, text: "hi" }],
}

function collect() {
  const events: Doc.SubmitEvent[] = []
  return { events, peer: { send: (data: string) => void events.push(JSON.parse(data)) } }
}

describe("team-wide consent votes", () => {
  afterEach(() => mock.restore())

  test("a send vote in one session targets teammates connected to another session", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: InstanceBootstrap,
      fn: async () => {
        await Project.fromDirectory(tmp.path)
        const first = await Session.create({})
        const second = await Session.create({})
        const firstDoc = Doc.prompt(first.id).docID
        const secondDoc = Doc.prompt(second.id).docID
        const alice = Doc.actorUpsert({ sessionID: first.id, name: "Alice" })
        const bob = Doc.actorUpsert({ sessionID: second.id, name: "Bob" })

        const bobSocket = collect()
        const stop = Doc.submitConnect({ sessionID: second.id, docID: secondDoc, actorID: bob.actorID, peer: bobSocket.peer })

        const state = Doc.submitCreate({ sessionID: first.id, docID: firstDoc, actorID: alice.actorID, prompt })

        expect(state.status).toBe("pending")
        expect(state.actors.map((actor) => actor.actorID).sort()).toEqual([alice.actorID, bob.actorID].sort())
        expect(state.actors.find((actor) => actor.actorID === bob.actorID)?.name).toBe("Bob")
        expect(bobSocket.events.some((event) => event.type === "created" && event.state.sessionID === first.id)).toBe(
          true,
        )

        const next = Doc.submitRespond({
          sessionID: first.id,
          submitID: state.submitID,
          actorID: bob.actorID,
          action: "cancel",
        })
        expect(next.status).toBe("cancelled")
        stop()
      },
    })
  })

  test("a teammate who connects to another session joins a pending vote", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: InstanceBootstrap,
      fn: async () => {
        await Project.fromDirectory(tmp.path)
        const first = await Session.create({})
        const second = await Session.create({})
        const firstDoc = Doc.prompt(first.id).docID
        const secondDoc = Doc.prompt(second.id).docID
        const alice = Doc.actorUpsert({ sessionID: first.id, name: "Alice" })
        const bob = Doc.actorUpsert({ sessionID: second.id, name: "Bob" })
        const carol = Doc.actorUpsert({ sessionID: first.id, name: "Carol" })

        const stopCarol = Doc.submitConnect({
          sessionID: first.id,
          docID: firstDoc,
          actorID: carol.actorID,
          peer: { send: () => undefined },
        })
        const state = Doc.submitCreate({ sessionID: first.id, docID: firstDoc, actorID: alice.actorID, prompt })
        expect(state.status).toBe("pending")

        const bobSocket = collect()
        const stopBob = Doc.submitConnect({
          sessionID: second.id,
          docID: secondDoc,
          actorID: bob.actorID,
          peer: bobSocket.peer,
        })
        const replay = bobSocket.events.find((event) => event.type === "created")
        expect(replay?.state.submitID).toBe(state.submitID)
        expect(replay?.state.actors.map((actor) => actor.actorID)).toContain(bob.actorID)

        stopBob()
        stopCarol()
      },
    })
  })

  test("only one team vote runs at a time across sessions", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: InstanceBootstrap,
      fn: async () => {
        await Project.fromDirectory(tmp.path)
        const first = await Session.create({})
        const second = await Session.create({})
        const firstDoc = Doc.prompt(first.id).docID
        const secondDoc = Doc.prompt(second.id).docID
        const alice = Doc.actorUpsert({ sessionID: first.id, name: "Alice" })
        const bob = Doc.actorUpsert({ sessionID: second.id, name: "Bob" })

        const stop = Doc.submitConnect({
          sessionID: second.id,
          docID: secondDoc,
          actorID: bob.actorID,
          peer: { send: () => undefined },
        })
        const pending = Doc.submitCreate({ sessionID: first.id, docID: firstDoc, actorID: alice.actorID, prompt })
        expect(pending.status).toBe("pending")

        expect(() =>
          Doc.submitCreate({ sessionID: second.id, docID: secondDoc, actorID: bob.actorID, prompt }),
        ).toThrow(Doc.VoteConflictError)
        stop()
      },
    })
  })

  test("votes in another project directory are not shared", async () => {
    await using one = await tmpdir()
    await using two = await tmpdir()
    const first = await Instance.provide({
      directory: one.path,
      init: InstanceBootstrap,
      fn: async () => {
        await Project.fromDirectory(one.path)
        const session = await Session.create({})
        const alice = Doc.actorUpsert({ sessionID: session.id, name: "Alice" })
        return { session, docID: Doc.prompt(session.id).docID, alice }
      },
    })
    await Instance.provide({
      directory: two.path,
      init: InstanceBootstrap,
      fn: async () => {
        await Project.fromDirectory(two.path)
        const session = await Session.create({})
        const bob = Doc.actorUpsert({ sessionID: session.id, name: "Bob" })
        const stop = Doc.submitConnect({
          sessionID: session.id,
          docID: Doc.prompt(session.id).docID,
          actorID: bob.actorID,
          peer: { send: () => undefined },
        })
        await Instance.provide({
          directory: one.path,
          fn: async () => {
            const state = Doc.submitCreate({
              sessionID: first.session.id,
              docID: first.docID,
              actorID: first.alice.actorID,
              prompt,
            })
            expect(state.status).toBe("sent")
          },
        })
        stop()
      },
    })
  })
})
