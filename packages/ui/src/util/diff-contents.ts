import { parsePatch } from "diff"

type Diffable = {
  patch?: string
  before?: string
  after?: string
  diff?: string
}

export type DiffContents = {
  before: string
  after: string
}

const LIMIT = 200
const cache = new Map<string, DiffContents>()

function rebuild(patch: string): DiffContents {
  const before: string[] = []
  const after: string[] = []
  for (const file of parsePatch(patch)) {
    for (const hunk of file.hunks) {
      let prev = " "
      for (const line of hunk.lines) {
        const op = line[0]
        const text = line.slice(1)
        if (op === "\\") {
          if (prev !== "+") before[before.length - 1] = before[before.length - 1].replace(/\n$/, "")
          if (prev !== "-") after[after.length - 1] = after[after.length - 1].replace(/\n$/, "")
          continue
        }
        if (op !== "+") before.push(text + "\n")
        if (op !== "-") after.push(text + "\n")
        prev = op
      }
    }
  }
  return { before: before.join(""), after: after.join("") }
}

export function diffContents(diff: Diffable | undefined): DiffContents {
  if (!diff) return { before: "", after: "" }
  if (typeof diff.before === "string" || typeof diff.after === "string") {
    return { before: diff.before ?? "", after: diff.after ?? "" }
  }
  const patch = diff.patch || diff.diff
  if (!patch) return { before: "", after: "" }
  const hit = cache.get(patch)
  if (hit) return hit
  const next = rebuild(patch)
  if (cache.size >= LIMIT) cache.delete(cache.keys().next().value!)
  cache.set(patch, next)
  return next
}
