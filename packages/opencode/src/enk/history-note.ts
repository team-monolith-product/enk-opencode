import type { MessageV2 } from "@/session/message-v2"
import { History } from "./history"

/**
 * 팀이 파일을 되돌린 뒤 첫 답변에만 붙이는 안내. 대화는 그대로 남으므로, 앞선 대화가 말하는 파일과 지금 파일이
 * 다를 수 있다는 걸 AI 에게 알린다. 되돌린 시점의 마지막 메시지가 직전 답변보다 뒤면 그 답변은 되돌리기 전에 나온 것이다.
 */
export namespace HistoryNote {
  export async function text(dir: string, messages: MessageV2.WithParts[], userID: string) {
    const reply = messages.findLast((message) => message.info.role === "assistant" && message.info.id < userID)
    if (!reply) return
    const revert = await History.lastRevert(dir)
    if (!revert?.after || revert.after < reply.info.id) return
    return [
      "<system-reminder>",
      `After your last reply the team rolled the project files back to an earlier saved version (${JSON.stringify(revert.subject)}).`,
      "Files may no longer match what earlier messages in this conversation describe. Re-read a file before you edit it, and do not redo the rolled-back changes unless the user asks for them.",
      "</system-reminder>",
    ].join("\n")
  }
}
