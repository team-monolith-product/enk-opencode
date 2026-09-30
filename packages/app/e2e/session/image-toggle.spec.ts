import { test, expect, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/util/encode"
import { mockOpenCodeServer, type MockSession } from "../mock-server"

const directory = "/mock/image-request"
const project = {
  id: "proj_image_request",
  worktree: directory,
  directory,
  vcs: "git",
  name: "image-request",
  time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
}
const sessionID = "ses_image_request"
const session: MockSession = {
  id: sessionID,
  slug: sessionID,
  projectID: project.id,
  directory,
  title: "image",
  version: "dev",
  time: { created: 1_700_000_100_000, updated: 1_700_000_100_000 },
}

async function open(page: Page, quota = { limit: 10, used: 3, remaining: 7 }) {
  const mock = await mockOpenCodeServer(page, {
    directory,
    project,
    sessions: [session],
    imageQuota: () => ({ enabled: true, quota }),
    provider: {
      all: [
        {
          id: "mock",
          name: "Mock",
          env: [],
          models: {
            "mock-model": {
              id: "mock-model",
              name: "Mock Model",
              providerID: "mock",
              capabilities: { attachment: false, reasoning: false, temperature: true, toolcall: true },
              limit: { context: 100000, output: 4096 },
              cost: { input: 0, output: 0 },
              options: {},
            },
          },
        },
      ],
      connected: ["mock"],
      default: { mock: "mock-model" },
    },
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expect(page.locator('[data-component="session-prompt-dock"]')).toBeVisible()
  return { mock }
}

test.use({ viewport: { width: 1100, height: 800 }, locale: "ko-KR" })

const toggle = '[data-action="prompt-image-toggle"]'

async function send(page: Page, text: string) {
  await page.locator('[data-action="prompt-normal"]').click()
  const editor = page.locator('[data-component="prompt-input"]')
  await editor.click()
  await page.keyboard.type(text)
  const prompt = page.waitForRequest((r) => /\/session\/[^/]+\/prompt_async/.test(r.url()))
  await page.keyboard.press("Enter")
  return (await prompt).postDataJSON()
}

test("남은 개수가 있으면 기본으로 켜져 있고 툴팁으로 팀 한도를 알려준다", async ({ page }) => {
  await open(page)

  const button = page.locator(toggle)
  await expect(button).toContainText("이미지 만들기")
  await expect(button).not.toContainText("3/10")
  await expect(button).toHaveAttribute("aria-checked", "true")

  await button.hover()
  await expect(page.getByText("팀당 10장까지 만들 수 있어요(7장 남음)")).toBeVisible()
  await page.screenshot({ path: "e2e/test-results/image-toggle.png" })
  await button.screenshot({ path: "e2e/test-results/image-toggle-on.png" })
})

test("켜져 있으면 이미지 생성을 허용해 보내고 보낸 뒤에도 켜져 있다", async ({ page }) => {
  await open(page)

  const body = await send(page, "게임 주인공 고양이 캐릭터")
  expect(body.imageGeneration).toBe(true)
  expect(body.parts[0].metadata).toBeUndefined()
  await expect(page.locator(toggle)).toHaveAttribute("aria-checked", "true")
})

test("사용자가 끄면 허용하지 않고 보내고 새로고침해도 꺼진 채로 남는다", async ({ page }) => {
  await open(page)

  await page.locator(toggle).click()
  await expect(page.locator(toggle)).toHaveAttribute("aria-checked", "false")
  const body = await send(page, "버튼 색 바꿔줘")
  expect(body.imageGeneration).toBe(false)
  await expect(page.locator(toggle)).toHaveAttribute("aria-checked", "false")

  await page.reload()
  await expect(page.locator(toggle)).toHaveAttribute("aria-checked", "false")
})

test("한도를 다 쓰면 꺼진 채로 막힌다", async ({ page }) => {
  await open(page, { limit: 10, used: 10, remaining: 0 })

  const button = page.locator(toggle)
  await expect(button).toHaveAttribute("aria-checked", "false")
  await expect(button).toBeDisabled()
})

test("느린 개수 조회가 대화 화면을 막지 않는다", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project,
    sessions: [session],
    imageQuota: () => ({ enabled: true, quota: { limit: 10, used: 3, remaining: 7 } }),
    imageQuotaDelay: 5_000,
  })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expect(page.locator('[data-component="session-prompt-dock"]')).toBeVisible({ timeout: 3_000 })
  await expect(page.locator('[data-action="prompt-image-toggle"]')).toBeVisible({ timeout: 10_000 })
})
