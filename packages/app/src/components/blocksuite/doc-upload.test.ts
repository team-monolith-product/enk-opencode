import { describe, expect, test } from "bun:test"
import { createUploadTracker, uploadPercent } from "./doc-upload"

function harness() {
  const calls: {
    key: string
    blob: Blob
    resolve: () => void
    reject: (err: unknown) => void
    aborted: () => boolean
    progress: (loaded: number, total: number) => void
  }[] = []
  let changes = 0
  const tracker = createUploadTracker({
    upload: (key, blob, opts) =>
      new Promise<void>((resolve, reject) => {
        calls.push({
          key,
          blob,
          resolve,
          reject,
          aborted: () => opts.signal?.aborted ?? false,
          progress: (loaded, total) => opts.onProgress?.(loaded, total),
        })
        opts.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
      }),
    onChange: () => {
      changes++
    },
  })
  return { tracker, calls, changed: () => changes }
}

const file = (name = "a.png", size = 100) => new File([new Uint8Array(size)], name, { type: "image/png" })

describe("createUploadTracker", () => {
  test("an added file blocks submit until its bytes land", async () => {
    const { tracker, calls } = harness()
    tracker.start({ blockId: "b1", key: "k1", name: "a.png", blob: file() })

    expect(tracker.active()).toBe(true)
    expect(tracker.list()).toEqual([
      { blockId: "b1", key: "k1", name: "a.png", loaded: 0, total: 100, status: "uploading" },
    ])

    calls[0]!.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(tracker.active()).toBe(false)
    expect(tracker.list()).toEqual([])
  })

  test("deleting the block cancels the upload instead of finishing it", async () => {
    const { tracker, calls } = harness()
    tracker.start({ blockId: "b1", key: "k1", name: "a.png", blob: file() })

    expect(tracker.cancel("b1")).toBe(true)
    expect(calls[0]!.aborted()).toBe(true)
    // Cancelled, not failed: nothing is left blocking submit.
    expect(tracker.active()).toBe(false)
    await Promise.resolve()
    expect(tracker.list()).toEqual([])
  })

  test("undoing the delete resumes the upload from the kept blob", () => {
    const { tracker, calls } = harness()
    tracker.start({ blockId: "b1", key: "k1", name: "a.png", blob: file() })
    tracker.cancel("b1")

    expect(tracker.resume("b1", "k1")).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.key).toBe("k1")
    expect(tracker.active()).toBe(true)
  })

  test("resume ignores blocks this client never uploaded", () => {
    const { tracker, calls } = harness()
    expect(tracker.resume("b9", "someone-elses-asset")).toBe(false)
    expect(calls).toHaveLength(0)
  })

  test("progress is tracked per block, against the reported wire total", () => {
    const { tracker, calls } = harness()
    tracker.start({ blockId: "b1", key: "k1", name: "a.png", blob: file() })
    tracker.start({ blockId: "b2", key: "k2", name: "b.png", blob: file("b.png") })

    // base64 inflates the payload, so what the transport reports — not the file size — is the total.
    calls[0]!.progress(68, 136)
    expect(uploadPercent(tracker.list()[0]!)).toBe(50)
    expect(uploadPercent(tracker.list()[1]!)).toBe(0)
  })

  test("progress from a cancelled upload never resurrects it", () => {
    const { tracker, calls } = harness()
    tracker.start({ blockId: "b1", key: "k1", name: "a.png", blob: file() })
    tracker.cancel("b1")

    calls[0]!.progress(50, 100)
    expect(tracker.list()).toEqual([])
    expect(tracker.active()).toBe(false)
  })

  test("a failed upload keeps blocking submit and is marked on the block", async () => {
    const { tracker, calls } = harness()
    tracker.start({ blockId: "b1", key: "k1", name: "a.png", blob: file() })

    calls[0]!.reject(new Error("boom"))
    await Promise.resolve()
    await Promise.resolve()
    expect(tracker.list()[0]?.status).toBe("error")
    expect(tracker.active()).toBe(true)

    // Deleting the failed block is the way out.
    tracker.cancel("b1")
    expect(tracker.active()).toBe(false)
  })

  test("dispose aborts everything still in flight", () => {
    const { tracker, calls } = harness()
    tracker.start({ blockId: "b1", key: "k1", name: "a.png", blob: file() })
    tracker.start({ blockId: "b2", key: "k2", name: "b.png", blob: file("b.png") })

    tracker.dispose()
    expect(calls.map((call) => call.aborted())).toEqual([true, true])
    expect(tracker.active()).toBe(false)
  })
})

describe("uploadPercent", () => {
  test("rounds and clamps", () => {
    expect(uploadPercent({ loaded: 0, total: 0 })).toBe(0)
    expect(uploadPercent({ loaded: 1, total: 3 })).toBe(33)
    expect(uploadPercent({ loaded: 9, total: 4 })).toBe(100)
  })
})
