import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createSignal, Show } from "solid-js"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import {
  ASSETS_DIR,
  assetBatch,
  assetCapacity,
  assetRefusal,
  assetRelativePath,
  assetSubtree,
  deleteAsset,
  deleteProjectPath,
  pickedFromDataTransfer,
  pickedFromInput,
  uploadAssets,
  type PickedFile,
} from "@/utils/asset-upload"

/**
 * Uploading into the `__assets__` folder: the bytes are stored as-is and the model never sees them
 * until it reads one. This is the path for a large corpus — prompt attachments are re-billed on
 * every step of every turn, so they cap out at ten files (see @/constants/file-picker).
 */
export function createAssetUpload(options?: { onDeleted?: (path: string) => void }) {
  const sdk = useSDK()
  const file = useFile()
  const language = useLanguage()
  const dialog = useDialog()

  const [progress, setProgress] = createSignal<{ done: number; total: number }>()
  const [checking, setChecking] = createSignal(false)
  const [dragging, setDragging] = createSignal(false)

  // The capacity read happens before there is a count to show, so it cannot use `progress` — but it
  // still has to disable the pickers and the drop zone, or a second batch lands mid-check.
  const uploading = () => !!progress() || checking()

  /**
   * Re-lists the folders above the given project paths. The tree otherwise only follows the file
   * watcher, and a batch is where a watcher event is most likely to be missing: the deferred
   * subscription window, a disabled watcher, or a folder whose name the watcher ignores (`build`,
   * `dist`, `logs` … see FileIgnore.PATTERNS) all leave the change invisible until the user
   * collapses and reopens the folder.
   */
  const refreshParents = (paths: string[]) => {
    const dirs = new Set<string>([""])
    for (const path of paths) {
      // The last segment is the file or folder itself; what needs re-listing is every folder above.
      const parts = path.split("/").slice(0, -1)
      for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"))
    }
    for (const dir of dirs) {
      // Only folders the tree has actually listed. The server sanitizes names, so a path derived
      // from what was sent may not be the one on disk, and listing that would only add a phantom
      // empty folder to the tree.
      if (!file.tree.state(dir)?.loaded) continue
      void file.tree.refresh(dir)
    }
  }

  const refreshTree = (relatives: string[]) => refreshParents(relatives.map((relative) => `${ASSETS_DIR}/${relative}`))

  const run = async (files: PickedFile[]) => {
    if (files.length === 0) return
    // A second batch while one is in flight would make the counter meaningless; the picker and the
    // drop zone are both disabled while uploading, so this only catches a race.
    if (uploading()) return

    // The folder's caps are the server's, and it rejects one upload at a time: a batch past them
    // would send every file, store some arbitrary prefix of them and fail the rest with nothing to
    // say why. So the batch is weighed first and refused whole — an over-cap pick uploads nothing.
    const batch = assetBatch(files)
    // Nothing left to weigh once the oversized files are set aside; uploadAssets reports each one.
    if (batch.count > 0) {
      setChecking(true)
      const capacity = await assetCapacity({ client: sdk.client, directory: sdk.directory })
      setChecking(false)
      // An unreadable capacity is not a full folder: fall through and let the server have the say.
      const refusal = capacity && assetRefusal(capacity, batch)
      if (refusal) {
        showToast(
          refusal === "count"
            ? {
                title: language.t("session.files.upload.tooMany.title"),
                description: language.t("session.files.upload.tooMany.description", {
                  limit: capacity.files.limit.toLocaleString(),
                  used: capacity.files.used.toLocaleString(),
                  selected: batch.count.toLocaleString(),
                }),
              }
            : {
                title: language.t("session.files.upload.full.title"),
                description: language.t("session.files.upload.full.description", {
                  limit: formatBytes(capacity.bytes.limit),
                  used: formatBytes(capacity.bytes.used),
                  selected: formatBytes(batch.bytes),
                }),
              },
        )
        return
      }
    }

    // No await between the check and the upload, so the disabled state never lapses in between.
    setProgress({ done: 0, total: files.length })
    const result = await uploadAssets({
      client: sdk.client,
      directory: sdk.directory,
      files,
      onProgress: (done, total) => setProgress({ done, total }),
    })
    setProgress(undefined)
    refreshTree(files.map((item) => item.path))

    if (result.failed.length === 0) {
      showToast({
        title: language.t("session.files.upload.done", { count: result.uploaded.toLocaleString() }),
      })
      return
    }

    const tooLarge = result.failed.filter((item) => item.reason === "size").length
    showToast({
      title: language.t("session.files.upload.partial", {
        count: result.uploaded.toLocaleString(),
        failed: result.failed.length.toLocaleString(),
      }),
      description: tooLarge > 0 ? language.t("session.files.upload.tooLarge") : undefined,
    })
  }

  /**
   * Handlers for the explorer's drop zone. The element must also carry `data-drop-zone` so the
   * composer's document-level capture listener leaves the drop alone (see prompt-input/attachments).
   */
  const drop = {
    "data-drop-zone": true,
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return
      event.preventDefault()
      if (!uploading()) setDragging(true)
    },
    onDragLeave: (event: DragEvent) => {
      if (event.relatedTarget && event.currentTarget instanceof Node) {
        // Moving between children of the zone is not a leave.
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
      }
      setDragging(false)
    },
    onDrop: async (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return
      event.preventDefault()
      event.stopPropagation()
      setDragging(false)
      if (uploading()) return
      await run(await pickedFromDataTransfer(event.dataTransfer))
    },
  }

  const notifyDeleted = (ok: boolean, path: string, label: string) => {
    if (ok) options?.onDeleted?.(path)
    showToast(
      ok
        ? { title: language.t("session.files.delete.done", { name: label }) }
        : { title: language.t("common.requestFailed") },
    )
  }

  const removeNow = async (relative: string, node: FileNode) => {
    const ok = await deleteAsset({ client: sdk.client, directory: sdk.directory, relative })
    refreshTree([relative])
    notifyDeleted(ok, node.path, node.name)
  }

  const removeProjectNode = async (node: FileNode) => {
    const ok = await deleteProjectPath({ client: sdk.client, directory: sdk.directory, path: node.path })
    refreshParents([node.path])
    notifyDeleted(ok, node.path, node.name)
  }

  /**
   * An uploaded file goes immediately — it is one thing the user just pointed at. A folder (including
   * the upload folder itself, which is "delete everything") asks first, because the row gives no
   * hint of how much is underneath it. Everything outside the upload folder is the project's own
   * work and may not be in git yet, so it always asks.
   */
  const remove = async (node: FileNode) => {
    const relative = assetRelativePath(node.path)
    if (relative === undefined) {
      dialog.show(() => (
        <FileDeleteDialog
          title={language.t("session.files.delete.confirm.title", { name: node.name })}
          description={language.t(
            node.type === "file"
              ? "session.files.delete.confirm.body.file"
              : "session.files.delete.confirm.body.folder",
          )}
          onConfirm={() => removeProjectNode(node)}
        />
      ))
      return
    }

    if (node.type === "file") {
      await removeNow(relative, node)
      return
    }

    const subtree = await assetSubtree({ client: sdk.client, directory: sdk.directory, relative })
    dialog.show(() => (
      <FileDeleteDialog
        // Deleting the upload folder is "delete everything"; naming the folder there would make the
        // user translate an internal name into what is about to happen.
        title={
          node.path === ASSETS_DIR
            ? language.t("session.files.delete.confirm.title.all")
            : language.t("session.files.delete.confirm.title", { name: node.name })
        }
        description={language.t("session.files.delete.confirm.body", {
          count: subtree.count.toLocaleString(),
          size: formatBytes(subtree.bytes),
        })}
        onConfirm={() => removeNow(relative, node)}
      />
    ))
  }

  return { run, progress, uploading, dragging, drop, remove }
}

/**
 * Chrome follows DialogEnvKeys (title / description / footer rhythm, see .asset-delete-dialog in
 * index.css) so the two modals read as one product rather than two.
 */
function FileDeleteDialog(props: { title: string; description: string; onConfirm: () => void }) {
  const dialog = useDialog()
  const language = useLanguage()

  return (
    <Dialog
      title={props.title}
      description={props.description}
      action={<span class="sr-only" />}
      transition
      fit
      class="asset-delete-dialog"
    >
      <div class="asset-delete-footer">
        <div class="flex-1" />
        <Button type="button" size="normal" variant="secondary" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </Button>
        <Button
          type="button"
          size="normal"
          variant="primary"
          autofocus
          onClick={() => {
            dialog.close()
            props.onConfirm()
          }}
        >
          {language.t("session.files.delete.confirm.action")}
        </Button>
      </div>
    </Dialog>
  )
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024).toLocaleString()} KB`
  // GB matters here: the folder's own cap is measured in them, and "2,048 MB" names it badly.
  if (bytes < 1024 * 1024 * 1024) return `${(Math.round((bytes / (1024 * 1024)) * 10) / 10).toLocaleString()} MB`
  return `${(Math.round((bytes / (1024 * 1024 * 1024)) * 10) / 10).toLocaleString()} GB`
}

export type AssetUpload = ReturnType<typeof createAssetUpload>

/**
 * The visible entry point. A hidden input per mode because `webkitdirectory` cannot be toggled on
 * one input reliably — the folder button is what makes a bulk upload one action instead of a
 * multi-select through a file dialog.
 */
export function AssetUploadButton(props: { upload: AssetUpload; class?: string }) {
  const language = useLanguage()
  let filesInput: HTMLInputElement | undefined
  let folderInput: HTMLInputElement | undefined

  const pick = async (input: HTMLInputElement) => {
    const files = pickedFromInput(input.files ?? [])
    // Reset first so picking the same file twice in a row still fires change.
    input.value = ""
    await props.upload.run(files)
  }

  return (
    <div class={`flex items-center gap-1 ${props.class ?? ""}`}>
      <input
        ref={filesInput}
        type="file"
        multiple
        // `class="hidden"` loses here: an unlayered `input { display: flex }` rule beats Tailwind's
        // layered utility, so the picker would render in the panel. An inline style always wins.
        style={{ display: "none" }}
        onChange={(event) => pick(event.currentTarget)}
        aria-hidden="true"
      />
      <input
        // Directory picking is a non-standard attribute with no place in the JSX types, so it is
        // set on the element rather than declared as a prop.
        ref={(el) => {
          folderInput = el
          el.setAttribute("webkitdirectory", "")
        }}
        type="file"
        multiple
        // `class="hidden"` loses here: an unlayered `input { display: flex }` rule beats Tailwind's
        // layered utility, so the picker would render in the panel. An inline style always wins.
        style={{ display: "none" }}
        onChange={(event) => pick(event.currentTarget)}
        aria-hidden="true"
      />
      <Button
        type="button"
        variant="ghost"
        size="small"
        class="gap-1.5"
        disabled={props.upload.uploading()}
        onClick={() => filesInput?.click()}
        aria-label={language.t("session.files.upload.files")}
        title={language.t("session.files.upload.files")}
      >
        <Icon name="cloud-upload" />
        <span class="text-12-regular">{language.t("session.files.upload.label")}</span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="small"
        disabled={props.upload.uploading()}
        onClick={() => folderInput?.click()}
        aria-label={language.t("session.files.upload.folder")}
        title={language.t("session.files.upload.folder")}
      >
        <Icon name="folder-add-left" />
      </Button>
    </div>
  )
}

/** Progress line shown under the explorer header while a batch is in flight. */
export function AssetUploadProgress(props: { upload: AssetUpload }) {
  const language = useLanguage()
  return (
    <Show when={props.upload.progress()}>
      {(progress) => (
        <div class="px-1 pt-2 text-12-regular text-text-weak" role="status" aria-live="polite">
          {language.t("session.files.upload.progress", {
            done: progress().done.toLocaleString(),
            total: progress().total.toLocaleString(),
          })}
        </div>
      )}
    </Show>
  )
}
