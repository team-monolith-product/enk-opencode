import type { dict as en } from "./i18n.en"

export const dict: Partial<Record<keyof typeof en, string>> = {
  "jitda.btw.title": "옆 질문",
  "jitda.btw.description": "이 답은 나만 봐요. 팀 대화에는 남지 않아요.",
  "jitda.btw.loading": "생각하는 중…",
  "jitda.btw.failed": "답을 받지 못했어요.",
  "jitda.btw.retry": "다시 묻기",
  "jitda.revert.banner": "이전 시점으로 되돌렸어요. 새 메시지를 보내면 그대로 확정돼요.",
  "jitda.revert.redo": "되돌리기 취소",
  "jitda.initialPlan.title": "우리 팀의 최초 기획을 전달했어요",
  "jitda.initialPlan.expand": "전체 보기",
  "jitda.initialPlan.collapse": "접기",
}
