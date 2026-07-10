import { base64Encode } from "@opencode-ai/util/encode"
import { test, expect } from "../fixtures"
import { cleanupSession, clearSessionDockSeed, seedSessionQuestion } from "../actions"
import { questionDockSelector } from "../selectors"

test.setTimeout(180_000)

const customSelector = '[data-slot="question-option"][data-custom="true"]'

test("multi-select custom option toggles from the card body", async ({ page, sdk, directory }) => {
  const session = await sdk.session.create({ title: "e2e custom toggle" }).then((r) => r.data)
  if (!session?.id) throw new Error("Session create did not return an id")

  try {
    await page.goto(`/${base64Encode(directory)}/session/${session.id}`)

    await seedSessionQuestion(sdk, {
      sessionID: session.id,
      questions: [
        {
          header: "Need input",
          question: "Pick any options",
          options: [
            { label: "Alpha", description: "First" },
            { label: "Beta", description: "Second" },
          ],
          multiple: true,
          custom: true,
        },
      ],
    })

    const dock = page.locator(questionDockSelector)
    await expect(dock).toBeVisible({ timeout: 30_000 })

    const custom = () => dock.locator(customSelector)
    await expect(custom()).toHaveAttribute("data-picked", "false")

    // 1. Clicking the card body selects it and opens the editor.
    await custom().locator('[data-slot="option-label"]').click()
    await expect(custom()).toHaveAttribute("data-picked", "true")
    const field = dock.locator('[data-slot="question-custom-input"]')
    await expect(field).toBeVisible()

    // 2. Clicking the textarea keeps the selection and focuses the field.
    await field.click()
    await field.fill("직접 쓴 답변")
    await expect(custom()).toHaveAttribute("data-picked", "true")
    await expect(field).toBeFocused()

    // 3. Clicking the card body again (while editing) deselects and collapses.
    await custom().locator('[data-slot="option-label"]').click()
    await expect(custom()).toHaveAttribute("data-picked", "false")
    await expect(dock.locator('[data-slot="question-custom-input"]')).toHaveCount(0)

    // 4. The checkbox still toggles on its own.
    await custom().locator('[data-slot="question-option-check"]').click()
    await expect(custom()).toHaveAttribute("data-picked", "true")
    await custom().locator('[data-slot="question-option-check"]').click()
    await expect(custom()).toHaveAttribute("data-picked", "false")

    // 5. A regular option is unaffected.
    const alpha = dock.locator('[data-slot="question-option"]:not([data-custom])').first()
    await alpha.click()
    await expect(alpha).toHaveAttribute("data-picked", "true")
    await alpha.click()
    await expect(alpha).toHaveAttribute("data-picked", "false")
  } finally {
    await clearSessionDockSeed(sdk, session.id).catch(() => undefined)
    await cleanupSession({ sdk, sessionID: session.id })
  }
})

test("single-select custom option stays selected and focuses the field", async ({ page, sdk, directory }) => {
  const session = await sdk.session.create({ title: "e2e custom single" }).then((r) => r.data)
  if (!session?.id) throw new Error("Session create did not return an id")

  try {
    await page.goto(`/${base64Encode(directory)}/session/${session.id}`)

    await seedSessionQuestion(sdk, {
      sessionID: session.id,
      questions: [
        {
          header: "Need input",
          question: "Pick one option",
          options: [
            { label: "Alpha", description: "First" },
            { label: "Beta", description: "Second" },
          ],
          custom: true,
        },
      ],
    })

    const dock = page.locator(questionDockSelector)
    await expect(dock).toBeVisible({ timeout: 30_000 })

    const custom = () => dock.locator(customSelector)
    await custom().locator('[data-slot="option-label"]').click()
    await expect(custom()).toHaveAttribute("data-picked", "true")

    // A radio has no deselect: the card body keeps it on and focuses the field.
    await custom().locator('[data-slot="option-label"]').click()
    await expect(custom()).toHaveAttribute("data-picked", "true")
    await expect(dock.locator('[data-slot="question-custom-input"]')).toBeFocused()
  } finally {
    await clearSessionDockSeed(sdk, session.id).catch(() => undefined)
    await cleanupSession({ sdk, sessionID: session.id })
  }
})
