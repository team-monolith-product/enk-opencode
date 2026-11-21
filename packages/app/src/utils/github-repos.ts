import type { GitHubRepo } from "./server"

export type RepoSort = "recent" | "name"

export function filterRepos(repos: GitHubRepo[], query: string, sort: RepoSort): GitHubRepo[] {
  const needle = query.trim().toLowerCase()
  const matched = needle ? repos.filter((repo) => `${repo.owner}/${repo.name}`.toLowerCase().includes(needle)) : repos
  return [...matched].sort(sort === "name" ? byName : byRecent)
}

function byName(a: GitHubRepo, b: GitHubRepo) {
  return (
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
    a.owner.localeCompare(b.owner, undefined, { sensitivity: "base" })
  )
}

function byRecent(a: GitHubRepo, b: GitHubRepo) {
  return time(b.pushedAt) - time(a.pushedAt) || byName(a, b)
}

function time(value?: string) {
  return value ? Date.parse(value) || 0 : 0
}
