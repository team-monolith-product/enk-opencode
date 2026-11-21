import { describe, expect, test } from "bun:test"
import { manageLink, pushAfterChange, repoKey } from "./dialog-github-manage"

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
