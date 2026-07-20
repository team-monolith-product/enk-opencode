import { test, expect, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/util/encode"
import { mockOpenCodeServer, sessionCreatedEvent, todoEvent, type MockSession } from "../mock-server"
import { sessionTodoDockSelector, sessionTodoToggleButtonSelector } from "../selectors"

/**
 * Regression coverage for the "todo dock does not update / disappears across sessions" bug, driven
 * through the REAL client data path (bootstrap → global store → reconcile → dock) via a mocked
 * backend. Unlike the composer e2e driver (session-composer-dock.spec.ts), which short-circuits
 * todos()/live(), this drives real todo.updated / session.created events so the store, the
 * {key:null} reconcile, and the open-session cache pin are all exercised.
 *
 * Each test below fails on the pre-fix code: test 1 at the collapsed-state leak, test 2 when the
 * trim cleanup drops the viewed session's todos. (The session-boundary dock-state guard has its
 * own unit coverage via todoDockAtBoundary in session-composer-state.test.ts.)
 */

const directory = "/mock/todo-dock-navigation"
const project = {
  id: "proj_todo_dock_nav",
  worktree: directory,
  directory,
  vcs: "git",
  name: "todo-dock-navigation",
  time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
}

const sessionA = "ses_dock_source"
const sessionB = "ses_dock_other"

function session(id: string, title: string, updated: number): MockSession {
  return {
    id,
    slug: id,
    projectID: project.id,
    directory,
    title,
    version: "dev",
    time: { created: updated, updated },
  }
}

const todoAActive = [
  { content: "first task", status: "completed", priority: "high" },
  { content: "second task", status: "in_progress", priority: "high" },
]

const dockSel = sessionTodoDockSelector

function href(id: string) {
  return `/${base64Encode(directory)}/session/${id}`
}

/** SPA navigation only — a full reload would remount the composer and mask the bug. */
async function navigate(page: Page, id: string) {
  await page.evaluate((url) => {
    history.pushState({}, "", url)
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
  }, href(id))
}

async function seed(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })
}

const rowStates = (page: Page) =>
  page.locator(`${dockSel} [data-slot="session-todo-list"] [data-state]`).evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-state")),
  )

test.use({ viewport: { width: 1440, height: 900 } })

test("todo dock follows the session across navigation", async ({ page }) => {
  test.setTimeout(60_000)

  const todos: Record<string, typeof todoAActive> = { [sessionA]: [], [sessionB]: [] }
  const live = new Set<string>([sessionA, sessionB])

  const mock = await mockOpenCodeServer(page, {
    directory,
    project,
    sessions: [session(sessionA, "AAA source", 1_700_000_100_000), session(sessionB, "BBB other", 1_700_000_200_000)],
    todos: (id) => todos[id] ?? [],
    status: () => Object.fromEntries([...live].map((id) => [id, { type: "busy" }])),
  })

  await seed(page)
  await page.goto(href(sessionA))
  await expect(page.locator('[data-component="session-prompt-dock"]')).toBeVisible()
  await expect(page.locator(dockSel)).toHaveCount(0)

  // A gains active todos via a real todo.updated event -> dock opens from the store.
  todos[sessionA] = todoAActive
  mock.emit(todoEvent(sessionA, todoAActive))
  await expect(page.locator(dockSel)).toBeVisible()
  await expect.poll(() => rowStates(page)).toEqual(["completed", "in_progress"])

  // A -> B (no todos): the dock must close at the boundary, not linger showing A's todos.
  await navigate(page, sessionB)
  await expect(page.locator(dockSel)).toHaveCount(0)

  // B gains its own todos -> dock shows B's, independently.
  const todoB = [{ content: "b only", status: "in_progress", priority: "high" }]
  todos[sessionB] = todoB
  mock.emit(todoEvent(sessionB, todoB))
  await expect(page.locator(dockSel)).toBeVisible()
  await expect.poll(() => rowStates(page)).toEqual(["in_progress"])

  // B -> A: A's todos come back from the store, still expanded.
  await navigate(page, sessionA)
  await expect(page.locator(dockSel)).toBeVisible()
  await expect.poll(() => rowStates(page)).toEqual(["completed", "in_progress"])

  // A collapsed, then A -> B: B must render expanded, not inherit A's collapsed state (fork fix #2).
  await page.locator(sessionTodoToggleButtonSelector).click()
  await expect(page.locator(`${sessionTodoToggleButtonSelector}[data-collapsed="true"]`)).toBeVisible()

  await navigate(page, sessionB)
  await expect(page.locator(dockSel)).toBeVisible()
  await expect(page.locator(`${sessionTodoToggleButtonSelector}[data-collapsed="false"]`)).toBeVisible()
  await expect.poll(() => rowStates(page)).toEqual(["in_progress"])
})

test("the viewed session's todos survive session-cache trimming", async ({ page }) => {
  test.setTimeout(60_000)

  // A is old (updated long ago) and sorts last by id, so once >5 newer root sessions exist it falls
  // out of trimSessions' keep-set. Only the open-session pin keeps its todos alive.
  const older = 1_600_000_000_000
  const list: MockSession[] = [session(sessionA, "AAA pinned", older)]
  const todos: Record<string, typeof todoAActive> = { [sessionA]: [] }

  const mock = await mockOpenCodeServer(page, {
    directory,
    project,
    sessions: () => list,
    todos: (id) => todos[id] ?? [],
    status: () => ({ [sessionA]: { type: "busy" } }),
  })

  await seed(page)
  await page.goto(href(sessionA))
  await expect(page.locator('[data-component="session-prompt-dock"]')).toBeVisible()

  // A gains active todos via a real todo.updated event (session is already live).
  todos[sessionA] = todoAActive
  mock.emit(todoEvent(sessionA, todoAActive))
  await expect(page.locator(dockSel)).toBeVisible()
  await expect.poll(() => rowStates(page)).toEqual(["completed", "in_progress"])

  // Churn: create 8 newer root sessions. Each session.created runs cleanupDroppedSessionCaches,
  // which drops caches for sessions outside the trimmed keep-set — session A included, unless pinned.
  for (let i = 0; i < 8; i++) {
    const id = `ses_churn_${i}`
    const info = session(id, `churn ${i}`, 1_700_000_500_000 + i)
    list.push(info)
    mock.emit(sessionCreatedEvent(info))
  }

  // Wait until the client has drained and applied the churn (the SSE queue empties as connections
  // consume it). Without this the assertion would trivially pass against the pre-churn state.
  await expect.poll(() => mock.pending(), { timeout: 15_000 }).toBe(0)
  await page.waitForTimeout(1_000)

  // The dock is still showing A's todos — the open-session pin protected them from the trim cleanup.
  await expect(page.locator(dockSel)).toBeVisible()
  await expect(rowStates(page)).resolves.toEqual(["completed", "in_progress"])
})
