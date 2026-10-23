// 짓다 화면 문구(영어 기준). 기능마다 파일을 나눠 두고 여기서 합친다. 키 이름은 V1 packages/app/src/i18n/en.ts 와 같다.
import { dict as side_panel } from "../side-panel/i18n.en"
import { dict as env } from "../env/i18n.en"
import { dict as github } from "../github/i18n.en"
import { dict as pdf } from "../pdf/i18n.en"
import { dict as generated_image } from "../generated-image/i18n.en"
import { dict as composer } from "../composer/i18n.en"
import { dict as timeline } from "../timeline/i18n.en"

export const dict = {
  ...side_panel,
  ...env,
  ...github,
  ...pdf,
  ...generated_image,
  ...composer,
  ...timeline,
}

export default dict
