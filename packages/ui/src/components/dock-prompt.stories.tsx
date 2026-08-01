// @ts-nocheck
import * as mod from "./dock-prompt"
import { Button } from "./button"
import { Icon } from "./icon"
import { TextField } from "./text-field"
import { create } from "../storybook/scaffold"

const docs = `### Overview
Docked prompt layout for questions and permission requests.

Use with form controls or confirmation buttons in the footer.

### API
- Required: \`kind\` (question | permission), \`header\`, \`children\`, \`footer\`.
- Optional: \`ref\` for measuring or focus management.

### Variants and states
- Question and permission layouts (data attributes).

### Behavior
- Pure layout component; behavior handled by parent.

### Accessibility
- Ensure header and footer content provide clear context and actions.

### Theming/tokens
- Uses \`data-component="dock-prompt"\` with kind data attribute.

`

const story = create({
  title: "UI/DockPrompt",
  mod,
  args: {
    kind: "question",
    header: "Header",
    children: "Prompt content",
    footer: "Footer",
  },
})

export default {
  title: "UI/DockPrompt",
  id: "components-dock-prompt",
  component: story.meta.component,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: docs,
      },
    },
  },
}

export const Basic = story.Basic

export const Permission = {
  args: {
    kind: "permission",
    header: "Allow access?",
    children: "This action needs permission to proceed.",
    footer: "Approve or deny",
  },
}

// 외부 연동 값 입력 도크(c3-env-secure). 상단 해저드 스트라이프와 푸터 tuck 을 눈으로 확인하는 용도.
export const Env = {
  args: {
    kind: "env",
    header: (
      <>
        <span class="inline-flex shrink-0 items-center justify-center text-icon-base">
          <Icon name="lock" size="small" />
        </span>
        <span class="text-13-medium text-text-strong shrink-0">안전 입력</span>
        <span class="text-12-regular text-text-weaker truncate min-w-0">· 식약처 공공데이터</span>
      </>
    ),
    children: <TextField class="font-mono" label="값" hideLabel placeholder="받은 값을 붙여넣어요" />,
    footer: (
      <>
        <div class="flex items-center gap-1.5 min-w-0">
          <span class="text-12-regular text-text-weak shrink-0">이 값은 AI에게 전달되지 않아요</span>
          <span class="text-12-regular text-text-weaker truncate min-w-0">· 지유님이 입력 중</span>
        </div>
        <div class="flex-1" />
        <div class="flex items-center gap-2 shrink-0">
          <Button variant="secondary" size="small">
            취소
          </Button>
          <Button variant="primary" size="small">
            안전하게 저장
          </Button>
        </div>
      </>
    ),
  },
}
