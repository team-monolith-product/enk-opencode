import { connectUrlFor } from "@/utils/connect-url"
import type { GitHubRepo } from "@/utils/server"

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
