import { describe, expect, test } from "bun:test"
import {
  createMissingRegistry,
  createStoredSeed,
  createUploadTracker,
  missingMarks,
  paintUploads,
  stranded,
  uploadPercent,
} from "./doc-upload"

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

describe("createStoredSeed", () => {
  test("asks the server once, however many files are attached", async () => {
    let asks = 0
    const marked: string[] = []
    const seed = createStoredSeed({
      list: async () => {
        asks++
        return ["k1", "k2"]
      },
      markStored: (key) => marked.push(key),
    })

    await Promise.all([seed(), seed()])
    await seed()

    expect(asks).toBe(1)
    expect(marked).toEqual(["k1", "k2"])
  })

  test("never asks until the first attachment", () => {
    let asks = 0
    createStoredSeed({
      list: async () => {
        asks++
        return []
      },
      markStored: () => {},
    })
    // Building the editor must not cost a round trip — most of them never see an attachment, and the
    // doc each send rotates to is empty by construction.
    expect(asks).toBe(0)
  })

  test("a failed query resolves, leaving the upload to send bytes it may not need to", async () => {
    const seed = createStoredSeed({
      list: () => Promise.reject(new Error("offline")),
      markStored: () => {
        throw new Error("nothing to mark")
      },
    })

    // Resolves rather than rejecting: not knowing must not fail the attach.
    expect(await seed().then(() => "resolved")).toBe("resolved")
  })
})

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

  test("the same file attached again mid-upload rides the request already in flight", () => {
    const { tracker, calls } = harness()
    tracker.start({ blockId: "b1", key: "k1", name: "a.png", blob: file() })
    tracker.start({ blockId: "b2", key: "k1", name: "a.png", blob: file() })

    expect(calls).toHaveLength(1)
    // Both blocks are still tracked — each shows a bar, and submit stays gated for both.
    calls[0]!.progress(60, 120)
    expect(tracker.list().map((item) => [item.blockId, uploadPercent(item)])).toEqual([
      ["b1", 50],
      ["b2", 50],
    ])
  })

  test("one landed upload settles every block that attached the same file", async () => {
    const { tracker, calls } = harness()
    tracker.start({ blockId: "b1", key: "k1", name: "a.png", blob: file() })
    tracker.start({ blockId: "b2", key: "k1", name: "a.png", blob: file() })

    calls[0]!.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(tracker.list()).toEqual([])
    expect(tracker.active()).toBe(false)
  })

  test("re-attaching a file already on the server uploads nothing", async () => {
    const { tracker, calls } = harness()
    tracker.start({ blockId: "b1", key: "k1", name: "a.png", blob: file() })
    calls[0]!.resolve()
    await Promise.resolve()
    await Promise.resolve()

    tracker.start({ blockId: "b2", key: "k1", name: "a.png", blob: file() })
    expect(calls).toHaveLength(1)
    expect(tracker.active()).toBe(false)
    // ...and an undo that brings such a block back has nothing to resume either.
    expect(tracker.resume("b3", "k1")).toBe(false)
    expect(calls).toHaveLength(1)
  })

  test("a file the doc already carried uploads nothing on a fresh tracker", () => {
    // What a reload/session switch leaves behind: the editor (and its tracker) is rebuilt, so the
    // asset of a block already in the doc was never uploaded by THIS tracker. Seeded, it still counts
    // as stored and re-attaching the same file sends no bytes.
    const { tracker, calls } = harness()
    tracker.markStored("k1")

    tracker.start({ blockId: "b1", key: "k1", name: "a.png", blob: file() })
    expect(calls).toHaveLength(0)
    expect(tracker.active()).toBe(false)
    // ...and an undo that brings such a block back has nothing to resume either.
    expect(tracker.resume("b2", "k1")).toBe(false)
    expect(calls).toHaveLength(0)
  })

  test("a seeded key leaves an unrelated file's upload alone", () => {
    const { tracker, calls } = harness()
    tracker.markStored("k1")

    tracker.start({ blockId: "b1", key: "k2", name: "b.png", blob: file("b.png") })
    expect(calls.map((call) => call.key)).toEqual(["k2"])
    expect(tracker.active()).toBe(true)
  })

  test("deleting the block that was uploading hands the bytes to its twin", () => {
    const { tracker, calls } = harness()
    tracker.start({ blockId: "b1", key: "k1", name: "a.png", blob: file() })
    tracker.start({ blockId: "b2", key: "k1", name: "a.png", blob: file() })

    tracker.cancel("b1")
    expect(calls[0]!.aborted()).toBe(true)
    // The surviving block still needs the file, so it takes the upload over.
    expect(calls).toHaveLength(2)
    expect(calls[1]!.key).toBe("k1")
    expect(tracker.list().map((item) => item.blockId)).toEqual(["b2"])
    expect(tracker.active()).toBe(true)
  })

  test("deleting the twin leaves the upload alone", () => {
    const { tracker, calls } = harness()
    tracker.start({ blockId: "b1", key: "k1", name: "a.png", blob: file() })
    tracker.start({ blockId: "b2", key: "k1", name: "a.png", blob: file() })

    tracker.cancel("b2")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.aborted()).toBe(false)
    expect(tracker.list().map((item) => item.blockId)).toEqual(["b1"])
  })

  test("a failed upload marks every block waiting on those bytes", async () => {
    const { tracker, calls } = harness()
    tracker.start({ blockId: "b1", key: "k1", name: "a.png", blob: file() })
    tracker.start({ blockId: "b2", key: "k1", name: "a.png", blob: file() })

    calls[0]!.reject(new Error("boom"))
    await Promise.resolve()
    await Promise.resolve()
    expect(tracker.list().map((item) => item.status)).toEqual(["error", "error"])

    // Deleting the failed block retries on the twin rather than dropping the file silently.
    tracker.cancel("b1")
    expect(calls).toHaveLength(2)
    expect(tracker.list().map((item) => [item.blockId, item.status])).toEqual([["b2", "uploading"]])
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

describe("missingMarks", () => {
  test("wears the same error state as a failed upload", () => {
    const editor = document.createElement("div")
    const block = document.createElement("div")
    block.dataset.blockId = "b1"
    editor.append(block)

    paintUploads(editor, missingMarks([{ blockId: "b1", key: "k1", name: "a.png" }]))

    expect(block.dataset.ocUpload).toBe("error")
    expect(block.dataset.ocUploadLabel).toBe("!")
    // A full-width bar, not a 0% sliver: nothing is in progress here, the attachment is dead.
    expect(block.style.getPropertyValue("--oc-upload")).toBe("100%")
  })

  test("clears once the block is no longer stranded", () => {
    const editor = document.createElement("div")
    const block = document.createElement("div")
    block.dataset.blockId = "b1"
    editor.append(block)

    paintUploads(editor, missingMarks([{ blockId: "b1", key: "k1", name: "a.png" }]))
    paintUploads(editor, [])

    expect(block.dataset.ocUpload).toBeUndefined()
  })
})

describe("stranded", () => {
  const blocks = [
    { blockId: "b1", key: "k1", name: "a.png" },
    { blockId: "b2", key: "k2", name: "b.png" },
  ]

  test("names the blocks whose bytes the server does not have", () => {
    expect(stranded(blocks, new Set(["k2"]))).toEqual([{ blockId: "b2", key: "k2", name: "b.png" }])
  })

  test("an asset still uploading is not stranded", () => {
    // The uploader's own client never gets here (it renders from its local blob), but a collaborator
    // 404s on every block the moment it arrives — right up until the bytes land.
    expect(stranded(blocks, new Set(["k1", "k2"]), ["k1"])).toEqual([
      { blockId: "b2", key: "k2", name: "b.png" },
    ])
  })

  test("deleting the block clears the mark without clearing the 404", () => {
    expect(stranded([], new Set(["k1"]))).toEqual([])
  })

  test("every block on the same dead asset is stranded", () => {
    const twins = [
      { blockId: "b1", key: "k1", name: "a.png" },
      { blockId: "b2", key: "k1", name: "copy.png" },
    ]
    expect(stranded(twins, new Set(["k1"])).map((item) => item.blockId)).toEqual(["b1", "b2"])
  })

  test("a block with no asset id yet is nobody's problem", () => {
    expect(stranded([{ blockId: "b1", name: "a.png" }], new Set(["k1"]))).toEqual([])
  })
})

describe("createMissingRegistry", () => {
  // refresh() defers past the event that triggered it, so assertions have to let the microtask run.
  const tick = () => Promise.resolve()

  const harness = () => {
    let blocks: Array<{ blockId: string; key?: string; name: string }> = [{ blockId: "b1", key: "k1", name: "a.png" }]
    let uploading: string[] = []
    let changes = 0
    const registry = createMissingRegistry({
      blocks: () => blocks,
      uploading: () => uploading,
      onChange: () => {
        changes++
      },
    })
    return {
      registry,
      changed: () => changes,
      setBlocks: (next: typeof blocks) => {
        blocks = next
      },
      setUploading: (next: string[]) => {
        uploading = next
      },
    }
  }

  test("a 404 strands the block that references it", () => {
    const h = harness()
    h.registry.mark("k1", true)
    expect(h.registry.list()).toEqual([{ blockId: "b1", key: "k1", name: "a.png" }])
    expect(h.changed()).toBe(1)
  })

  test("deleting the block clears the gate", async () => {
    const h = harness()
    h.registry.mark("k1", true)
    // Deleting is the user's only way out — the asset is still 404, so nothing re-marks it and the
    // gate would stay shut forever if the doc changing did not count as a change.
    h.setBlocks([])
    h.registry.refresh()
    await tick()
    expect(h.registry.list()).toEqual([])
    expect(h.changed()).toBe(2)
  })

  test("a refresh reads the doc after the event that triggered it", async () => {
    const h = harness()
    h.registry.mark("k1", true)
    // BlockSuite fires its delete event BEFORE the block leaves the doc, so this is what the handler
    // actually sees: refresh() first, block gone only afterwards. Recomputing on the spot would find
    // nothing changed and never reopen submit.
    h.registry.refresh()
    h.setBlocks([])
    await tick()
    expect(h.changed()).toBe(2)
  })

  test("a multi-block delete recomputes once", async () => {
    const h = harness()
    h.registry.mark("k1", true)
    h.setBlocks([])
    h.registry.refresh()
    h.registry.refresh()
    h.registry.refresh()
    await tick()
    expect(h.changed()).toBe(2)
  })

  test("undo brings the stranded block back", async () => {
    const h = harness()
    h.registry.mark("k1", true)
    h.setBlocks([])
    h.registry.refresh()
    await tick()
    h.setBlocks([{ blockId: "b2", key: "k1", name: "a.png" }])
    h.registry.refresh()
    await tick()
    expect(h.registry.list()).toEqual([{ blockId: "b2", key: "k1", name: "a.png" }])
    expect(h.changed()).toBe(3)
  })

  test("an upload starting and landing moves the block in and out on its own", async () => {
    const h = harness()
    h.registry.mark("k1", true)
    h.setUploading(["k1"])
    h.registry.refresh()
    await tick()
    expect(h.registry.list()).toEqual([])

    // The upload landed: the source reports the bytes are there now.
    h.setUploading([])
    h.registry.mark("k1", false)
    expect(h.registry.list()).toEqual([])
  })

  test("a doc change that does not move the answer says nothing", async () => {
    const h = harness()
    h.registry.refresh()
    h.registry.refresh()
    await tick()
    expect(h.changed()).toBe(0)

    h.registry.mark("k1", true)
    h.setBlocks([{ blockId: "b1", key: "k1", name: "a.png" }, { blockId: "b2", name: "typed text" }])
    h.registry.refresh()
    await tick()
    expect(h.changed()).toBe(1)
  })

  test("a recompute queued past teardown never reports", async () => {
    const h = harness()
    h.registry.mark("k1", true)
    h.setBlocks([])
    h.registry.refresh()
    h.registry.dispose()
    await tick()
    // The editor is gone; its replacement owns the answer now.
    expect(h.changed()).toBe(1)
  })

  test("marking the same answer twice is not a change", () => {
    const h = harness()
    h.registry.mark("k1", true)
    h.registry.mark("k1", true)
    expect(h.changed()).toBe(1)
  })
})
