import { onCleanup } from "solid-js"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"

/**
 * 버전 기록 되돌리기의 결과를 함께 보던 모두에게 알린다. 되돌리기는 대화가 끝나지 않아도 파일을 바꾸므로,
 * 되돌려지면 `onRestored` 로 미리보기를 바로 다시 그리게 한다.
 */
export function createHistoryNotices(onRestored: () => void) {
  const sdk = useSDK()
  const language = useLanguage()

  onCleanup(
    sdk.event.on("history.restored", (event) => {
      onRestored()
      showToast({
        title: language.t("history.restored", { subject: event.properties.subject }),
        description: event.properties.deps ? language.t("history.restored.deps") : undefined,
      })
    }),
  )
  onCleanup(
    sdk.event.on("history.failed", (event) => {
      showToast({ title: language.t(`history.error.${event.properties.code}`) })
    }),
  )
}
