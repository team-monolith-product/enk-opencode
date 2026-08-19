import { describe, expect, test } from "bun:test"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { createFileTreeStore } from "./tree-store"

function node(path: string): FileNode {
  const name = path.split("/").pop() ?? path
  return { name, path, absolute: "/" + path, type: "file", ignored: false } as FileNode
}

/** A list() whose every call is resolved by hand, so an in-flight refresh can be held open. */
function createListQueue() {
  const calls: { dir: string; resolve: (nodes: FileNode[]) => void }[] = []
  const list = (dir: string) =>
    new Promise<FileNode[]>((resolve) => {
      calls.push({ dir, resolve })
    })
  return { calls, list }
}

function createStore(list: (dir: string) => Promise<FileNode[]>) {
  return createFileTreeStore({
    scope: () => "/project",
    normalizeDir: (input) => input,
    list,
    onError: () => {},
  })
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("file tree store", () => {
  test("re-lists when a forced refresh lands while a listing is in flight", async () => {
    const queue = createListQueue()
    const tree = createStore(queue.list)

    void tree.listDir("__assets__")
    queue.calls[0].resolve([node("__assets__/a")])
    await settle()
    expect(tree.children("__assets__").map((n) => n.path)).toEqual(["__assets__/a"])

    // A watcher event for "b" starts a refresh; the server reads the folder before "c" is written.
    void tree.listDir("__assets__", { force: true })
    // The event for "c" arrives while that refresh is still in flight.
    void tree.listDir("__assets__", { force: true })
    queue.calls[1].resolve([node("__assets__/a"), node("__assets__/b")])
    await settle()

    expect(queue.calls.length).toBe(3)
    queue.calls[2].resolve([node("__assets__/a"), node("__assets__/b"), node("__assets__/c")])
    await settle()

    expect(tree.children("__assets__").map((n) => n.path)).toEqual([
      "__assets__/a",
      "__assets__/b",
      "__assets__/c",
    ])
  })

  test("does not re-list when nothing new arrived during the listing", async () => {
    const queue = createListQueue()
    const tree = createStore(queue.list)

    void tree.listDir("__assets__")
    void tree.listDir("__assets__")
    queue.calls[0].resolve([node("__assets__/a")])
    await settle()

    expect(queue.calls.length).toBe(1)
  })
})
