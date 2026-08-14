import { describe, expect, test } from "bun:test"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { createFileTreeStore } from "./tree-store"

const node = (path: string, type: "file" | "directory"): FileNode => ({
  name: path.split("/").at(-1)!,
  path,
  absolute: "/project/" + path,
  type,
  ignored: false,
})

function store(listing: Record<string, FileNode[]>) {
  const calls: string[] = []
  const tree = createFileTreeStore({
    scope: () => "/project",
    normalizeDir: (input) => input.replace(/\/+$/, ""),
    list: async (dir) => {
      calls.push(dir)
      return listing[dir] ?? []
    },
    onError: () => {},
  })
  return { tree, calls }
}

describe("loadedDirs", () => {
  test("returns the listed directories at or under a prefix", async () => {
    const { tree } = store({
      "": [node("__assets__", "directory"), node("src", "directory")],
      __assets__: [node("__assets__/deck", "directory"), node("__assets__/a.pdf", "file")],
      "__assets__/deck": [node("__assets__/deck/1.png", "file")],
      src: [node("src/index.ts", "file")],
    })

    await tree.listDir("")
    await tree.listDir("__assets__")
    await tree.listDir("__assets__/deck")
    await tree.listDir("src")

    expect(tree.loadedDirs("__assets__").toSorted()).toEqual(["__assets__", "__assets__/deck"])
  })

  test("skips a directory that is known but never listed", async () => {
    const { tree } = store({
      "": [node("__assets__", "directory")],
      __assets__: [node("__assets__/deck", "directory")],
    })

    await tree.listDir("")
    await tree.listDir("__assets__")
    // `deck` exists as a node and has a collapsed dir entry, but nothing has listed it yet — there
    // is nothing on screen to refresh.
    tree.collapseDir("__assets__/deck")

    expect(tree.loadedDirs("__assets__")).toEqual(["__assets__"])
  })

  test("an empty prefix means every listed directory", async () => {
    const { tree } = store({ "": [node("src", "directory")], src: [] })

    await tree.listDir("")
    await tree.listDir("src")

    expect(tree.loadedDirs("").toSorted()).toEqual(["", "src"])
  })

  test("a sibling with a shared prefix is not under it", async () => {
    const { tree } = store({
      "": [node("__assets__", "directory"), node("__assets__-old", "directory")],
      __assets__: [],
      "__assets__-old": [],
    })

    await tree.listDir("")
    await tree.listDir("__assets__")
    await tree.listDir("__assets__-old")

    expect(tree.loadedDirs("__assets__")).toEqual(["__assets__"])
  })

  test("re-lists a directory the delete emptied, so a later upload does not read as empty", async () => {
    const listing: Record<string, FileNode[]> = {
      "": [node("__assets__", "directory")],
      __assets__: [node("__assets__/a.pdf", "file")],
    }
    const { tree, calls } = store(listing)

    await tree.listDir("")
    await tree.listDir("__assets__")
    expect(tree.children("__assets__").map((n) => n.path)).toEqual(["__assets__/a.pdf"])

    // "delete all" removes the folder itself; the tree still holds a loaded entry for it.
    listing[""] = []
    listing["__assets__"] = []
    for (const dir of ["", ...tree.loadedDirs("__assets__")]) await tree.listDir(dir, { force: true })

    expect(tree.children("")).toEqual([])
    expect(tree.children("__assets__")).toEqual([])
    expect(calls).toEqual(["", "__assets__", "", "__assets__"])
  })
})
