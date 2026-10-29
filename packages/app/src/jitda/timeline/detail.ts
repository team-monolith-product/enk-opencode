import type { TimelineDetail } from "@opencode/session-ui/timeline/detail"
import { Flags } from "@/jitda/flags"

// V1 짓다 대화: 추론 요약·알림 줄은 숨기고(showReasoningSummaries 기본 false), 읽기·검색·목록만 "탐색" 묶음으로 모으며,
// 셸·편집·작성·서브에이전트 같은 나머지 도구는 접힌 채 한 줄씩 보인다.
export const JITDA_TIMELINE: TimelineDetail = {
  shell: { placement: "separate", details: "collapsed" },
  edit: { placement: "separate", details: "collapsed" },
  thinking: { placement: "hidden", details: "collapsed" },
  subagents: { placement: "separate" },
  notices: { placement: "hidden" },
  tools: { placement: "separate" },
  contextTools: ["read", "glob", "grep", "list"],
  separateFileTools: true,
  hideMinorErrors: Flags.disableMinorErrors,
}
