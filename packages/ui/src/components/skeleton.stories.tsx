// @ts-nocheck
import * as mod from "./skeleton"
import { create } from "../storybook/scaffold"

const docs = `### Overview
Placeholder block for content that is still loading. Use it instead of leaving a region blank
when the wait is long enough to notice (doc rendering, message history, file tree).

### API
- \`width\` / \`height\`: number is px, string is used as-is.
- \`shape\`: \`line\` (default, text row) | \`block\` | \`circle\`.
- \`delay\`: seconds of sweep phase offset, so stacked rows do not flash in unison.

### Variants and states
- No loaded/error state — mount it while waiting, unmount when content arrives.

### Behavior
- CSS sweep animation; falls back to a plain opacity pulse under \`prefers-reduced-motion\`.

### Accessibility
- Rendered \`aria-hidden\` — pair it with a live region or visible text if the wait must be announced.

### Theming/tokens
- Mixes \`--text-weak\` with transparent, so it keeps contrast on any surface in both themes.
`

const story = create({ title: "UI/Skeleton", mod })

export default {
  title: "UI/Skeleton",
  id: "components-skeleton",
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

export const Shapes = {
  render: () => (
    <div style={{ display: "flex", gap: "16px", "align-items": "center" }}>
      <mod.Skeleton width={160} />
      <mod.Skeleton shape="block" width={120} height={64} />
      <mod.Skeleton shape="circle" width={32} />
    </div>
  ),
}

export const TextRows = {
  render: () => (
    <div style={{ display: "flex", "flex-direction": "column", gap: "8px", width: "320px" }}>
      <mod.Skeleton width="90%" delay={0} />
      <mod.Skeleton width="72%" delay={0.12} />
      <mod.Skeleton width="45%" delay={0.24} />
    </div>
  ),
}
