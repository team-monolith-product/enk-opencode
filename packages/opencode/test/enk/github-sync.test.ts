import { describe, expect, test } from "bun:test"
import { GitHubSync } from "../../src/enk/github-sync"
import type { MessageV2 } from "../../src/session/message-v2"

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

describe("GitHubSync.compose", () => {
  test("lists what changed under the summary", () => {
    const message = GitHubSync.compose(
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

    const lines = GitHubSync.compose("x".repeat(100), changes, "en").split("\n")

    expect(lines[0]).toHaveLength(72)
    expect(lines).toHaveLength(2 + 30 + 1)
    expect(lines.at(-1)).toBe("- … +2")
  })
})

describe("GitHubSync.latest", () => {
  test("reads the last request and the final reply of the turn", () => {
    const turn = GitHubSync.latest([
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
    expect(GitHubSync.latest([])).toBeUndefined()
  })
})
