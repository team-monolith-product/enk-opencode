import { afterEach, describe, expect, mock, test } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Instance } from "../../src/project/instance"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { Session } from "../../src/session"
import { Doc } from "../../src/doc"
import { DocSubmitActorTable } from "../../src/doc/doc.sql"
import { Database } from "../../src/storage/db"
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

function within(run: () => Promise<void>) {
  return async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: InstanceBootstrap,
      fn: async () => {
        await Project.fromDirectory(tmp.path)
        await run()
      },
    })
  }
}

const status = (state: Doc.SubmitState | undefined, actorID: string) =>
  state?.actors.find((actor) => actor.actorID === actorID)?.status

describe("auto-consent: dev E2E scenarios (team of two, 가·나)", () => {
  afterEach(() => mock.restore())

  test(
    "1. 가 is on auto-consent, so 나's send goes out at once with no dialog",
    within(async () => {
      const session = await Session.create({})
      const { docID } = Doc.prompt(session.id)
      const ga = Doc.actorUpsert({ sessionID: session.id, userID: "736", name: "E2E 가", autoConsent: true })
      const na = Doc.actorUpsert({ sessionID: session.id, userID: "737", name: "E2E 나" })
      const gaSocket = collect()
      const stops = [
        Doc.submitConnect({ sessionID: session.id, docID, actorID: ga.actorID, peer: gaSocket.peer }),
        Doc.submitConnect({ sessionID: session.id, docID, actorID: na.actorID, peer: { send: () => undefined } }),
      ]

      const state = Doc.submitCreate({ sessionID: session.id, docID, actorID: na.actorID, prompt })

      expect(state.status).toBe("sent")
      expect(state.actors.map((actor) => actor.status)).toEqual(["approved", "approved"])
      expect(gaSocket.events.some((event) => event.type === "created")).toBe(false)
      stops.forEach((stop) => stop())
    }),
  )

  test(
    "2. 가 on auto-consent sends, 나 gets the dialog, and 나 turning it on mid-vote sends it",
    within(async () => {
      const session = await Session.create({})
      const { docID } = Doc.prompt(session.id)
      const ga = Doc.actorUpsert({ sessionID: session.id, userID: "736", name: "E2E 가", autoConsent: true })
      const na = Doc.actorUpsert({ sessionID: session.id, userID: "737", name: "E2E 나" })
      const gaSocket = collect()
      const naSocket = collect()
      const stops = [
        Doc.submitConnect({ sessionID: session.id, docID, actorID: ga.actorID, peer: gaSocket.peer }),
        Doc.submitConnect({ sessionID: session.id, docID, actorID: na.actorID, peer: naSocket.peer }),
      ]

      const state = Doc.submitCreate({ sessionID: session.id, docID, actorID: ga.actorID, prompt })
      expect(state.status).toBe("pending")
      expect(status(state, ga.actorID)).toBe("approved")
      expect(status(state, na.actorID)).toBe("pending")
      expect(naSocket.events.some((event) => event.type === "created" && event.state.submitID === state.submitID)).toBe(
        true,
      )

      Doc.actorUpsert({ sessionID: session.id, actorID: na.actorID, autoConsent: true })

      for (const socket of [gaSocket, naSocket]) {
        expect(socket.events.some((event) => event.type === "sent" && event.state.submitID === state.submitID)).toBe(
          true,
        )
      }
      stops.forEach((stop) => stop())
    }),
  )

  test(
    "3. with both on auto-consent, reset and rollback still ask the other person",
    within(async () => {
      const session = await Session.create({})
      const { docID } = Doc.prompt(session.id)
      const ga = Doc.actorUpsert({ sessionID: session.id, userID: "736", name: "E2E 가", autoConsent: true })
      const na = Doc.actorUpsert({ sessionID: session.id, userID: "737", name: "E2E 나", autoConsent: true })
      const stops = [ga, na].map((actor) =>
        Doc.submitConnect({ sessionID: session.id, docID, actorID: actor.actorID, peer: { send: () => undefined } }),
      )

      const clear = Doc.clearSubmitCreate({ sessionID: session.id, docID, actorID: ga.actorID })
      expect(clear.status).toBe("pending")
      expect(status(clear, na.actorID)).toBe("pending")
      const rejected = Doc.submitRespond({
        sessionID: session.id,
        submitID: clear.submitID,
        actorID: na.actorID,
        action: "cancel",
      })
      expect(rejected.status).toBe("cancelled")

      const rollback = Doc.rollbackSubmitCreate({
        sessionID: session.id,
        docID,
        actorID: ga.actorID,
        sha: "a".repeat(40),
        target: { subject: "first version", time: Date.now() },
      })
      expect(rollback.status).toBe("pending")
      expect(status(rollback, na.actorID)).toBe("pending")
      Doc.submitRespond({ sessionID: session.id, submitID: rollback.submitID, actorID: na.actorID, action: "cancel" })
      stops.forEach((stop) => stop())
    }),
  )

  test(
    "4. a question vote counts the auto-consent teammate as agreed",
    within(async () => {
      const session = await Session.create({})
      const ga = Doc.actorUpsert({ sessionID: session.id, userID: "736", name: "E2E 가" })
      const na = Doc.actorUpsert({ sessionID: session.id, userID: "737", name: "E2E 나", autoConsent: true })
      const requestID = "question_auto_consent"
      const stops = [ga, na].map((actor) =>
        Doc.questionSubmitConnect({
          sessionID: session.id,
          requestID,
          actorID: actor.actorID,
          peer: { send: () => undefined },
        }),
      )

      const state = Doc.questionSubmitCreate({
        sessionID: session.id,
        requestID,
        actorID: ga.actorID,
        payload: { requestID, reject: true },
      })

      expect(state.status).toBe("sent")
      expect(status(state, na.actorID)).toBe("approved")
      stops.forEach((stop) => stop())
    }),
  )
})

describe("auto-consent: switching it off and other conversations", () => {
  afterEach(() => mock.restore())

  test(
    "switching it off takes back the approval it gave, so the person is asked again",
    within(async () => {
      const session = await Session.create({})
      const { docID } = Doc.prompt(session.id)
      const ga = Doc.actorUpsert({ sessionID: session.id, name: "E2E 가" })
      const na = Doc.actorUpsert({ sessionID: session.id, name: "E2E 나", autoConsent: true })
      const da = Doc.actorUpsert({ sessionID: session.id, name: "E2E 다" })
      const naSocket = collect()
      const stops = [
        Doc.submitConnect({ sessionID: session.id, docID, actorID: ga.actorID, peer: { send: () => undefined } }),
        Doc.submitConnect({ sessionID: session.id, docID, actorID: na.actorID, peer: naSocket.peer }),
        Doc.submitConnect({ sessionID: session.id, docID, actorID: da.actorID, peer: { send: () => undefined } }),
      ]

      const state = Doc.submitCreate({ sessionID: session.id, docID, actorID: ga.actorID, prompt })
      expect(status(state, na.actorID)).toBe("approved")

      Doc.actorUpsert({ sessionID: session.id, actorID: na.actorID, autoConsent: false })

      const after = Doc.submitActive({ sessionID: session.id, docID, actorID: ga.actorID })
      expect(after?.status).toBe("pending")
      expect(status(after, na.actorID)).toBe("pending")
      expect(status(after, ga.actorID)).toBe("approved")
      const last = naSocket.events.at(-1)
      expect(last?.type).toBe("updated")
      expect(status(last?.state, na.actorID)).toBe("pending")

      Doc.submitRespond({ sessionID: session.id, submitID: state.submitID, actorID: da.actorID, action: "approve" })
      expect(Doc.submitActive({ sessionID: session.id, docID, actorID: ga.actorID })?.status).toBe("pending")
      stops.forEach((stop) => stop())
    }),
  )

  test(
    "switching it off never takes back the requester's own approval",
    within(async () => {
      const session = await Session.create({})
      const { docID } = Doc.prompt(session.id)
      const ga = Doc.actorUpsert({ sessionID: session.id, name: "E2E 가", autoConsent: true })
      const na = Doc.actorUpsert({ sessionID: session.id, name: "E2E 나" })
      const stops = [ga, na].map((actor) =>
        Doc.submitConnect({ sessionID: session.id, docID, actorID: actor.actorID, peer: { send: () => undefined } }),
      )

      const state = Doc.submitCreate({ sessionID: session.id, docID, actorID: ga.actorID, prompt })
      Doc.actorUpsert({ sessionID: session.id, actorID: ga.actorID, autoConsent: false })

      const after = Doc.submitActive({ sessionID: session.id, docID, actorID: ga.actorID })
      expect(after?.submitID).toBe(state.submitID)
      expect(status(after, ga.actorID)).toBe("approved")
      stops.forEach((stop) => stop())
    }),
  )

  test(
    "the switch reaches the same person's actor in the team's other conversation",
    within(async () => {
      const first = await Session.create({})
      const second = await Session.create({})
      const secondDoc = Doc.prompt(second.id).docID
      Doc.prompt(first.id)
      const ga = Doc.actorUpsert({ sessionID: second.id, userID: "736", name: "E2E 가" })
      const naFirst = Doc.actorUpsert({ sessionID: first.id, userID: "737", name: "E2E 나" })
      const naSecond = Doc.actorUpsert({ sessionID: second.id, userID: "737", name: "E2E 나" })
      expect(naSecond.actorID).not.toBe(naFirst.actorID)
      const gaSocket = collect()
      const stops = [
        Doc.submitConnect({ sessionID: second.id, docID: secondDoc, actorID: ga.actorID, peer: gaSocket.peer }),
        Doc.submitConnect({
          sessionID: second.id,
          docID: secondDoc,
          actorID: naSecond.actorID,
          peer: { send: () => undefined },
        }),
      ]

      const state = Doc.submitCreate({ sessionID: second.id, docID: secondDoc, actorID: ga.actorID, prompt })
      expect(status(state, naSecond.actorID)).toBe("pending")

      Doc.actorUpsert({ sessionID: first.id, actorID: naFirst.actorID, autoConsent: true })

      expect(Doc.actorList(second.id).find((actor) => actor.actorID === naSecond.actorID)?.autoConsent).toBe(true)
      expect(gaSocket.events.some((event) => event.type === "sent" && event.state.submitID === state.submitID)).toBe(
        true,
      )

      Doc.actorUpsert({ sessionID: first.id, actorID: naFirst.actorID, autoConsent: false })
      expect(Doc.actorList(second.id).find((actor) => actor.actorID === naSecond.actorID)?.autoConsent).toBe(false)
      stops.forEach((stop) => stop())
    }),
  )

  test(
    "a different person with the same name in another conversation is not touched",
    within(async () => {
      const first = await Session.create({})
      const second = await Session.create({})
      const na = Doc.actorUpsert({ sessionID: first.id, userID: "737", name: "E2E 나" })
      const other = Doc.actorUpsert({ sessionID: second.id, userID: "999", name: "E2E 나" })

      Doc.actorUpsert({ sessionID: first.id, actorID: na.actorID, autoConsent: true })

      expect(Doc.actorList(second.id).find((actor) => actor.actorID === other.actorID)?.autoConsent).toBe(false)
    }),
  )

  test(
    "a member stored as left by the old rule rejoins already agreeing when auto-consent is on",
    within(async () => {
      const session = await Session.create({})
      const { docID } = Doc.prompt(session.id)
      const ga = Doc.actorUpsert({ sessionID: session.id, name: "E2E 가" })
      const na = Doc.actorUpsert({ sessionID: session.id, name: "E2E 나" })
      const da = Doc.actorUpsert({ sessionID: session.id, name: "E2E 다" })
      const stopGa = Doc.submitConnect({
        sessionID: session.id,
        docID,
        actorID: ga.actorID,
        peer: { send: () => undefined },
      })
      const stopDa = Doc.submitConnect({
        sessionID: session.id,
        docID,
        actorID: da.actorID,
        peer: { send: () => undefined },
      })
      const stopNa = Doc.submitConnect({
        sessionID: session.id,
        docID,
        actorID: na.actorID,
        peer: { send: () => undefined },
      })

      const state = Doc.submitCreate({ sessionID: session.id, docID, actorID: ga.actorID, prompt })
      stopNa()
      Database.use((db) =>
        db
          .update(DocSubmitActorTable)
          .set({ status: "left" })
          .where(and(eq(DocSubmitActorTable.submit_id, state.submitID), eq(DocSubmitActorTable.actor_id, na.actorID)))
          .run(),
      )
      Doc.actorUpsert({ sessionID: session.id, actorID: na.actorID, autoConsent: true })
      const stopBack = Doc.submitConnect({
        sessionID: session.id,
        docID,
        actorID: na.actorID,
        peer: { send: () => undefined },
      })

      const back = Doc.submitActive({ sessionID: session.id, docID, actorID: ga.actorID })
      expect(status(back, na.actorID)).toBe("approved")
      expect(status(back, da.actorID)).toBe("pending")
      ;[stopGa, stopDa, stopBack].forEach((stop) => stop())
    }),
  )
})
