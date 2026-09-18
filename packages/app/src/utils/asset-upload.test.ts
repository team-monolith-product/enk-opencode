import { describe, expect, test } from "bun:test"
import {
  MAX_ASSET_BYTES,
  UPLOAD_CONCURRENCY,
  assetBatch,
  assetCapacity,
  assetRefusal,
  assetRelativePath,
  assetSubtree,
  deleteAsset,
  isAssetPath,
  pickedFromDataTransfer,
  pickedFromInput,
  uploadAssets,
  type PickedFile,
} from "./asset-upload"

function file(name: string, size = 1, relative?: string) {
  const out = new File([new Uint8Array(size)], name)
  if (relative) Object.defineProperty(out, "webkitRelativePath", { value: relative })
  Object.defineProperty(out, "size", { value: size })
  return out
}

function picked(name: string, size = 1): PickedFile {
  return { file: file(name, size), path: name }
}

function client(onCreate: (path: string) => void | Promise<void>) {
  return {
    file: {
      asset: {
        create: async ({ path }: { path: string }) => {
          await onCreate(path)
          return { data: { path } }
        },
      },
    },
  } as any
}

// Minimal stand-ins for the FileSystemEntry shapes a drop event exposes.
function fileEntry(name: string) {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (cb: (f: File) => void) => cb(file(name)),
  }
}

function dirEntry(name: string, children: any[]) {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let sent = false
      return {
        readEntries: (cb: (entries: any[]) => void) => {
          // The real API signals the end of a directory with an empty batch.
          cb(sent ? [] : children)
          sent = true
        },
      }
    },
  }
}

function dataTransfer(entries: any[], files: File[] = []) {
  return {
    items: entries.map((entry) => ({ kind: "file", webkitGetAsEntry: () => entry })),
    files,
  } as unknown as DataTransfer
}

describe("pickedFromInput", () => {
  test("uses the plain name for a file pick", () => {
    expect(pickedFromInput([file("a.txt")])).toEqual([{ file: expect.anything(), path: "a.txt" }])
  })

  test("keeps the folder shape for a directory pick", () => {
    expect(pickedFromInput([file("a.txt", 1, "docs/spec/a.txt")])[0]!.path).toBe("docs/spec/a.txt")
  })
})

describe("pickedFromDataTransfer", () => {
  test("takes plain dropped files", async () => {
    const out = await pickedFromDataTransfer(dataTransfer([fileEntry("a.txt"), fileEntry("b.txt")]))
    expect(out.map((item) => item.path)).toEqual(["a.txt", "b.txt"])
  })

  test("descends into a dropped folder and keeps its shape", async () => {
    const tree = dirEntry("docs", [fileEntry("readme.md"), dirEntry("spec", [fileEntry("api.md")])])
    const out = await pickedFromDataTransfer(dataTransfer([tree]))
    expect(out.map((item) => item.path)).toEqual(["docs/readme.md", "docs/spec/api.md"])
  })

  test("falls back to the flat list when entries are unavailable", async () => {
    const out = await pickedFromDataTransfer({ items: [], files: [file("a.txt")] } as unknown as DataTransfer)
    expect(out.map((item) => item.path)).toEqual(["a.txt"])
  })
})

describe("uploadAssets", () => {
  test("uploads every file and reports each one", async () => {
    const seen: string[] = []
    const progress: number[] = []
    const result = await uploadAssets({
      client: client((path) => void seen.push(path)),
      directory: "/tmp/project",
      files: [picked("a.txt"), picked("b.txt"), picked("c.txt")],
      onProgress: (done) => progress.push(done),
    })

    expect(result).toEqual({ uploaded: 3, failed: [] })
    expect(seen.sort()).toEqual(["a.txt", "b.txt", "c.txt"])
    expect(progress).toEqual([1, 2, 3])
  })

  test("rejects an oversized file without sending it", async () => {
    const seen: string[] = []
    const result = await uploadAssets({
      client: client((path) => void seen.push(path)),
      directory: "/tmp/project",
      files: [picked("big.bin", MAX_ASSET_BYTES + 1), picked("ok.txt")],
    })

    expect(result.uploaded).toBe(1)
    expect(result.failed).toEqual([{ path: "big.bin", reason: "size" }])
    expect(seen).toEqual(["ok.txt"])
  })

  test("one failure does not discard the rest of the batch", async () => {
    const result = await uploadAssets({
      client: client((path) => {
        if (path === "b.txt") throw new Error("boom")
      }),
      directory: "/tmp/project",
      files: [picked("a.txt"), picked("b.txt"), picked("c.txt")],
    })

    expect(result.uploaded).toBe(2)
    expect(result.failed).toEqual([{ path: "b.txt", reason: "error" }])
  })

  test("runs a bounded number of uploads at once", async () => {
    let active = 0
    let peak = 0
    const result = await uploadAssets({
      client: client(async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 1))
        active--
      }),
      directory: "/tmp/project",
      files: Array.from({ length: 20 }, (_, i) => picked(`f${i}.txt`)),
    })

    expect(result.uploaded).toBe(20)
    expect(peak).toBeLessThanOrEqual(UPLOAD_CONCURRENCY)
    expect(peak).toBeGreaterThan(1)
  })

  test("stops early when aborted", async () => {
    const controller = new AbortController()
    let count = 0
    const result = await uploadAssets({
      client: client(() => {
        count++
        if (count === 2) controller.abort()
      }),
      directory: "/tmp/project",
      files: Array.from({ length: 40 }, (_, i) => picked(`f${i}.txt`)),
      signal: controller.signal,
    })

    expect(result.uploaded).toBeLessThan(40)
  })

  test("handles an empty pick", async () => {
    const result = await uploadAssets({ client: client(() => {}), directory: "/tmp/project", files: [] })
    expect(result).toEqual({ uploaded: 0, failed: [] })
  })
})

describe("isAssetPath / assetRelativePath", () => {
  test("recognizes the upload folder and its contents", () => {
    expect(isAssetPath("__assets__")).toBe(true)
    expect(isAssetPath("__assets__/a.txt")).toBe(true)
    expect(isAssetPath("__assets__/docs/spec/a.md")).toBe(true)
  })

  test("leaves the rest of the project alone", () => {
    // The delete affordance is driven by this, so a false positive here would put a trash icon on
    // the user's source files.
    expect(isAssetPath("src/index.ts")).toBe(false)
    expect(isAssetPath("__assets__x/a.txt")).toBe(false)
    expect(isAssetPath("packages/__assets__/a.txt")).toBe(false)
    expect(isAssetPath("")).toBe(false)
  })

  test("rewrites a tree path relative to the upload folder", () => {
    expect(assetRelativePath("__assets__/a.txt")).toBe("a.txt")
    expect(assetRelativePath("__assets__/docs/spec/a.md")).toBe("docs/spec/a.md")
  })

  test("maps the folder itself to the empty path, which the api reads as everything", () => {
    expect(assetRelativePath("__assets__")).toBe("")
  })

  test("returns undefined outside the folder so a delete cannot be built for it", () => {
    expect(assetRelativePath("src/index.ts")).toBeUndefined()
    expect(assetRelativePath("__assets__x/a.txt")).toBeUndefined()
  })
})

describe("assetCapacity / assetBatch / assetRefusal", () => {
  const GB = 1024 * 1024 * 1024

  function listing(usage: { count: number; bytes: number }, calls?: string[]) {
    return {
      file: {
        asset: {
          list: async ({ directory }: { directory: string }) => {
            calls?.push(directory)
            return { data: { files: [], usage, limits: { file: MAX_ASSET_BYTES, total: 2 * GB, count: 1000 } } }
          },
        },
      },
    } as any
  }

  test("reads both budgets as used-against-limit pairs", async () => {
    const calls: string[] = []
    const capacity = await assetCapacity({
      client: listing({ count: 940, bytes: GB }, calls),
      directory: "/tmp/project",
    })

    expect(capacity).toEqual({
      files: { used: 940, limit: 1000 },
      bytes: { used: GB, limit: 2 * GB },
    })
    expect(calls).toEqual(["/tmp/project"])
  })

  test("a failed listing reads as unknown, not as a full folder", async () => {
    const client = {
      file: {
        asset: {
          list: async () => {
            throw new Error("offline")
          },
        },
      },
    } as any

    // The caller must let the upload through on undefined — a flaky list request is not a reason to
    // refuse a batch the server would have accepted.
    expect(await assetCapacity({ client, directory: "/tmp/project" })).toBeUndefined()
  })

  test("weighs only the files that will actually be sent", () => {
    // The oversized one is skipped per-file during the upload, so it must not take room in the
    // budget that decides whether the rest may go at all.
    expect(assetBatch([picked("a.txt", 100), picked("big.bin", MAX_ASSET_BYTES + 1), picked("b.txt", 200)])).toEqual({
      count: 2,
      bytes: 300,
    })
  })

  test("counts a batch against what is already stored, not against the cap alone", () => {
    const capacity = { files: { used: 940, limit: 1000 }, bytes: { used: 0, limit: 2 * GB } }

    // 60 files fit on their own, but not on top of the 940 already there.
    expect(assetRefusal(capacity, { count: 60, bytes: 0 })).toBeUndefined()
    expect(assetRefusal(capacity, { count: 61, bytes: 0 })).toBe("count")
  })

  test("refuses a batch that does not fit the byte budget", () => {
    const capacity = { files: { used: 0, limit: 1000 }, bytes: { used: GB, limit: 2 * GB } }

    expect(assetRefusal(capacity, { count: 1, bytes: GB })).toBeUndefined()
    expect(assetRefusal(capacity, { count: 1, bytes: GB + 1 })).toBe("bytes")
  })

  test("names the count first when a batch breaks both budgets", () => {
    // Both are true; the file count is the one the user can act on by picking fewer files.
    const capacity = { files: { used: 1000, limit: 1000 }, bytes: { used: 2 * GB, limit: 2 * GB } }
    expect(assetRefusal(capacity, { count: 1, bytes: 1 })).toBe("count")
  })
})

describe("assetSubtree", () => {
  const listing = {
    file: {
      asset: {
        list: async () => ({
          data: {
            files: [
              { path: "a.txt", size: 10, modified: 0 },
              { path: "docs/b.md", size: 20, modified: 0 },
              { path: "docs/spec/c.md", size: 30, modified: 0 },
              { path: "docs-other/d.md", size: 40, modified: 0 },
            ],
          },
        }),
      },
    },
  } as any

  test("counts everything when the folder itself is targeted", async () => {
    expect(await assetSubtree({ client: listing, directory: "/p", relative: "" })).toEqual({ count: 4, bytes: 100 })
  })

  test("counts only the targeted subtree", async () => {
    expect(await assetSubtree({ client: listing, directory: "/p", relative: "docs" })).toEqual({ count: 2, bytes: 50 })
  })
})

describe("deleteAsset", () => {
  test("omits the path entirely when deleting everything", async () => {
    let seen: any
    const client = { file: { asset: { delete: async (p: any) => void (seen = p) } } } as any
    expect(await deleteAsset({ client, directory: "/p", relative: "" })).toBe(true)
    expect("path" in seen).toBe(false)
  })

  test("sends the path when deleting one entry", async () => {
    let seen: any
    const client = { file: { asset: { delete: async (p: any) => void (seen = p) } } } as any
    await deleteAsset({ client, directory: "/p", relative: "docs/a.md" })
    expect(seen.path).toBe("docs/a.md")
  })

  test("reports failure instead of throwing", async () => {
    const client = {
      file: {
        asset: {
          delete: async () => {
            throw new Error("boom")
          },
        },
      },
    } as any
    expect(await deleteAsset({ client, directory: "/p", relative: "a.txt" })).toBe(false)
  })
})
