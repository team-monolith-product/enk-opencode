import { describe, expect, test } from "bun:test"
import { Permission } from "@/permission"

// 스포너가 OPENCODE_CONFIG_CONTENT 로 주입하는 동화책 모드 agent.build.permission 조각.
// 이 테스트는 그 조각이 코딩 툴을 구조적으로 비활성화하는지(모델에 노출조차 안 되는지) 고정한다.
const STORYBOOK_PERMISSION = {
  "*": "deny",
  upsert_page: "allow",
  delete_page: "allow",
  generate_illustration: "allow",
} as const

// agent.ts 의 build 에이전트 기본 룰셋(요약)에 동화책 조각이 마지막으로 병합되는 상황.
const defaults = Permission.fromConfig({ "*": "allow", question: "allow" })

const CODING_TOOLS = [
  "bash",
  "read",
  "edit",
  "write",
  "apply_patch",
  "multiedit",
  "glob",
  "grep",
  "list",
  "task",
  "webfetch",
  "websearch",
  "codesearch",
  "todowrite",
  "question",
  "skill",
  "lsp",
  "ensure_dev_server",
  "playwright_browser_navigate",
]

const STORYBOOK_TOOLS = ["upsert_page", "delete_page", "generate_illustration"]

describe("storybook mode tool lockdown", () => {
  const ruleset = Permission.merge(defaults, Permission.fromConfig(STORYBOOK_PERMISSION as any))

  test("denies every coding tool including MCP tools", () => {
    const disabled = Permission.disabled([...CODING_TOOLS, ...STORYBOOK_TOOLS], ruleset)
    for (const tool of CODING_TOOLS) {
      expect(disabled.has(tool)).toBe(true)
    }
  })

  test("keeps exactly the three storybook tools enabled", () => {
    const disabled = Permission.disabled([...CODING_TOOLS, ...STORYBOOK_TOOLS], ruleset)
    for (const tool of STORYBOOK_TOOLS) {
      expect(disabled.has(tool)).toBe(false)
    }
  })
})
