import { connectUrlFor } from "@/utils/connect-url"
import type { GitHubRepo, GitHubStatus } from "@/utils/server"

export type ManageAction = "change" | "unlink"

export const repoKey = (repo?: GitHubRepo) => (repo ? `${repo.owner}/${repo.name}` : undefined)

export function manageLink(manageUrl: string, action: ManageAction, host?: string) {
  const target = new URL(connectUrlFor(manageUrl, host))
  target.searchParams.set("action", action)
  return target.toString()
}

export function pushAfterChange(input: { managing: boolean; before?: string; after?: string; pushed: boolean }) {
  if (!input.managing || input.pushed) return false
  return !!input.before && !!input.after && input.before !== input.after
}

export function refetchOnReturn(input: { waiting: boolean; managing: boolean }) {
  return input.waiting || input.managing
}

export function statusSync(deps: {
  load: () => Promise<GitHubStatus | undefined>
  current: () => GitHubStatus | undefined
  managing: () => boolean
  apply: (status: GitHubStatus | undefined) => void
  push: () => Promise<unknown>
}) {
  let pending: Promise<void> | undefined
  const run = async () => {
    const before = repoKey(deps.current()?.repo)
    const status = await deps.load()
    deps.apply(status)
    if (!status) return
    const after = repoKey(status.repo)
    if (pushAfterChange({ managing: deps.managing(), before, after, pushed: !!status.push })) await deps.push()
  }
  return () => (pending ??= run().finally(() => (pending = undefined)))
}
