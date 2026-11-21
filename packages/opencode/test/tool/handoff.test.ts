import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { HandoffTool, attachmentNames } from "../../src/tool/handoff"
import { ToolRegistry } from "../../src/tool/registry"
import { Agent } from "../../src/agent/agent"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

const sessionID = SessionID.make("ses_side")
const messageID = MessageID.make("msg_side")

function message(parts: Record<string, unknown>[]): MessageV2.WithParts {
  return {
    info: { id: messageID, sessionID, role: "user" } as MessageV2.Info,
    parts: parts.map((part) => ({ id: PartID.ascending(), sessionID, messageID, ...part })) as MessageV2.Part[],
  }
}

const history = [
  message([
    {
      type: "text",
      text: "이 화면 봐줘 ![shot](attachment://a1b2c3) 그리고 [로그 파일](attachment://build%20log.txt)",
    },
    { type: "file", mime: "image/png", filename: "a1b2c3", url: "/doc/doc_1/asset/a1b2c3" },
    { type: "file", mime: "image/png", filename: "pasted.png", url: "data:image/png;base64,AAAA" },
  ]),
  message([
    {
      type: "tool",
      callID: "call_1",
      tool: "read",
      state: {
        status: "completed",
        input: {},
        output: "",
        title: "",
        metadata: {},
        time: { start: 0, end: 0 },
        attachments: [{ type: "file", mime: "image/png", filename: "logo.png", url: "data:image/png;base64,AAAA" }],
      },
    },
  ]),
]

function ctx(messages: MessageV2.WithParts[]) {
  return {
    sessionID,
    messageID,
    callID: "call_handoff",
    agent: "side",
    abort: AbortSignal.any([]),
    messages,
    metadata: () => {},
    ask: async () => {},
  }
}

describe("attachmentNames", () => {
  test("collects file part names, tool attachments and attachment:// links", () => {
    const names = attachmentNames(history)
    for (const name of ["a1b2c3", "pasted.png", "logo.png", "build log.txt", "build%20log.txt"]) {
      expect(names.has(name)).toBe(true)
    }
  })
})

describe("tool.handoff", () => {
  test("places text, files and attachments without sending anything", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "src", "app.ts"), "export const a = 1\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await HandoffTool.init()
        const result = await tool.execute(
          {
            text: "app.ts 1번 줄을 고쳐줘",
            files: [{ path: "src/app.ts", start: 1, end: 1, comment: "여기" }],
            attachments: ["a1b2c3", "pasted.png"],
          },
          ctx(history),
        )
        expect(result.metadata).toMatchObject({ files: 1, attachments: 2 })
        expect(result.output).toContain("Nothing has been sent")
      },
    })
  })

  test("rejects unknown attachments and missing files so the model can fix them", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await HandoffTool.init()
        const run = tool.execute(
          { text: "넘겨", files: [{ path: "nope.ts" }], attachments: ["ghost.png"] },
          ctx(history),
        )
        await expect(run).rejects.toThrow(/ghost\.png[\s\S]*nope\.ts/)
      },
    })
  })

  test("rejects files outside the workspace", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await HandoffTool.init()
        await expect(tool.execute({ text: "넘겨", files: [{ path: "/etc/hosts" }] }, ctx([]))).rejects.toThrow(
          /\/etc\/hosts/,
        )
      },
    })
  })
})

describe("tool.handoff exposure", () => {
  // 운영 설정(docker/opencode.jsonc)은 "permission": "allow" 라 기본 deny 가 메인 에이전트에서 풀린다.
  test("only the side agent gets the tool, even with a permissive config", async () => {
    await using tmp = await tmpdir({ config: { permission: "allow" } as never })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = { providerID: ProviderID.make("test"), modelID: ModelID.make("test") }
        const ids = async (name: string) =>
          (await ToolRegistry.tools(model, await Agent.get(name))).map((tool) => tool.id)
        expect(await ids("build")).not.toContain("handoff")
        expect(await ids("plan")).not.toContain("handoff")
        expect(await ids(Agent.SIDE)).toContain("handoff")
      },
    })
  })

  test("refuses to run outside the side agent", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await HandoffTool.init()
        await expect(tool.execute({ text: "넘겨" }, { ...ctx([]), agent: "build" })).rejects.toThrow(/side chat/)
      },
    })
  })
})
