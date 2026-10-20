import type { dict as en } from "./i18n.en"

export const dict: Partial<Record<keyof typeof en, string>> = {
  "ui.tool.generateImage": "이미지 생성",
  "ui.tool.generateImage.generating": "그리는 중…",
  "ui.tool.generateImage.blocked": "안전 정책 때문에 이 이미지는 만들 수 없었어요.",
  "ui.tool.generateImage.timeout": "이미지를 만드는 데 너무 오래 걸려 그림을 받지 못했어요.",
  "ui.tool.generateImage.open": "이미지 크게 보기",
  "ui.tool.generateImage.subagent": "서브에이전트에서는 그림을 그리지 않아요. 메인 대화에서 요청해 주세요.",
  "ui.tool.generateImage.off": "이번 메시지는 이미지 만들기가 꺼져 있어서 그리지 않았어요.",
  "ui.tool.generateImage.disabled": "이 해커톤에서는 이미지 생성을 사용하지 않아요.",
  "ui.tool.generateImage.unavailable": "이 작업 공간에서는 이미지 생성을 쓸 수 없어요.",
  "ui.tool.generateImage.limited": "우리 팀이 만들 수 있는 이미지 {{limit}}장을 모두 사용했어요.",
  "ui.tool.generateImage.remaining": "{{remaining}}/{{limit}}장 남음",
}
