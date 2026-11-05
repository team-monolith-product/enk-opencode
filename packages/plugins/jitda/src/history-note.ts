import { History } from "./history"

// 팀이 파일을 되돌린 뒤 첫 답변에만 붙이는 안내. 대화는 그대로 남으므로 앞선 대화가 말하는 파일과 지금 파일이 다를 수 있다는
// 걸 AI 에게 알린다. 메시지 id 는 브라우저 시계로 만들어질 수 있어 순서는 대화 안의 위치로 본다.

export type Message = { id: string; type: string }

export function text(revert: History.Revert | undefined, messages: ReadonlyArray<Message>) {
  if (!revert?.after) return
  const at = messages.findLastIndex((message) => message.type === "user")
  const reply = (at < 0 ? messages : messages.slice(0, at)).findLastIndex((message) => message.type === "assistant")
  if (reply < 0) return
  if (messages.findIndex((message) => message.id === revert.after) < reply) return
  return [
    "<system-reminder>",
    `After your last reply the team rolled the project files back to an earlier saved version (${JSON.stringify(revert.subject)}).`,
    "Files may no longer match what earlier messages in this conversation describe. Re-read a file before you edit it, and do not redo the rolled-back changes unless the user asks for them.",
    "</system-reminder>",
  ].join("\n")
}

export * as HistoryNote from "./history-note"
