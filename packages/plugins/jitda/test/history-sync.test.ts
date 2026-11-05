import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import path from "node:path"
import os from "node:os"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { GitHub } from "../src/github"
import { History } from "../src/history"
import { HistorySync } from "../src/history-sync"
import { Sentry } from "../src/sentry"
import { SessionActivity } from "../src/session-activity"
import { WorkspaceRepo } from "../src/workspace-repo"

const xdg = process.env["XDG_DATA_HOME"]
const data = await mkdtemp(path.join(os.tmpdir(), "jitda-history-sync-data-"))
const SESSION = "ses_1"

beforeEach(() => {
  process.env["XDG_DATA_HOME"] = data
})

afterEach(() => {
  delete process.env["ENK_PROJECT_DIRECTORY"]
  if (xdg === undefined) delete process.env["XDG_DATA_HOME"]
  else process.env["XDG_DATA_HOME"] = xdg
})

afterAll(() => rm(data, { recursive: true, force: true }))

async function tmpdir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jitda-history-sync-"))
  return { path: dir, [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }) }
}

const read = (dir: string) => Bun.file(path.join(dir, "index.html")).text()

async function until(fn: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return
    await Bun.sleep(20)
  }
  throw new Error("timed out")
}

type Message = Record<string, unknown> & { id: string; type: string }

async function team(root: string) {
  const dir = path.join(root, "project-directory")
  await mkdir(path.join(dir, ".git"), { recursive: true })
  await writeFile(path.join(dir, ".git", "opencode"), "team-1-project")
  await writeFile(path.join(dir, "index.html"), "v1")
  const first = (await History.commit(dir, { message: "처음" }))!
  await writeFile(path.join(dir, "index.html"), "v2")
  await History.commit(dir, { message: "두번째" })
  const session: { parentID?: string; revert?: unknown } = {}
  const messages: Message[] = []
  const events: { name: string; data: Record<string, unknown> }[] = []
  const ctx = {
    location: { directory: dir },
    generate: { text: async () => ({ text: "요약한 제목" }) },
    session: { get: async () => session, context: async () => messages },
  } as unknown as Plugin.Context
  const sync = HistorySync.create(ctx, async (name, data) => void events.push({ name, data }))
  return { dir, first, session, messages, events, sync }
}

const turnEnded = (type = "session.execution.succeeded") => ({ type, data: { sessionID: SESSION } })
const seen = (dir: string) => ({ type: "session.created", location: { directory: dir }, data: { sessionID: SESSION } })

describe("rollback", () => {
  test("rolls back right away and tells everyone", async () => {
    await using tmp = await tmpdir()
    const { dir, first, sync, events } = await team(tmp.path)

    await sync.rollback({ sessionID: SESSION, sha: first.sha })

    expect(await read(dir)).toBe("v1")
    expect(events).toEqual([
      {
        name: "restored",
        data: {
          sessionID: SESSION,
          sha: (await History.list(dir))[0]!.sha,
          target: first.sha,
          subject: "처음",
          files: 1,
          deps: false,
        },
      },
    ])
    expect((await History.list(dir))[0]).toMatchObject({ subject: "되돌리기: 처음", revert: first.sha })
  })

  test("marks a rollback that changed the package list", async () => {
    await using tmp = await tmpdir()
    const { dir, first, sync, events } = await team(tmp.path)
    await writeFile(path.join(dir, "package.json"), "{}")
    await History.commit(dir, { message: "패키지" })

    await sync.rollback({ sessionID: SESSION, sha: first.sha })

    expect(events[0]?.data).toMatchObject({ files: 2, deps: true })
  })

  test("rolling back to what the files already are tells everyone nothing changed", async () => {
    await using tmp = await tmpdir()
    const { dir, sync, events } = await team(tmp.path)
    const latest = (await History.list(dir))[0]!

    await sync.rollback({ sessionID: SESSION, sha: latest.sha })

    expect(events).toEqual([{ name: "failed", data: { sessionID: SESSION, code: "same" } }])
    expect(await History.list(dir)).toHaveLength(2)
  })

  test("rolling back to a rollback does not stack the title prefix", async () => {
    await using tmp = await tmpdir()
    const { dir, first, sync } = await team(tmp.path)
    await sync.rollback({ sessionID: SESSION, sha: first.sha })
    const rolled = (await History.list(dir))[0]!
    await writeFile(path.join(dir, "index.html"), "v3")
    await History.commit(dir, { message: "세번째", turn: "msg_9" })

    await sync.rollback({ sessionID: SESSION, sha: rolled.sha })

    expect((await History.list(dir))[0]).toMatchObject({ subject: "되돌리기: 처음", revert: rolled.sha })
  })

  test("uses the language of the last request", async () => {
    await using tmp = await tmpdir()
    const { dir, first, sync, messages } = await team(tmp.path)
    messages.push({ id: "msg_1", type: "user", text: "hello", metadata: { locale: "en" } })

    await sync.rollback({ sessionID: SESSION, sha: first.sha })

    expect((await History.list(dir)).map((entry) => entry.subject)[0]).toBe("Roll back to: 처음")
  })

  test("tells everyone when the agreed rollback can no longer run", async () => {
    await using tmp = await tmpdir()
    const { dir, first, sync, events } = await team(tmp.path)
    await rm(WorkspaceRepo.open(dir).root, { recursive: true, force: true })

    await sync.rollback({ sessionID: SESSION, sha: first.sha })

    expect(events).toEqual([{ name: "failed", data: { sessionID: SESSION, code: "missing" } }])
    expect(await read(dir)).toBe("v2")
  })

  test("refuses while the AI is answering", async () => {
    await using tmp = await tmpdir()
    const { dir, first, sync, events } = await team(tmp.path)
    SessionActivity.start(dir, SESSION)

    await expect(sync.verify({ sessionID: SESSION, sha: first.sha })).rejects.toMatchObject({ code: "busy" })
    await sync.rollback({ sessionID: SESSION, sha: first.sha })
    SessionActivity.reset(dir)

    expect(events).toEqual([{ name: "failed", data: { sessionID: SESSION, code: "busy" } }])
    expect(await read(dir)).toBe("v2")
  })

  test("refuses while a message revert is staged, so its undo cannot overwrite the rollback", async () => {
    await using tmp = await tmpdir()
    const { dir, first, sync, session, events } = await team(tmp.path)
    session.revert = { messageID: "msg_1" }

    await expect(sync.verify({ sessionID: SESSION, sha: first.sha })).rejects.toMatchObject({ code: "staged" })
    await sync.rollback({ sessionID: SESSION, sha: first.sha })

    expect(events).toEqual([{ name: "failed", data: { sessionID: SESSION, code: "staged" } }])
    expect(await read(dir)).toBe("v2")
  })

  test("a model call waits for the rollback and then sees the rolled back files", async () => {
    await using tmp = await tmpdir()
    const { dir, first, sync } = await team(tmp.path)

    const rollback = sync.rollback({ sessionID: SESSION, sha: first.sha })
    await sync.gate.pass()

    expect(await read(dir)).toBe("v1")
    await rollback
  })
})

describe("HistorySync.createGate", () => {
  test("holds model calls until the work ends and survives a failure", async () => {
    const gate = HistorySync.createGate()
    const order: string[] = []
    let finish!: () => void
    const held = gate.hold(() => new Promise<void>((resolve) => (finish = resolve)).then(() => void order.push("work")))
    const passed = gate.pass().then(() => void order.push("model"))
    await Bun.sleep(5)
    expect(order).toEqual([])

    finish()
    await Promise.all([held, passed])
    expect(order).toEqual(["work", "model"])

    await gate.hold(() => Promise.reject(new Error("boom"))).catch(() => undefined)
    await gate.pass()
  })
})

describe("turn end", () => {
  test("saves the turn with a generated title, once", async () => {
    await using tmp = await tmpdir()
    const { dir, sync, messages } = await team(tmp.path)
    await writeFile(path.join(dir, "index.html"), "v3")
    messages.push(
      { id: "msg_1", type: "user", text: "바꿔줘" },
      {
        id: "msg_2",
        type: "assistant",
        content: [{ type: "text", text: "바꿨어요" }],
        model: { providerID: "p", id: "m" },
      },
    )

    sync.observe(seen(dir))
    sync.observe(turnEnded())
    await until(async () => (await History.list(dir)).length === 3)

    expect((await History.list(dir))[0]?.subject).toBe("요약한 제목")
    await writeFile(path.join(dir, "notes.txt"), "after")
    await sync.finished(SESSION)
    expect(await History.list(dir)).toHaveLength(3)
  })

  test("a stopped or failed turn is saved too", async () => {
    await using tmp = await tmpdir()
    const { dir, sync, messages } = await team(tmp.path)
    await writeFile(path.join(dir, "index.html"), "v3")
    messages.push({ id: "msg_1", type: "user", text: "바꿔줘" })

    sync.observe(seen(dir))
    sync.observe(turnEnded("session.execution.interrupted"))

    await until(async () => (await History.list(dir)).length === 3)
    expect((await History.list(dir))[0]?.subject).toBe("바꿔줘")
  })

  test("ignores other folders and subagents", async () => {
    await using tmp = await tmpdir()
    const { dir, sync, session, messages } = await team(tmp.path)
    await writeFile(path.join(dir, "index.html"), "v3")
    messages.push({ id: "msg_1", type: "user", text: "바꿔줘" })

    sync.observe({ ...seen("/elsewhere"), type: "session.created" })
    sync.observe(turnEnded())
    await Bun.sleep(30)
    expect(await History.list(dir)).toHaveLength(2)

    session.parentID = "ses_parent"
    await sync.finished(SESSION)
    expect(await History.list(dir)).toHaveLength(2)
  })

  test("tracks whether the session is running from its events", async () => {
    await using tmp = await tmpdir()
    const { dir, sync } = await team(tmp.path)

    sync.observe(seen(dir))
    sync.observe({ type: "session.execution.started", data: { sessionID: SESSION } })
    expect(SessionActivity.has(dir, SESSION)).toBe(true)

    sync.observe(turnEnded())
    expect(SessionActivity.has(dir, SESSION)).toBe(false)
  })
})

describe("note", () => {
  test("tells the AI about the rollback only on the first reply after it", async () => {
    await using tmp = await tmpdir()
    const { first, sync, messages } = await team(tmp.path)
    messages.push({ id: "msg_1", type: "user", text: "처음" }, { id: "msg_2", type: "assistant" })

    await sync.rollback({ sessionID: SESSION, sha: first.sha })
    messages.push({ id: "msg_3", type: "user", text: "다음" })
    expect(await sync.note(SESSION)).toContain('"되돌리기: 처음"')

    messages.push({ id: "msg_4", type: "assistant" }, { id: "msg_5", type: "user", text: "또" })
    expect(await sync.note(SESSION)).toBeUndefined()
  })
})

describe("GitHub.failed", () => {
  test("expected states are only noted, never sent to Sentry", () => {
    const sent = spyOn(Sentry, "captureOnce").mockImplementation(() => {})
    try {
      for (const code of ["unlinked", "norepo", "empty", "exists"] as const)
        GitHub.failed(new GitHub.Failure(code, 409), SESSION)
      expect(sent).not.toHaveBeenCalled()
    } finally {
      sent.mockRestore()
    }
  })
})
