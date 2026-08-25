import { onCleanup, onMount } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { SessionClearVote } from "@/utils/session-clear-vote"

/**
 * "대화 초기화" 확인창.
 *
 * 속으로는 보관(archive)이지만 사용자에겐 그렇게 말하지 않는다 — 배포 레이아웃엔 사이드바가 없어
 * 보관된 대화로 돌아갈 길이 없으니, 사용자 입장에선 "다시 못 여는" 게 전부다. 문구에 보관을
 * 되살리지 말 것.
 *
 * 초기화에 닿는 길이 여럿이라(컴포저 버튼·커맨드·사이드바·대화 헤더) 확인창을 한 곳에 두고 모두
 * 여기로 모은다. 그래야 어느 길로 들어와도 같은 것을 묻고, 같은 동의를 거친다.
 *
 * 생김새는 합의(동의) 다이얼로그와 같은 언어를 쓴다 — 둘은 바로 이어서 뜨는 한 흐름이라
 * (확인 → 동의 투표) 서로 다른 카드처럼 보이면 안 된다. 질문 하나가 주인공이고, 경고는 상자 없이
 * 바닥에 한 줄, 액션은 Esc/Enter 를 단 44px 필 버튼이다.
 */
export function DialogClearSession(props: { session: Session; clear: (session: Session) => void | Promise<void> }) {
  const dialog = useDialog()
  const language = useLanguage()

  const handleClear = async () => {
    dialog.close()
    // 초기화는 되돌릴 수 없고, 같이 보던 사람들의 대화까지 사라진다. 함께 쓰는 중이면 전송·중지와
    // 같은 동의를 먼저 구하고, 합의가 서면 서버가 정리한다. 물어볼 상대가 없을 때만 바로 초기화한다.
    if (await SessionClearVote.request(props.session.id)) return
    void props.clear(props.session)
  }

  // Enter 로 확인, Esc 로 취소 — 합의 다이얼로그와 같은 손놀림이다. 버튼에 붙인 키 힌트가 실제로
  // 동작해야 하므로 여기서 직접 듣는다(Esc 는 Dialog 가 이미 닫는다). 파괴적 버튼에는 포커스를
  // 주지 않으므로 창 단위로 받는다.
  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return
      if (event.isComposing) return
      event.preventDefault()
      void handleClear()
    }
    window.addEventListener("keydown", onKey, true)
    onCleanup(() => window.removeEventListener("keydown", onKey, true))
  })

  return (
    <Dialog
      title={language.t("session.clear.confirm")}
      description={language.t("session.clear.description")}
      action={<span class="sr-only" />}
      transition
      fit
      class="session-clear-dialog hazard-dialog"
    >
      <div class="session-clear-body">
        <p class="session-clear-warn">
          <Icon name="warning" class="size-3.5" />
          <span>{language.t("session.clear.note")}</span>
        </p>
      </div>
      {/* 비대칭 액션 — 합의 카드와 같이 취소는 왼쪽 끝, 되돌릴 수 없는 실행은 오른쪽 끝이다.
          둘을 붙여 두면 손이 미끄러진다. */}
      <div class="hazard-dialog-footer">
        <Button type="button" size="normal" variant="secondary" class="session-clear-cancel" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
          <span class="session-clear-kbd">Esc</span>
        </Button>
        <div class="flex-1" />
        <Button type="button" size="normal" variant="primary" class="session-clear-confirm" onClick={handleClear}>
          {language.t("session.clear.button")}
          <span class="session-clear-kbd session-clear-kbd--on-dark">Enter</span>
        </Button>
      </div>
    </Dialog>
  )
}
