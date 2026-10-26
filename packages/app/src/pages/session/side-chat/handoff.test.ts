import { describe, expect, test } from "bun:test"
import { claimHandoff, insertHandoff, prepareHandoff, type HandoffTarget } from "./handoff"

function memoryStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  }
}

describe("claimHandoff", () => {
  test("only the first tab sharing the storage claims a call", async () => {
    const shared = memoryStorage()
    expect(await claimHandoff("call_1", shared, undefined)).toBe(true)
    expect(await claimHandoff("call_1", shared, undefined)).toBe(false)
    expect(await claimHandoff("call_2", shared, undefined)).toBe(true)
  })

  test("serializes concurrent claims through the lock", async () => {
    const shared = memoryStorage()
    let queue = Promise.resolve<unknown>(undefined)
    const locks = {
      request: <T>(_name: string, callback: () => T | Promise<T>) => {
        const next = queue.then(callback)
        queue = next.catch(() => undefined)
        return next as Promise<T>
      },
    }
    const results = await Promise.all([claimHandoff("call_1", shared, locks), claimHandoff("call_1", shared, locks)])
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  test("claims when storage is unusable rather than dropping the handoff", async () => {
    const broken = {
      getItem: () => {
        throw new Error("denied")
      },
      setItem: () => {},
    }
    expect(await claimHandoff("call_1", broken, undefined)).toBe(true)
  })
})

const target = (overrides: Partial<HandoffTarget> = {}) => {
  const calls: string[] = []
  const value: HandoffTarget = {
    addText: (text) => (calls.push(`text:${text}`), true),
    addReference: (path) => (calls.push(`ref:${path}`), true),
    addLineReference: (input) => (calls.push(`line:${input.path}:${input.selection.start}`), true),
    addFiles: async (files) => (
      calls.push(`files:${files.map((file) => file.name).join(",")}`),
      {
        added: true,
        overflow: false,
        tooLarge: false,
      }
    ),
    ...overrides,
  }
  return { value, calls }
}

describe("prepareHandoff / insertHandoff", () => {
  const sources = {
    workspace: async (path: string) =>
      path === "public/logo.png" ? new Blob(["png"], { type: "image/png" }) : undefined,
    attachment: async (name: string) =>
      name === "shot.png" ? { blob: new Blob(["x"]), filename: "shot.png", mime: "image/png" } : undefined,
  }

  test("gathers bytes first, then inserts text, references and files in order", async () => {
    const prepared = await prepareHandoff(
      {
        text: "고쳐줘",
        files: [{ path: "src/a.ts", start: 3 }, { path: "README.md" }, { path: "public/logo.png" }],
        attachments: ["shot.png", "ghost.png"],
      },
      sources,
    )
    expect(prepared.failed).toEqual(["ghost.png"])
    expect(prepared.files.map((file) => [file.name, file.type])).toEqual([
      ["logo.png", "image/png"],
      ["shot.png", "image/png"],
    ])
    const { value, calls } = target()
    const result = await insertHandoff(prepared, value)
    expect(calls).toEqual(["text:고쳐줘", "line:src/a.ts:3", "ref:README.md", "files:logo.png,shot.png"])
    expect(result).toEqual({ failed: ["ghost.png"], overflow: false, tooLarge: false })
  })

  test("reports everything the composer did not take instead of claiming success", async () => {
    const prepared = await prepareHandoff(
      { text: "넘겨", files: [{ path: "a.ts" }], attachments: ["shot.png"] },
      sources,
    )
    const { value } = target({
      addText: () => false,
      addReference: () => false,
      addFiles: async () => ({ added: false, overflow: false, tooLarge: false }),
    })
    const result = await insertHandoff(prepared, value)
    expect(result.failed).toEqual(['"넘겨"', "a.ts", "shot.png"])
  })

  test("leaves over-limit files to the overflow notice", async () => {
    const prepared = await prepareHandoff({ text: "넘겨", files: [], attachments: ["shot.png"] }, sources)
    const { value } = target({ addFiles: async () => ({ added: false, overflow: true, tooLarge: false }) })
    expect(await insertHandoff(prepared, value)).toEqual({ failed: [], overflow: true, tooLarge: false })
  })
})
