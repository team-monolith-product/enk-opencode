import type { BlobUploadOpts } from "./opencode-doc-source"

export type DocUploadStatus = "uploading" | "error"

export type DocUpload = {
  /** Block the file was attached to — the handle for both progress paint and cancellation. */
  blockId: string
  /** Asset id (the block's sourceId). */
  key: string
  name: string
  loaded: number
  total: number
  status: DocUploadStatus
}

type Entry = DocUpload & {
  blob: Blob
  /**
   * The request carrying these bytes. Undefined on a *follower* — a block that attached a file
   * another block is already uploading, and so rides that request instead of sending it twice.
   */
  controller?: AbortController
}

/**
 * A block whose asset the server does not have, with nothing uploading it.
 *
 * This is what an upload that was abandoned mid-transfer leaves behind: `addFile` inserts the block
 * first and starts the upload second, so leaving (tab close, session switch, unmount) aborts the
 * bytes while the block — already replicated through yjs — stays in the doc. Nothing in the upload
 * tracker survives that, so the mark has to come from asking the server instead.
 */
export type DocMissing = {
  blockId: string
  /** Asset id (the block's sourceId). */
  key: string
  name: string
}

/** Missing assets as paint marks, so a dead attachment wears the same error state as a failed upload. */
export function missingMarks(list: DocMissing[]): DocUpload[] {
  return list.map((item) => ({ ...item, loaded: 0, total: 0, status: "error" as const }))
}

/**
 * The doc's attachment blocks that are stranded on an asset the server answered 404 for.
 *
 * Driven by the doc rather than by the 404 set, so deleting the block is all it takes to clear the
 * mark. Assets an upload is still working on are left out: they are already covered by the upload
 * gate, and a *collaborator's* in-flight upload legitimately 404s here right up until it lands.
 */
export function stranded(
  blocks: Array<{ blockId: string; key?: string; name: string }>,
  absent: ReadonlySet<string>,
  uploading: Iterable<string> = [],
): DocMissing[] {
  if (absent.size === 0) return []
  const busy = new Set(uploading)
  const out: DocMissing[] = []
  for (const block of blocks) {
    const key = block.key
    if (!key || busy.has(key) || !absent.has(key)) continue
    out.push({ blockId: block.blockId, key, name: block.name })
  }
  return out
}

export type MissingRegistryInput = {
  /** The doc's attachment blocks, read fresh on every query rather than cached. */
  blocks: () => Array<{ blockId: string; key?: string; name: string }>
  /** Asset ids an upload is still working on. */
  uploading: () => Iterable<string>
  /** Fired when the answer to "which blocks are stranded?" actually changes. */
  onChange: () => void
}

/**
 * Which of the doc's attachments the server does not have.
 *
 * Two things move the answer and neither can be inferred from the other: what the server says about
 * an asset (`mark`, from a fetch or an export), and which blocks the doc currently holds (`refresh`,
 * from a block being added or deleted). Missing the second is what leaves a deleted block still
 * blocking submit — the mark is keyed by asset, but the gate is a question about blocks.
 */
export function createMissingRegistry(input: MissingRegistryInput) {
  const absent = new Set<string>()
  let last = ""
  let queued = false
  let dead = false

  const list = () => stranded(input.blocks(), absent, input.uploading())

  // Block changes are frequent and mostly irrelevant here, so the emit is gated on the answer
  // actually differing rather than on something having happened.
  const settle = () => {
    if (dead) return
    const next = list()
      .map((item) => `${item.blockId}:${item.key}`)
      .join("|")
    if (next === last) return
    last = next
    input.onChange()
  }

  return {
    list,
    /** Fold in what a fetch — or an export — just learned about an asset's presence on the server. */
    mark: (key: string, gone: boolean) => {
      if (gone === absent.has(key)) return
      if (gone) absent.add(key)
      else absent.delete(key)
      settle()
    },
    /**
     * The doc changed. Deleting the stranded block is how a user clears this, so it has to count.
     *
     * Deferred, because BlockSuite fires `blockUpdated` for a deletion *before* the block leaves the
     * doc: reading the block list from inside that handler still returns the block being deleted, so
     * a synchronous recompute would see no change and stay silent — leaving submit blocked on a
     * block the user just removed. Coalesced, so a multi-block delete recomputes once.
     */
    refresh: () => {
      if (queued || dead) return
      queued = true
      queueMicrotask(() => {
        queued = false
        settle()
      })
    },
    /** Editor torn down — a recompute already queued must not report into the replacement. */
    dispose: () => {
      dead = true
    },
  }
}

export type UploadTrackerInput = {
  upload: (key: string, blob: Blob, opts: BlobUploadOpts) => Promise<unknown>
  onChange: () => void
}

/**
 * Tracks the in-flight attachment uploads of one prompt doc.
 *
 * The block is created before its bytes are on the server, so every upload here is a promise the
 * prompt cannot be sent without: `active()` gates submit. Deleting the block cancels the upload
 * (abort, not "upload anyway and throw the result away"), and undoing that deletion resumes it from
 * the blob we kept.
 *
 * Asset ids are content hashes, so the same file attached twice is the same asset: its bytes are
 * sent once. A second block whose asset is already stored has nothing to upload at all, and one
 * whose asset is still on the wire follows that request — sharing its progress, and taking it over
 * if the block that started it is deleted mid-flight.
 */
export function createUploadTracker(input: UploadTrackerInput) {
  const entries = new Map<string, Entry>()
  // Blobs of cancelled/finished uploads, kept so an undo that brings the block back can re-upload
  // without asking the user to pick the file again. Keyed by asset id: undo may restore the block
  // under a fresh id, but the sourceId it carries is the one we uploaded under.
  const blobs = new Map<string, { name: string; blob: Blob }>()
  // Assets whose bytes are on the server: uploads that landed here, plus whatever the caller seeded
  // via markStored(). Nothing removes them: the asset store is per doc and never deletes, so
  // re-attaching one of these files is a no-op upload.
  const stored = new Set<string>()

  const emit = () => input.onChange()

  const sharing = (key: string) => Array.from(entries.values()).filter((entry) => entry.key === key)

  /** The entry actually sending `key`'s bytes right now, if any. */
  const sender = (key: string) =>
    sharing(key).find((entry) => entry.controller && entry.status === "uploading")

  const run = (entry: Entry) => {
    const controller = new AbortController()
    entry.controller = controller
    entries.set(entry.blockId, entry)
    emit()
    input
      .upload(entry.key, entry.blob, {
        signal: controller.signal,
        onProgress: (loaded, total) => {
          if (entries.get(entry.blockId) !== entry) return
          // Followers show the same bar: it is their bytes too, on one request.
          for (const item of sharing(entry.key)) {
            item.loaded = loaded
            if (total > 0) item.total = total
          }
          emit()
        },
      })
      .then(() => {
        stored.add(entry.key)
        if (entries.get(entry.blockId) !== entry) return
        // One landed upload settles every block that attached the same file.
        for (const item of sharing(entry.key)) entries.delete(item.blockId)
        emit()
      })
      .catch(() => {
        // A cancelled upload is not a failure — the block (and this entry) is already gone.
        if (entries.get(entry.blockId) !== entry) return
        if (controller.signal.aborted) {
          entries.delete(entry.blockId)
          emit()
          return
        }
        // Nothing landed, so every block waiting on these bytes is stuck, not just this one.
        for (const item of sharing(entry.key)) item.status = "error"
        emit()
      })
  }

  /** Abort this entry's request; a block that was riding it takes the bytes over instead. */
  const drop = (entry: Entry) => {
    const controller = entry.controller
    if (!controller) return
    const next = sharing(entry.key).find((item) => item !== entry && !item.controller)
    entry.controller = undefined
    controller.abort()
    if (!next) return
    next.loaded = 0
    next.status = "uploading"
    run(next)
  }

  const start = (item: { blockId: string; key: string; name: string; blob: Blob }) => {
    const current = entries.get(item.blockId)
    if (current) {
      if (current.key === item.key) return
      entries.delete(item.blockId)
      drop(current)
    }
    blobs.set(item.key, { name: item.name, blob: item.blob })

    // Already on the server — the block can render from the asset store as it stands.
    if (stored.has(item.key)) {
      emit()
      return
    }

    const entry: Entry = {
      blockId: item.blockId,
      key: item.key,
      name: item.name,
      loaded: 0,
      total: item.blob.size,
      status: "uploading",
      blob: item.blob,
    }

    // Same bytes already going up: follow that request rather than sending a second copy.
    const live = sender(item.key)
    if (live) {
      entry.loaded = live.loaded
      entry.total = live.total
      entries.set(entry.blockId, entry)
      emit()
      return
    }

    run(entry)
  }

  /** Block removed (delete or undo) — stop uploading rather than finishing a file nobody will send. */
  const cancel = (blockId: string) => {
    const entry = entries.get(blockId)
    if (!entry) return false
    entries.delete(blockId)
    drop(entry)
    emit()
    return true
  }

  /** Block came back (undo of a delete): re-upload from the blob we kept, if it never landed. */
  const resume = (blockId: string, key: string) => {
    if (entries.has(blockId)) return false
    if (stored.has(key)) return false
    const kept = blobs.get(key)
    if (!kept) return false
    start({ blockId, key, name: kept.name, blob: kept.blob })
    return true
  }

  const list = (): DocUpload[] =>
    Array.from(entries.values(), (entry) => ({
      blockId: entry.blockId,
      key: entry.key,
      name: entry.name,
      loaded: entry.loaded,
      total: entry.total,
      status: entry.status,
    }))

  return {
    start,
    cancel,
    resume,
    list,
    /**
     * Record an asset as already on the server without uploading it.
     *
     * A tracker only learns a key from an upload IT ran, and it is rebuilt with the editor — so on a
     * fresh mount (reload, session switch) every asset the doc already carries looks unknown, and
     * re-attaching one of those files would send its bytes a second time. The caller seeds those keys
     * here. Only for assets whose bytes are known to have landed: a key marked stored is one nothing
     * will ever upload, so marking one that is still on the wire would leave the doc referencing an
     * asset the server does not have.
     */
    markStored: (key: string) => {
      stored.add(key)
    },
    /** True while any upload is still in flight or failed — the prompt must not be sent yet. */
    active: () => entries.size > 0,
    dispose: () => {
      for (const entry of entries.values()) entry.controller?.abort()
      entries.clear()
      blobs.clear()
      stored.clear()
    },
  }
}

export function uploadPercent(item: { loaded: number; total: number }) {
  if (item.total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((item.loaded / item.total) * 100)))
}

/**
 * Paint the in-flight uploads onto their blocks.
 *
 * BlockSuite owns the inside of an attachment/image block (Lit re-renders it on every doc change),
 * so the progress bar lives on the block host as a data attribute + CSS variable and is drawn by
 * pseudo-elements in blocksuite-doc.css. Re-applying is idempotent, so this can be called from a
 * MutationObserver as freely as from a progress event.
 */
export function paintUploads(editor: HTMLElement, list: DocUpload[]) {
  const live = new Set<string>()
  for (const item of list) {
    const el = editor.querySelector(`[data-block-id="${CSS.escape(item.blockId)}"]`)
    if (!(el instanceof HTMLElement)) continue
    live.add(item.blockId)
    const percent = uploadPercent(item)
    if (el.dataset.ocUpload !== item.status) el.dataset.ocUpload = item.status
    const label = item.status === "error" ? "!" : `${percent}%`
    if (el.dataset.ocUploadLabel !== label) el.dataset.ocUploadLabel = label
    el.style.setProperty("--oc-upload", `${item.status === "error" ? 100 : percent}%`)
  }
  for (const node of editor.querySelectorAll("[data-oc-upload]")) {
    if (!(node instanceof HTMLElement)) continue
    const id = node.dataset.blockId
    if (id && live.has(id)) continue
    delete node.dataset.ocUpload
    delete node.dataset.ocUploadLabel
    node.style.removeProperty("--oc-upload")
  }
}
