import { describe, expect, test } from "bun:test"
import { filterRepos } from "./github-repos"
import type { GitHubRepo } from "./server"

const repo = (owner: string, name: string, pushedAt?: string): GitHubRepo => ({
  owner,
  name,
  url: `https://github.com/${owner}/${name}`,
  pushedAt,
})

const repos = [
  repo("octocat", "beta", "2026-11-01T00:00:00Z"),
  repo("octocat", "Alpha", "2026-11-20T00:00:00Z"),
  repo("team", "jitda-project"),
  repo("octocat", "gamma", "2026-11-10T00:00:00Z"),
]

const names = (list: GitHubRepo[]) => list.map((item) => item.name)

describe("filterRepos", () => {
  test("sorts by the latest push first and puts unknown times last", () => {
    expect(names(filterRepos(repos, "", "recent"))).toEqual(["Alpha", "gamma", "beta", "jitda-project"])
  })

  test("sorts by name ignoring case", () => {
    expect(names(filterRepos(repos, "", "name"))).toEqual(["Alpha", "beta", "gamma", "jitda-project"])
  })

  test("matches the owner or the name ignoring case", () => {
    expect(names(filterRepos(repos, " ALP ", "name"))).toEqual(["Alpha"])
    expect(names(filterRepos(repos, "team/", "name"))).toEqual(["jitda-project"])
  })

  test("keeps the given list as it is", () => {
    const before = names(repos)
    filterRepos(repos, "", "name")
    expect(names(repos)).toEqual(before)
  })
})
