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
  controller: AbortController
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
 */
export function createUploadTracker(input: UploadTrackerInput) {
  const entries = new Map<string, Entry>()
  // Blobs of cancelled/finished uploads, kept so an undo that brings the block back can re-upload
  // without asking the user to pick the file again. Keyed by asset id: undo may restore the block
  // under a fresh id, but the sourceId it carries is the one we uploaded under.
  const blobs = new Map<string, { name: string; blob: Blob }>()

  const emit = () => input.onChange()

  const run = (entry: Entry) => {
    entries.set(entry.blockId, entry)
    emit()
    input
      .upload(entry.key, entry.blob, {
        signal: entry.controller.signal,
        onProgress: (loaded, total) => {
          if (entries.get(entry.blockId) !== entry) return
          entry.loaded = loaded
          if (total > 0) entry.total = total
          emit()
        },
      })
      .then(() => {
        if (entries.get(entry.blockId) !== entry) return
        entries.delete(entry.blockId)
        emit()
      })
      .catch(() => {
        // A cancelled upload is not a failure — the block (and this entry) is already gone.
        if (entries.get(entry.blockId) !== entry) return
        if (entry.controller.signal.aborted) {
          entries.delete(entry.blockId)
          emit()
          return
        }
        entry.status = "error"
        emit()
      })
  }

  const start = (item: { blockId: string; key: string; name: string; blob: Blob }) => {
    const current = entries.get(item.blockId)
    if (current) {
      if (current.key === item.key) return
      current.controller.abort()
    }
    blobs.set(item.key, { name: item.name, blob: item.blob })
    run({
      blockId: item.blockId,
      key: item.key,
      name: item.name,
      loaded: 0,
      total: item.blob.size,
      status: "uploading",
      blob: item.blob,
      controller: new AbortController(),
    })
  }

  /** Block removed (delete or undo) — stop uploading rather than finishing a file nobody will send. */
  const cancel = (blockId: string) => {
    const entry = entries.get(blockId)
    if (!entry) return false
    entries.delete(blockId)
    entry.controller.abort()
    emit()
    return true
  }

  /** Block came back (undo of a delete): re-upload from the blob we kept, if it never landed. */
  const resume = (blockId: string, key: string) => {
    if (entries.has(blockId)) return false
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
    /** True while any upload is still in flight or failed — the prompt must not be sent yet. */
    active: () => entries.size > 0,
    dispose: () => {
      for (const entry of entries.values()) entry.controller.abort()
      entries.clear()
      blobs.clear()
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
