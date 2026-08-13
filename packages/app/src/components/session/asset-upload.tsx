import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createSignal, Show } from "solid-js"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import {
  ASSETS_DIR,
  assetRelativePath,
  assetSubtree,
  deleteAsset,
  isAssetPath,
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
export function createAssetUpload() {
  const sdk = useSDK()
  const language = useLanguage()
  const dialog = useDialog()

  const [progress, setProgress] = createSignal<{ done: number; total: number }>()
  const [dragging, setDragging] = createSignal(false)

  const uploading = () => !!progress()

  const run = async (files: PickedFile[]) => {
    if (files.length === 0) return
    // A second batch while one is in flight would make the counter meaningless; the picker and the
    // drop zone are both disabled while uploading, so this only catches a race.
    if (uploading()) return

    setProgress({ done: 0, total: files.length })
    const result = await uploadAssets({
      client: sdk.client,
      directory: sdk.directory,
      files,
      onProgress: (done, total) => setProgress({ done, total }),
    })
    setProgress(undefined)

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

  /**
   * Only the upload folder gets a delete affordance. The file tree renders the whole project, and
   * nothing else in it should be deletable from here — code is git's to restore, not ours.
   */
  const deletable = (node: FileNode) => isAssetPath(node.path)

  const removeNow = async (relative: string, label: string) => {
    const ok = await deleteAsset({ client: sdk.client, directory: sdk.directory, relative })
    showToast(
      ok
        ? { title: language.t("session.files.delete.done", { name: label }) }
        : { title: language.t("common.requestFailed") },
    )
  }

  /**
   * A single file goes immediately — it is one thing the user just pointed at. A folder (including
   * the upload folder itself, which is "delete everything") asks first, because the row gives no
   * hint of how much is underneath it.
   */
  const remove = async (node: FileNode) => {
    const relative = assetRelativePath(node.path)
    if (relative === undefined) return

    if (node.type === "file") {
      await removeNow(relative, node.name)
      return
    }

    const subtree = await assetSubtree({ client: sdk.client, directory: sdk.directory, relative })
    dialog.show(() => (
      <AssetDeleteDialog
        // Deleting the upload folder is "delete everything"; naming the folder there would make the
        // user translate an internal name into what is about to happen.
        name={node.path === ASSETS_DIR ? undefined : node.name}
        subtree={subtree}
        onConfirm={() => removeNow(relative, node.name)}
      />
    ))
  }

  return { run, progress, uploading, dragging, drop, deletable, remove }
}

/**
 * Confirmation for a folder delete. The count and size are the whole point — the row the user
 * clicked shows neither, so a generic "are you sure" would tell them nothing they did not know.
 *
 * Chrome follows DialogEnvKeys (title / description / footer rhythm, see .asset-delete-dialog in
 * index.css) so the two modals read as one product rather than two.
 */
function AssetDeleteDialog(props: {
  /** The folder's name, or undefined when the target is the upload folder itself. */
  name?: string
  subtree: { count: number; bytes: number }
  onConfirm: () => void
}) {
  const dialog = useDialog()
  const language = useLanguage()

  return (
    <Dialog
      title={
        props.name
          ? language.t("session.files.delete.confirm.title", { name: props.name })
          : language.t("session.files.delete.confirm.title.all")
      }
      description={language.t("session.files.delete.confirm.body", {
        count: props.subtree.count.toLocaleString(),
        size: formatBytes(props.subtree.bytes),
      })}
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
  return `${(Math.round((bytes / (1024 * 1024)) * 10) / 10).toLocaleString()} MB`
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
