import type { UiI18n } from "../context/i18n"

export function formatDuration(i18n: UiI18n, numfmt: Intl.NumberFormat, ms: number) {
  const total = Math.round(ms / 1000)
  if (total < 60) return i18n.t("ui.message.duration.seconds", { count: numfmt.format(total) })
  return i18n.t("ui.message.duration.minutesSeconds", {
    minutes: numfmt.format(Math.floor(total / 60)),
    seconds: numfmt.format(total % 60),
  })
}
