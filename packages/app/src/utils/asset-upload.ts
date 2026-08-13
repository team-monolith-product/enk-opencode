import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"

/**
 * Must match Assets.MAX_FILE_BYTES in packages/opencode/src/file/assets.ts. Checked here against
 * file.size (synchronous, no read) so an oversized file never gets streamed at all.
 */
export const MAX_ASSET_BYTES = 100 * 1024 * 1024

/**
 * Uploads run a few at a time: one at a time wastes the link on a folder full of small files, and
 * all at once makes the per-file progress meaningless and starves the rest of the app's requests.
 */
export const UPLOAD_CONCURRENCY = 4

/** Matches Assets.MAX_DEPTH server-side; a deeper path is rejected there, so stop walking here. */
const MAX_DEPTH = 8

/** Matches Assets.DIR server-side. File tree paths are relative to the project, so this is a prefix. */
export const ASSETS_DIR = "__assets__"

/** Whether a project-relative tree path is the upload folder itself or something inside it. */
export function isAssetPath(path: string): boolean {
  return path === ASSETS_DIR || path.startsWith(ASSETS_DIR + "/")
}

/**
 * A tree path rewritten relative to the upload folder, which is what the delete API takes.
 * Returns "" for the folder itself — the API reads that as "everything".
 */
export function assetRelativePath(path: string): string | undefined {
  if (!isAssetPath(path)) return undefined
  return path === ASSETS_DIR ? "" : path.slice(ASSETS_DIR.length + 1)
}

/** A file plus where it should land, relative to the upload folder. */
export type PickedFile = { file: File; path: string }

export type UploadFailure = { path: string; reason: "size" | "error" }

export type UploadResult = {
  uploaded: number
  failed: UploadFailure[]
}

/**
 * Files chosen through an `<input type="file">`. A folder pick (webkitdirectory) sets
 * `webkitRelativePath`, and keeping it is what makes an uploaded folder land as a folder rather
 * than a flattened pile of names.
 */
export function pickedFromInput(files: ArrayLike<File>): PickedFile[] {
  return Array.from(files).map((file) => ({
    file,
    path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
  }))
}

type Entry = {
  isFile: boolean
  isDirectory: boolean
  name: string
  file?: (cb: (file: File) => void, err: (error: unknown) => void) => void
  createReader?: () => { readEntries: (cb: (entries: Entry[]) => void, err: (error: unknown) => void) => void }
}

function entryFile(entry: Entry) {
  return new Promise<File | undefined>((resolve) => entry.file?.((file) => resolve(file), () => resolve(undefined)))
}

function entryChildren(reader: ReturnType<NonNullable<Entry["createReader"]>>) {
  return new Promise<Entry[]>((resolve) => reader.readEntries((entries) => resolve(entries), () => resolve([])))
}

async function walk(entry: Entry, prefix: string, depth: number, out: PickedFile[]) {
  if (depth > MAX_DEPTH) return
  const path = prefix ? `${prefix}/${entry.name}` : entry.name

  if (entry.isFile) {
    const file = await entryFile(entry)
    if (file) out.push({ file, path })
    return
  }
  if (!entry.isDirectory || !entry.createReader) return

  const reader = entry.createReader()
  // readEntries returns at most 100 per call and signals the end with an empty batch.
  while (true) {
    const batch = await entryChildren(reader)
    if (batch.length === 0) return
    for (const child of batch) await walk(child, path, depth + 1, out)
  }
}

/**
 * Files from a drag-and-drop, descending into any dropped folders. Dropping a folder is the natural
 * way to hand over a large corpus, and `DataTransfer.files` alone would silently yield nothing for
 * it. Falls back to the flat file list when the browser does not expose entries.
 */
export async function pickedFromDataTransfer(data: DataTransfer): Promise<PickedFile[]> {
  const entries = Array.from(data.items ?? [])
    .map((item) => (item.kind === "file" ? (item as any).webkitGetAsEntry?.() : undefined))
    .filter((entry): entry is Entry => !!entry)

  if (entries.length === 0) return pickedFromInput(data.files ?? [])

  const out: PickedFile[] = []
  for (const entry of entries) await walk(entry, "", 0, out)
  return out
}

type CreateOptions = NonNullable<Parameters<OpencodeClient["file"]["asset"]["create"]>[1]>

/**
 * The client sends `options.body` verbatim when `bodySerializer` is null, which is how the raw file
 * bytes get on the wire — but the generated option type models this operation as having no body, so
 * the shape has to be asserted. Keep this the only place that does.
 */
function requestOptions(file: File, signal?: AbortSignal): CreateOptions {
  return {
    body: file,
    bodySerializer: null,
    headers: { "content-type": "application/octet-stream" },
    signal,
  } as unknown as CreateOptions
}

type UploadInput = {
  client: OpencodeClient
  /** Which workspace to store into. Passed explicitly, the same way doc asset uploads do it. */
  directory: string
  files: PickedFile[]
  /** Called after each file settles, so the caller can show "3/40" without knowing the queue. */
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

/**
 * Stores files in the upload folder without involving the model. Never throws: a failed file is
 * reported in `failed` so one bad file in a folder of 200 does not discard the other 199.
 */
export async function uploadAssets(input: UploadInput): Promise<UploadResult> {
  const queue = input.files
  const failed: UploadFailure[] = []
  let uploaded = 0
  let done = 0
  let next = 0

  const worker = async () => {
    while (true) {
      if (input.signal?.aborted) return
      const index = next++
      const item = queue[index]
      if (!item) return

      if (item.file.size > MAX_ASSET_BYTES) {
        failed.push({ path: item.path, reason: "size" })
      } else {
        try {
          await input.client.file.asset.create(
            // `body` here only satisfies the generated parameter type — the method maps parameters
            // to query values and drops it. The request body is the one in the options below.
            { path: item.path, directory: input.directory, body: item.file },
            requestOptions(item.file, input.signal),
          )
          uploaded++
        } catch {
          failed.push({ path: item.path, reason: "error" })
        }
      }

      done++
      input.onProgress?.(done, queue.length)
    }
  }

  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, worker))
  return { uploaded, failed }
}

/** What a delete would remove, for the confirmation the caller shows before a folder delete. */
export type AssetSubtree = { count: number; bytes: number }

/**
 * Counts what lives under `relative` (the folder's own path, or "" for the whole upload folder).
 * The delete API takes a path, not a manifest, so the numbers a confirmation quotes have to be
 * read back from the server rather than guessed from the tree.
 */
export async function assetSubtree(input: {
  client: OpencodeClient
  directory: string
  relative: string
}): Promise<AssetSubtree> {
  const res = await input.client.file.asset.list({ directory: input.directory })
  const files = res.data?.files ?? []
  const prefix = input.relative ? input.relative + "/" : ""
  return files
    .filter((file) => file.path.startsWith(prefix))
    .reduce<AssetSubtree>((acc, file) => ({ count: acc.count + 1, bytes: acc.bytes + file.size }), {
      count: 0,
      bytes: 0,
    })
}

/**
 * Removes one uploaded file or folder, or everything when `relative` is "". Returns false instead
 * of throwing so a failed delete can be surfaced as a toast without unwinding the caller.
 */
export async function deleteAsset(input: {
  client: OpencodeClient
  directory: string
  relative: string
}): Promise<boolean> {
  try {
    await input.client.file.asset.delete({
      directory: input.directory,
      // Omitted entirely rather than sent empty: the API distinguishes "no path" (everything) from
      // a path it would have to validate.
      ...(input.relative ? { path: input.relative } : {}),
    })
    return true
  } catch {
    return false
  }
}
