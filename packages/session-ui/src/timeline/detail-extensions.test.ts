import { describe, expect, test } from "bun:test"
import { Predicate } from "effect"
import type { SessionMessageInfo } from "@opencode/client/promise"
import { storyDocument, storyTool } from "../storybook/current-session-scenarios"
import { timelinePresets, type TimelineDetail } from "./detail"
import { Timeline } from "./projection"

const detail: TimelineDetail = {
  ...timelinePresets[0].value,
  thinking: { placement: "hidden", details: "collapsed" },
  notices: { placement: "hidden" },
  contextTools: ["read", "glob", "grep", "list"],
  separateFileTools: true,
  hideMinorErrors: true,
}

const groups = (messages: SessionMessageInfo[], status: "busy" | "idle", value: TimelineDetail) =>
  Timeline.constructSessionMessageRows(
    messages,
    false,
    { type: status },
    undefined,
    false,
    false,
    undefined,
    value,
  ).rows.flatMap((row) =>
    Predicate.isTagged(row, "AssistantPart")
      ? [
          row.group.type === "part"
            ? `part:${row.group.ref.partID}`
            : `${row.group.type}:${row.group.refs.map((ref) => ref.partID).join(",")}`,
        ]
      : Predicate.isTagged(row, "Retry")
        ? ["retry"]
        : [],
  )

describe("timeline detail extensions", () => {
  test("groups only context tools and keeps file changes in their own rows", () => {
    const document = storyDocument([
      storyTool("read_1", "read", "completed", { path: "a.ts" }),
      storyTool("grep_1", "grep", "completed", { pattern: "x" }),
      storyTool("fetch_1", "webfetch", "completed", { url: "https://example.com" }),
      storyTool("edit_1", "edit", "completed", { path: "a.ts" }),
      storyTool("edit_2", "edit", "completed", { path: "b.ts" }),
    ])

    expect(groups(document.messages, "idle", detail)).toEqual([
      "context:read_1,grep_1",
      "part:fetch_1",
      "part:edit_1",
      "part:edit_2",
    ])
  })

  test("drops failed file tools but keeps other failures", () => {
    const document = storyDocument([
      storyTool("read_1", "read", "error", { path: "a.ts" }),
      storyTool("shell_1", "shell", "error", { command: "false" }),
    ])

    expect(groups(document.messages, "idle", detail)).toEqual(["part:shell_1"])
    expect(groups(document.messages, "idle", { ...detail, hideMinorErrors: false })).toEqual([
      "context:read_1",
      "part:shell_1",
    ])
  })

  test("hides the retry banner", () => {
    const document = storyDocument([], true)
    const messages = document.messages.map((message) =>
      message.type === "assistant"
        ? { ...message, retry: { attempt: 1, at: 10, error: { type: "rate_limit", message: "slow down" } } }
        : message,
    ) as SessionMessageInfo[]

    expect(groups(messages, "busy", { ...detail, hideMinorErrors: false })).toEqual(["retry"])
    expect(groups(messages, "busy", detail)).toEqual([])
  })
})
