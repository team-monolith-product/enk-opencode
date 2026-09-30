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
const request = {
  id: "img_01",
  sessionID,
  prompt: "해 질 녘 언덕 위의 귀여운 주황 고양이, 파스텔 톤 플랫 일러스트",
  path: "public/images/cat.png",
  size: "1536x1024",
  background: "auto",
  quota: { limit: 10, used: 3, remaining: 7 },
}

const dock = '[data-component="dock-prompt"][data-kind="image"]'

async function open(page: Page, quota = { limit: 10, used: 3, remaining: 7 }) {
  const pending: unknown[] = []
  const mock = await mockOpenCodeServer(page, {
    directory,
    project,
    sessions: [session],
    imageRequests: () => pending,
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
  return { mock, pending }
}

test.use({ viewport: { width: 1100, height: 800 }, locale: "ko-KR" })

test("AI 가 제안한 이미지는 학생이 만들기를 눌러야 요청한다", async ({ page }) => {
  const { mock } = await open(page)

  mock.emit({ type: "image.request.asked", properties: request })
  const card = page.locator(dock)
  await expect(card).toBeVisible()
  await expect(card).toContainText("이미지를 만들까요?")
  await expect(card).toContainText("7/10장 남음")
  await expect(card).toContainText("가로 · public/images/cat.png")
  await page.screenshot({ path: "e2e/test-results/image-request-dock.png" })

  const textarea = card.locator("textarea")
  await textarea.fill("주황 고양이, 픽셀아트")
  const approve = page.waitForRequest((r) => r.url().includes(`/image-request/${request.id}/approve`))
  await card.getByRole("button", { name: "만들기" }).click()
  expect((await approve).postDataJSON()).toMatchObject({ prompt: "주황 고양이, 픽셀아트" })
})

test("다음에를 누르면 skip 을 보낸다", async ({ page }) => {
  const { mock } = await open(page)
  mock.emit({ type: "image.request.asked", properties: request })
  await expect(page.locator(dock)).toBeVisible()

  const skip = page.waitForRequest((r) => r.url().includes(`/image-request/${request.id}/skip`))
  await page.locator(dock).getByRole("button", { name: "다음에" }).click()
  await skip
})

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

test("이미지 만들기 토글은 사용 개수와 팀 한도를 보여준다", async ({ page }) => {
  await open(page)

  const button = page.locator(toggle)
  await expect(button).toContainText("이미지 만들기")
  await expect(button).toContainText("3/10")
  await expect(button).toHaveAttribute("aria-checked", "false")

  await button.hover()
  await expect(page.getByText("팀당 10장까지 만들 수 있어요(7장 남음)")).toBeVisible()

  await button.click()
  await expect(button).toHaveAttribute("aria-checked", "true")
  await page.screenshot({ path: "e2e/test-results/image-toggle.png" })
  await button.screenshot({ path: "e2e/test-results/image-toggle-on.png" })
})

test("토글을 켜고 보낸 메시지에만 imageRequest 표시가 붙고 보낸 뒤 꺼진다", async ({ page }) => {
  await open(page)

  await page.locator(toggle).click()
  const flagged = await send(page, "게임 주인공 고양이 캐릭터")
  expect(flagged.parts[0].metadata).toEqual({ imageRequest: true })
  expect(flagged.parts[0].text).toContain("게임 주인공 고양이 캐릭터")
  await expect(page.locator(toggle)).toHaveAttribute("aria-checked", "false")
})

test("토글이 꺼져 있으면 일반 메시지로 보낸다", async ({ page }) => {
  await open(page)

  const plain = await send(page, "버튼 색 바꿔줘")
  expect(plain.parts[0].metadata).toBeUndefined()
})

test("한도를 다 쓰면 토글이 막힌다", async ({ page }) => {
  await open(page, { limit: 10, used: 10, remaining: 0 })

  const button = page.locator(toggle)
  await expect(button).toContainText("10/10")
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
  await expect(page.locator('[data-action="prompt-image-toggle"]')).toContainText("3/10", { timeout: 10_000 })
})
