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

  return (
    <Dialog
      title={language.t("session.clear.title")}
      description={language.t("session.clear.description")}
      action={<span class="sr-only" />}
      transition
      fit
      class="session-clear-dialog hazard-dialog"
    >
      <div class="session-clear-body">
        <div class="session-clear-callout">
          <span class="session-clear-badge">
            <Icon name="warning" class="size-4.5" />
          </span>
          <div class="session-clear-copy">
            <span class="session-clear-headline">{language.t("session.clear.confirm")}</span>
            <span class="session-clear-note">{language.t("session.clear.note")}</span>
          </div>
        </div>
      </div>
      <div class="hazard-dialog-footer">
        <div class="flex-1" />
        <Button type="button" size="normal" variant="secondary" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </Button>
        <Button type="button" size="normal" variant="primary" class="session-clear-confirm" onClick={handleClear}>
          {language.t("session.clear.button")}
        </Button>
      </div>
    </Dialog>
  )
}
