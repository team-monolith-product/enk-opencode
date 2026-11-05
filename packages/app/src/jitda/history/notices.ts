import { onCleanup } from "solid-js"
import { showToast } from "@opencode/ui/toast"
import { useLanguage } from "@/runtime/i18n/language"
import { useJitda } from "../context"

type Restored = { subject: string; deps: boolean }

// 버전 기록 되돌리기의 결과를 함께 보던 모두에게 알린다. 되돌리기는 대화가 끝나지 않아도 파일을 바꾸므로, 되돌려지면 onRestored 로
// 미리보기를 바로 다시 그리게 한다.
export function createHistoryNotices(onRestored: () => void) {
  const jitda = useJitda()
  const language = useLanguage()
  const t = (key: string, params?: Record<string, string | number | boolean>) =>
    language.t(key as Parameters<typeof language.t>[0], params)

  onCleanup(
    jitda.rpc.history.events.on("restored", (event) => {
      const data = event.data as unknown as Restored
      onRestored()
      showToast({
        title: t("history.restored", { subject: data.subject }),
        description: data.deps ? t("history.restored.deps") : undefined,
      })
    }),
  )
  onCleanup(
    jitda.rpc.history.events.on("failed", (event) => {
      showToast({ title: t(`history.error.${(event.data as { code?: string }).code}`) })
    }),
  )
}
