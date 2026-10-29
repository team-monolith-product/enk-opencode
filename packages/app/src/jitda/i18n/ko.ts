import type { dict as en } from "./en"
import { dict as side_panel } from "../side-panel/i18n.ko"
import { dict as env } from "../env/i18n.ko"
import { dict as github } from "../github/i18n.ko"
import { dict as pdf } from "../pdf/i18n.ko"
import { dict as generated_image } from "../generated-image/i18n.ko"
import { dict as composer } from "../composer/i18n.ko"
import { dict as timeline } from "../timeline/i18n.ko"

export const dict: Partial<Record<keyof typeof en, string>> = {
  ...side_panel,
  ...env,
  ...github,
  ...pdf,
  ...generated_image,
  ...composer,
  ...timeline,
}

export default dict
