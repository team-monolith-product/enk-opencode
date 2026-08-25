import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { pickReplacementSession, SessionFollow } from "./session-follow"

const session = (id: string, extra: Partial<Session> = {}) =>
  ({
    id,
    projectID: "p",
    directory: "/tmp/project",
    title: id,
    version: "0",
    time: { created: 1, updated: 1 },
    ...extra,
  }) as Session

describe("pickReplacementSession", () => {
  test("picks the first root session", () => {
    const sessions = [session("ses_9"), session("ses_5")]
    expect(pickReplacementSession(sessions)?.id).toBe("ses_9")
  })

  test("skips the session that was just removed", () => {
    const sessions = [session("ses_9"), session("ses_5")]
    expect(pickReplacementSession(sessions, "ses_9")?.id).toBe("ses_5")
  })

  test("skips child sessions", () => {
    const sessions = [session("ses_9", { parentID: "ses_5" }), session("ses_5")]
    expect(pickReplacementSession(sessions, "ses_1")?.id).toBe("ses_5")
  })

  test("skips archived sessions", () => {
    const sessions = [session("ses_9", { time: { created: 1, updated: 1, archived: 2 } }), session("ses_5")]
    expect(pickReplacementSession(sessions, "ses_1")?.id).toBe("ses_5")
  })

  test("returns nothing when only the removed session is left", () => {
    expect(pickReplacementSession([session("ses_9")], "ses_9")).toBeUndefined()
    expect(pickReplacementSession([], "ses_9")).toBeUndefined()
    expect(pickReplacementSession(undefined, "ses_9")).toBeUndefined()
  })
})

describe("SessionFollow", () => {
  test("tracks waiting directories independently", () => {
    expect(SessionFollow.waiting("/a")).toBe(false)

    SessionFollow.expect("/a")
    expect(SessionFollow.waiting("/a")).toBe(true)
    expect(SessionFollow.waiting("/b")).toBe(false)

    SessionFollow.clear("/a")
    expect(SessionFollow.waiting("/a")).toBe(false)
  })

  test("clearing an unwatched directory is a no-op", () => {
    SessionFollow.clear("/never-waited")
    expect(SessionFollow.waiting("/never-waited")).toBe(false)
  })
})
