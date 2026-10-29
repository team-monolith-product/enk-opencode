import type { FilePart, Message, Part, PermissionRuleset, Session, ToolPart } from "@opencode-ai/sdk/v2/client"

/** 서버 side 에이전트 이름 (packages/opencode/src/agent/agent.ts Agent.SIDE). */
export const SIDE_AGENT = "side"

/**
 * 사이드 채팅 세션인지. 서버가 `fork({ side: true })` 로 만든 세션은 원본의 자식이고 세션 permission 에
 * handoff 허용 규칙을 갖는다 — 다른 참여자의 브라우저는 로컬 상태가 없으므로 세션 정보만으로 판별한다.
 */
export function isSideSession(session: Pick<Session, "parentID" | "permission"> | undefined) {
  if (!session?.parentID) return false
  return hasHandoff(session.permission)
}

function hasHandoff(permission: PermissionRuleset | undefined) {
  return !!permission?.some((rule) => rule.permission === "handoff" && rule.action === "allow")
}

export type HandoffFile = { path: string; start?: number; end?: number; comment?: string }

export type HandoffInput = {
  text: string
  files: HandoffFile[]
  attachments: string[]
}

export type Handoff = { callID: string; input: HandoffInput }

function list(value: unknown) {
  return Array.isArray(value) ? value : []
}

function handoffInput(value: Record<string, unknown>): HandoffInput | undefined {
  if (typeof value.text !== "string" || !value.text.trim()) return
  const files = list(value.files).flatMap((item): HandoffFile[] => {
    if (!item || typeof item !== "object") return []
    const file = item as Record<string, unknown>
    if (typeof file.path !== "string" || !file.path) return []
    return [
      {
        path: file.path,
        start: typeof file.start === "number" ? file.start : undefined,
        end: typeof file.end === "number" ? file.end : undefined,
        comment: typeof file.comment === "string" ? file.comment : undefined,
      },
    ]
  })
  const attachments = list(value.attachments).filter((item): item is string => typeof item === "string" && !!item)
  return { text: value.text, files, attachments }
}

/** 끝난 handoff 툴 호출 중 아직 메인에 넣지 않은 것, 대화 순서대로. */
export function pendingHandoffs(
  messages: Message[] | undefined,
  parts: Record<string, Part[] | undefined>,
  handled: ReadonlySet<string>,
): Handoff[] {
  return (messages ?? []).flatMap((message) =>
    (parts[message.id] ?? []).flatMap((part): Handoff[] => {
      if (part.type !== "tool" || part.tool !== "handoff") return []
      if (part.state.status !== "completed" || handled.has(part.callID)) return []
      const input = handoffInput(part.state.input)
      return input ? [{ callID: part.callID, input }] : []
    }),
  )
}

export type AttachmentSource = Pick<FilePart, "mime" | "url" | "filename">

/**
 * handoff 의 첨부 이름 → 실제 파일. 서버 handoff 툴이 받아 준 이름 규칙과 같다: 파일 파트의 filename,
 * 툴 결과 첨부의 filename. doc 본문의 `attachment://` 링크는 같은 이름의 파일 파트를 가리킨다.
 */
export function findAttachment(
  messages: Message[] | undefined,
  parts: Record<string, Part[] | undefined>,
  name: string,
): AttachmentSource | undefined {
  // 서버 handoff 툴은 attachment:// 링크의 인코딩된 이름도 받아 준다 — 같은 이름을 디코딩해서도 찾는다.
  const names = new Set([name, decode(name)])
  for (const message of [...(messages ?? [])].reverse()) {
    for (const part of parts[message.id] ?? []) {
      if (part.type === "file" && part.filename && names.has(part.filename)) return part
      const tool = part as ToolPart
      if (part.type === "tool" && tool.state.status === "completed") {
        const found = tool.state.attachments?.find((item) => !!item.filename && names.has(item.filename))
        if (found) return found
      }
    }
  }
}

function decode(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const IMAGE = /\.(png|jpe?g|gif|webp)$/i

/** 바이트로 올려 이미지 블록으로 넣을 워크스페이스 파일. 그 밖의 파일은 참조 블록으로 넣는다. */
export function isImagePath(path: string) {
  return IMAGE.test(path)
}
