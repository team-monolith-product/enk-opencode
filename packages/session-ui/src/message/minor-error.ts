import type { SessionMessageAssistant } from "@opencode/client/promise"

// 모델이 스스로 회복하는 파일 도구 실패(줄 범위·편집 앵커·옮겨진 경로). shell/subagent 실패는 사용자에게 보여야 하므로 뺀다.
const FILE_TOOLS = new Set(["read", "write", "edit", "multiedit", "patch", "apply_patch", "glob", "grep", "list"])

export function minorToolError(content: SessionMessageAssistant["content"][number]) {
  return content.type === "tool" && content.state.status === "error" && FILE_TOOLS.has(content.name)
}
