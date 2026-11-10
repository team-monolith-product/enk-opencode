import { afterEach, describe, expect, test } from "bun:test"
import { TurnSummary } from "../../src/enk/turn"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const user = (id: string, text: string, synthetic = false) =>
  ({
    info: { id, role: "user", sessionID: "ses_1", model: { providerID: "google", modelID: "gemini" }, locale: "ko" },
    parts: [{ type: "text", text, synthetic }],
  }) as unknown as MessageV2.WithParts

const assistant = (id: string, text: string) =>
  ({
    info: { id, role: "assistant", sessionID: "ses_1" },
    parts: [{ type: "text", text }],
  }) as unknown as MessageV2.WithParts

describe("TurnSummary.compose", () => {
  test("lists what changed under the summary", () => {
    const message = TurnSummary.compose(
      "로그인 화면 추가",
      [
        { status: "A", file: "login.html" },
        { status: "M", file: "index.html" },
        { status: "D", file: "old.css" },
      ],
      "ko",
    )

    expect(message).toBe("로그인 화면 추가\n\n- 추가: login.html\n- 수정: index.html\n- 삭제: old.css")
  })

  test("keeps the subject short and the file list bounded", () => {
    const changes = Array.from({ length: 32 }, (_, i) => ({ status: "M" as const, file: `f${i}.txt` }))

    const lines = TurnSummary.compose("x".repeat(100), changes, "en").split("\n")

    expect(lines[0]).toHaveLength(72)
    expect(lines).toHaveLength(2 + 30 + 1)
    expect(lines.at(-1)).toBe("- … +2")
  })
})

describe("TurnSummary.first", () => {
  test("names the first commit in the viewer locale", () => {
    const changes = [{ status: "A" as const, file: "index.html" }]

    expect(TurnSummary.compose(TurnSummary.first("en"), changes, "en")).toBe(
      "First push from Jitda\n\n- Add: index.html",
    )
    expect(TurnSummary.compose(TurnSummary.first(), changes)).toBe("짓다에서 처음 올린 내용\n\n- 추가: index.html")
  })

  test("names a manual push in the viewer locale", () => {
    const changes = [{ status: "M" as const, file: "index.html" }]

    expect(TurnSummary.compose(TurnSummary.manual("en"), changes, "en")).toBe(
      "Manual push from Jitda\n\n- Update: index.html",
    )
    expect(TurnSummary.compose(TurnSummary.manual(), changes)).toBe("짓다에서 직접 올린 내용\n\n- 수정: index.html")
  })
})

describe("TurnSummary.latest", () => {
  test("reads the last request and the final reply of the turn", () => {
    const turn = TurnSummary.latest([
      user("msg_1", "첫 요청"),
      assistant("msg_2", "첫 답변"),
      user("msg_3", "로그인 화면 만들어줘"),
      user("msg_4", "system reminder", true),
      assistant("msg_5", "만들고 있어요"),
      assistant("msg_6", "로그인 화면을 추가했어요"),
    ])

    expect(turn?.request).toBe("로그인 화면 만들어줘")
    expect(turn?.reply).toBe("로그인 화면을 추가했어요")
    expect(String(turn?.user.id)).toBe("msg_3")
  })

  test("returns nothing before the first request", () => {
    expect(TurnSummary.latest([])).toBeUndefined()
  })
})

describe("TurnSummary.recent", () => {
  afterEach(async () => {
    await Instance.disposeAll()
  })

  async function write(
    sessionID: SessionID,
    role: "user" | "assistant",
    text: string,
    created: number,
    synthetic = false,
  ) {
    const id = MessageID.ascending()
    await Session.updateMessage({
      id,
      sessionID,
      role,
      time: { created },
      agent: "test",
      model: { providerID: "test", modelID: "test" },
      ...(role === "assistant"
        ? {
            parentID: id,
            modelID: "test",
            providerID: "test",
            mode: "",
            path: { cwd: "/", root: "/" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          }
        : {}),
    } as unknown as MessageV2.Info)
    await Session.updatePart({ id: PartID.ascending(), sessionID, messageID: id, type: "text", text, synthetic })
    return id
  }

  async function within(fn: (sessionID: SessionID) => Promise<void>) {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => fn((await Session.create({})).id),
    })
  }

  test("reads only the last request and what came after it, across pages", () =>
    within(async (sessionID) => {
      const start = Date.now()
      let t = start
      for (let i = 0; i < 30; i++) await write(sessionID, i % 2 ? "assistant" : "user", `old ${i}`, t++)
      const request = await write(sessionID, "user", "로그인 화면 만들어줘", t++)
      for (let i = 0; i < 70; i++) await write(sessionID, "assistant", i === 69 ? "다 만들었어요" : `step ${i}`, t++)
      await write(sessionID, "user", "system reminder", t++, true)

      const recent = await TurnSummary.recent(sessionID)

      expect(recent).toHaveLength(72)
      expect(String(recent[0].info.id)).toBe(String(request))
      expect(TurnSummary.latest(recent)).toEqual(TurnSummary.latest(await Session.messages({ sessionID })))
      expect(TurnSummary.latest(recent)?.reply).toBe("다 만들었어요")
    }))

  test("returns everything when nobody has asked yet, and nothing for an empty session", () =>
    within(async (sessionID) => {
      expect(await TurnSummary.recent(sessionID)).toEqual([])
      await write(sessionID, "user", "reminder", Date.now(), true)
      await write(sessionID, "assistant", "hi", Date.now() + 1)
      expect(await TurnSummary.recent(sessionID)).toHaveLength(2)
      expect(TurnSummary.latest(await TurnSummary.recent(sessionID))).toBeUndefined()
    }))
})
