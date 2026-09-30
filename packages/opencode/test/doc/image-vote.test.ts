import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { Session } from "../../src/session"
import { Doc } from "../../src/doc"
import { Project } from "../../src/project/project"
import { Server } from "../../src/server/server"
import { ImageRequest } from "../../src/image-request"
import { tmpdir } from "../fixture/fixture"

afterEach(() => {
  mock.restore()
})

async function team(
  fn: (input: { sessionID: Session.Info["id"]; docID: string; ids: string[] }) => Promise<void>,
  size = 2,
) {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    init: InstanceBootstrap,
    fn: async () => {
      await Project.fromDirectory(tmp.path)
      const session = await Session.create({})
      const { docID } = Doc.prompt(session.id)
      const actors = ["Alice", "Bob", "Carol"]
        .slice(0, size)
        .map((name) => Doc.actorUpsert({ sessionID: session.id, name }))
      const stops = actors.map((actor) =>
        Doc.submitConnect({ sessionID: session.id, docID, actorID: actor.actorID, peer: { send: () => {} } }),
      )
      try {
        await fn({ sessionID: session.id, docID, ids: actors.map((a) => a.actorID) })
      } finally {
        stops.forEach((stop) => stop())
      }
    },
  })
}

const create = (sessionID: Session.Info["id"], docID: string, actorID: string, action: "approve" | "skip") =>
  Doc.imageSubmitCreate({
    sessionID,
    docID: docID as never,
    actorID: actorID as never,
    payload: { requestID: "img_vote_1", action, prompt: "주황 고양이" },
  })

describe("image consent vote", () => {
  test("approves the image request only after everyone agrees", async () => {
    const approve = spyOn(ImageRequest, "approve").mockImplementation(() => Promise.resolve())
    await team(async ({ sessionID, docID, ids }) => {
      const state = create(sessionID, docID, ids[0], "approve")
      expect(state).toMatchObject({
        status: "pending",
        targetKind: "image",
        imageAction: "approve",
        imagePrompt: "주황 고양이",
      })
      expect(approve).not.toHaveBeenCalled()

      const sent = Doc.submitRespond({
        sessionID,
        submitID: state.submitID,
        actorID: ids[1] as never,
        action: "approve",
      })
      expect(sent.status).toBe("sent")
      expect(approve).toHaveBeenCalledWith({ requestID: "img_vote_1", prompt: "주황 고양이" })
    })
  })

  test("one decline cancels the vote without touching the request", async () => {
    const approve = spyOn(ImageRequest, "approve").mockImplementation(() => Promise.resolve())
    const skip = spyOn(ImageRequest, "skip").mockImplementation(() => Promise.resolve())
    await team(async ({ sessionID, docID, ids }) => {
      const state = create(sessionID, docID, ids[0], "approve")
      const cancelled = Doc.submitRespond({
        sessionID,
        submitID: state.submitID,
        actorID: ids[2] as never,
        action: "cancel",
      })
      expect(cancelled.status).toBe("cancelled")
      expect(approve).not.toHaveBeenCalled()
      expect(skip).not.toHaveBeenCalled()
    }, 3)
  })

  test("skipping also needs everyone", async () => {
    const skip = spyOn(ImageRequest, "skip").mockImplementation(() => Promise.resolve())
    await team(async ({ sessionID, docID, ids }) => {
      const state = create(sessionID, docID, ids[0], "skip")
      expect(state.imageAction).toBe("skip")
      expect(skip).not.toHaveBeenCalled()
      Doc.submitRespond({ sessionID, submitID: state.submitID, actorID: ids[1] as never, action: "approve" })
      expect(skip).toHaveBeenCalledWith("img_vote_1")
    })
  })

  test("a team of one passes immediately", async () => {
    const approve = spyOn(ImageRequest, "approve").mockImplementation(() => Promise.resolve())
    await team(async ({ sessionID, docID, ids }) => {
      const state = create(sessionID, docID, ids[0], "approve")
      expect(state.status).toBe("sent")
      expect(approve).toHaveBeenCalledTimes(1)
    }, 1)
  })

  test("the image vote route is mounted", async () => {
    spyOn(ImageRequest, "approve").mockImplementation(() => Promise.resolve())
    await team(async ({ sessionID, docID, ids }) => {
      const res = await Server.Default().request(
        `/session/${sessionID}/prompt-doc/image?directory=${encodeURIComponent(Instance.directory)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ docID, actorID: ids[0], payload: { requestID: "img_vote_1", action: "approve" } }),
        },
      )
      expect(res.status).toBe(200)
      expect(((await res.json()) as Doc.SubmitState).targetKind).toBe("image")
    })
  })
})
