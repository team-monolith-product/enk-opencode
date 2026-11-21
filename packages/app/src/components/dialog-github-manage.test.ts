import { describe, expect, test } from "bun:test"
import type { GitHubStatus } from "@/utils/server"
import { manageLink, pushAfterChange, refetchOnReturn, repoKey, statusSync } from "./dialog-github-manage"

const manageUrl = "https://dev.jitda.io/auth/github/manage?team_id=7"

describe("manageLink", () => {
  test("adds the action to the Jitda manage window", () => {
    expect(manageLink(manageUrl, "change")).toBe("https://dev.jitda.io/auth/github/manage?team_id=7&action=change")
    expect(manageLink(manageUrl, "unlink")).toBe("https://dev.jitda.io/auth/github/manage?team_id=7&action=unlink")
  })

  test("opens on bana.build when embedded there", () => {
    expect(manageLink(manageUrl, "unlink", "https://bana.build")).toBe(
      "https://bana.build/auth/github/manage?team_id=7&action=unlink",
    )
  })
})

describe("pushAfterChange", () => {
  const before = repoKey({ owner: "octocat", name: "a", url: "" })
  const after = repoKey({ owner: "octocat", name: "b", url: "" })

  test("pushes once the repository was switched from the manage window", () => {
    expect(pushAfterChange({ managing: true, before, after, pushed: false })).toBe(true)
  })

  test("leaves it alone when nothing changed, it was already pushed, or the dialog did not open the manage window", () => {
    expect(pushAfterChange({ managing: true, before, after: before, pushed: false })).toBe(false)
    expect(pushAfterChange({ managing: true, before, after, pushed: true })).toBe(false)
    expect(pushAfterChange({ managing: false, before, after, pushed: false })).toBe(false)
    expect(pushAfterChange({ managing: true, before, after: undefined, pushed: false })).toBe(false)
  })
})

describe("refetchOnReturn", () => {
  test("only re-reads after this dialog opened the connect or manage window", () => {
    expect(refetchOnReturn({ waiting: false, managing: false })).toBe(false)
    expect(refetchOnReturn({ waiting: true, managing: false })).toBe(true)
    expect(refetchOnReturn({ waiting: false, managing: true })).toBe(true)
  })
})

describe("statusSync", () => {
  const repo = (name: string) => ({ owner: "octocat", name, url: `https://github.com/octocat/${name}` })
  const linked = (name: string, pushed = false): GitHubStatus => ({
    enabled: true,
    login: "octocat",
    app: true,
    repo: repo(name),
    push: pushed ? { sha: "abc", time: 1 } : undefined,
  })

  function setup(next: () => GitHubStatus | undefined, managing = true) {
    let status: GitHubStatus | undefined = linked("a", true)
    const calls = { load: 0, push: 0, failed: [] as boolean[] }
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const refetch = statusSync({
      load: async () => {
        calls.load++
        await gate
        return next()
      },
      current: () => status,
      managing: () => managing,
      apply: (value) => {
        if (value) status = value
        else calls.failed.push(!status)
      },
      push: async () => {
        calls.push++
      },
    })
    return { refetch, calls, release, status: () => status }
  }

  test("focus and visibilitychange together read once and push the switched repository once", async () => {
    const sync = setup(() => linked("b"))

    const first = sync.refetch()
    const second = sync.refetch()
    sync.release()
    await Promise.all([first, second])

    expect(first).toBe(second)
    expect(sync.calls).toMatchObject({ load: 1, push: 1 })
    expect(sync.status()?.repo?.name).toBe("b")
  })

  test("a later return reads again once the previous read finished", async () => {
    const sync = setup(() => linked("a", true))
    sync.release()
    await sync.refetch()
    await sync.refetch()

    expect(sync.calls).toMatchObject({ load: 2, push: 0 })
  })

  test("a failed read keeps the current status instead of showing the error screen", async () => {
    const sync = setup(() => undefined)
    sync.release()
    await sync.refetch()

    expect(sync.calls.failed).toEqual([false])
    expect(sync.status()?.repo?.name).toBe("a")
  })

  test("does not push when the dialog did not open the manage window", async () => {
    const sync = setup(() => linked("b"), false)
    sync.release()
    await sync.refetch()

    expect(sync.calls.push).toBe(0)
  })
})
