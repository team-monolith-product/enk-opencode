import path from "path"
import z from "zod"
import { Instance } from "../project/instance"
import type { MessageV2 } from "../session/message-v2"
import { Filesystem } from "../util/filesystem"
import { Tool } from "./tool"
import DESCRIPTION from "./handoff.txt"

/** handoff 를 쓸 수 있는 유일한 에이전트(agent.ts Agent.SIDE 와 같은 값). */
export const SIDE_AGENT = "side"

/**
 * 사이드 채팅 세션인지 — fork({ side: true }) 가 만든 자식 세션은 세션 permission 에 handoff 허용 규칙을
 * 갖는다. 메시지의 에이전트 이름이 아니라 세션으로 판별해야 압축(compaction) 같은 다른 에이전트가
 * 사이드 세션에서 돌 때도 같은 규칙이 적용된다.
 */
export function isSideSession(session: { parentID?: string; permission?: { permission: string; action: string }[] }) {
  if (!session.parentID) return false
  return !!session.permission?.some((rule) => rule.permission === "handoff" && rule.action === "allow")
}

export const HandoffFile = z.object({
  path: z.string().describe("Workspace file path, relative to the project root or absolute"),
  start: z.number().int().positive().optional().describe("First line of the relevant range (1-based)"),
  end: z.number().int().positive().optional().describe("Last line of the relevant range (1-based)"),
  comment: z.string().optional().describe("What the main agent should know about this range"),
})
export type HandoffFile = z.infer<typeof HandoffFile>

export const HandoffParams = z.object({
  text: z
    .string()
    .min(1)
    .describe("The request to place in the main session's prompt, in the user's voice and language"),
  files: z.array(HandoffFile).optional().describe("Workspace files or line ranges to attach as references"),
  attachments: z
    .array(z.string())
    .optional()
    .describe("Images or files from this conversation, by the name in their attachment://<name> link"),
})
export type HandoffParams = z.infer<typeof HandoffParams>

const LINK = /attachment:\/\/([^\s)"'\]]+)/g

// 대화에 실제로 있는 첨부 이름 — 파일 파트의 filename, 툴 결과 첨부, doc 본문의 attachment:// 링크.
// 이름이 이 집합에 없으면 앱이 바이트를 찾을 수 없으므로 AI 에게 되돌려 고치게 한다.
export function attachmentNames(messages: MessageV2.WithParts[]) {
  const names = new Set<string>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "file" && part.filename) names.add(part.filename)
      if (part.type === "text") {
        for (const match of part.text.matchAll(LINK)) {
          names.add(match[1])
          try {
            names.add(decodeURIComponent(match[1]))
          } catch {}
        }
      }
      if (part.type === "tool" && part.state.status === "completed") {
        for (const item of part.state.attachments ?? []) if (item.filename) names.add(item.filename)
      }
    }
  }
  return names
}

function resolve(file: string) {
  const full = path.isAbsolute(file) ? file : path.resolve(Instance.directory, file)
  return Filesystem.normalizePath(full)
}

// 서버는 아무것도 보내지 않는다. 사이드 채팅을 연 사람의 브라우저가 완료된 이 툴 파트를 보고 메인 세션의
// 프롬프트 doc 에 블록을 넣는다 — 실제 전송은 사용자가 메인에서 평소처럼(동의 투표 포함) 한다.
export const HandoffTool = Tool.define("handoff", {
  description: DESCRIPTION,
  parameters: HandoffParams,
  async execute(params, ctx) {
    // 툴 목록에서 이미 빠지지만, 다른 경로로 불려도 메인 대화에서 "넣었다"고 거짓말하지 않게 막는다.
    if (ctx.agent !== SIDE_AGENT) throw new Error("handoff is only available in a side chat.")
    const known = attachmentNames(ctx.messages)
    const attachments = params.attachments ?? []
    const unknown = attachments.filter((name) => !known.has(name))

    const files = params.files ?? []
    const missing = files
      .map((file) => file.path)
      .filter((file) => {
        const full = resolve(file)
        if (!Instance.containsPath(full)) return true
        return !Filesystem.stat(full)
      })

    if (unknown.length || missing.length) {
      const lines = [
        "Nothing was placed in the main session. Fix the arguments and call handoff again.",
        ...(unknown.length
          ? [`Unknown attachments (use the exact name from an attachment://<name> link): ${unknown.join(", ")}`]
          : []),
        ...(missing.length ? [`Files not found in the workspace: ${missing.join(", ")}`] : []),
      ]
      throw new Error(lines.join("\n"))
    }

    const summary = [
      files.length ? `${files.length} file reference${files.length > 1 ? "s" : ""}` : undefined,
      attachments.length ? `${attachments.length} attachment${attachments.length > 1 ? "s" : ""}` : undefined,
    ].filter(Boolean)

    return {
      title: "Handed to main",
      output: [
        `Placed in the main session's prompt editor${summary.length ? ` with ${summary.join(" and ")}` : ""}.`,
        "Nothing has been sent. The user reviews it and sends it from the main session when ready.",
        "Tell the user it is waiting in the main input. Do not claim the main agent received it.",
      ].join(" "),
      metadata: {
        files: files.length,
        attachments: attachments.length,
      },
    }
  },
})
