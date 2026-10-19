import { parsePatch } from "diff"

type Diffable = {
  patch?: string
  before?: string
  after?: string
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
  if (typeof diff.patch !== "string" || diff.patch.length === 0) {
    return {
      before: typeof diff.before === "string" ? diff.before : "",
      after: typeof diff.after === "string" ? diff.after : "",
    }
  }
  const hit = cache.get(diff.patch)
  if (hit) return hit
  const next = rebuild(diff.patch)
  if (cache.size >= LIMIT) cache.delete(cache.keys().next().value!)
  cache.set(diff.patch, next)
  return next
}
