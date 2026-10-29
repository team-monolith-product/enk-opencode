import { useDialog } from "@opencode/ui/context/dialog"
import { createSignal, Show } from "solid-js"
import { Button } from "@/jitda/env/ui/button"
import { Dialog } from "@/jitda/env/ui/dialog"
import { Icon } from "@/jitda/env/ui/icon"
import { useJitda } from "@/jitda/context"
import { showToast } from "@/shell/notifications/toast"
import { useLanguage } from "@/runtime/i18n/language"
import type { FileNode } from "@/runtime/server/types"
import { useFile } from "@/workspaces/files/model"
import {
  ASSETS_DIR,
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

// __assets__ 업로드. 프롬프트 첨부와 달리 AI 를 거치지 않고 워크스페이스에 그대로 저장된다.
export function createAssetUpload() {
  const jitda = useJitda()
  const file = useFile()
  const language = useLanguage()
  const dialog = useDialog()

  const [progress, setProgress] = createSignal<{ done: number; total: number }>()
  const [checking, setChecking] = createSignal(false)
  const [dragging, setDragging] = createSignal(false)

  const uploading = () => !!progress() || checking()

  // 배치가 건드린 폴더를 다시 읽는다. 감시 이벤트가 빠지거나(무시 폴더 등) 늦으면 업로드가 트리에 안 보인다.
  const refreshTree = (relatives: string[]) => {
    const dirs = new Set<string>([""])
    for (const relative of relatives) {
      const parts = [ASSETS_DIR, ...relative.split("/").slice(0, -1)]
      for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"))
    }
    for (const dir of dirs) {
      if (!file.tree.state(dir)?.loaded) continue
      void file.tree.refresh(dir)
    }
  }

  const run = async (files: PickedFile[]) => {
    if (files.length === 0) return
    if (uploading()) return

    // 서버는 한 번에 하나씩 거절하므로 한도를 넘는 배치는 일부만 저장된다. 먼저 재고 통째로 거절한다.
    const batch = assetBatch(files)
    if (batch.count > 0) {
      setChecking(true)
      const capacity = await assetCapacity({ request: jitda.request })
      setChecking(false)
      // 용량을 못 읽었으면 막지 않고 서버 판정에 맡긴다.
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

    setProgress({ done: 0, total: files.length })
    const result = await uploadAssets({
      request: jitda.request,
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

  // 탐색기 드롭 존. data-drop-zone 이 있어야 컴포저의 문서 전역 드롭 캡처가 이 드롭을 건드리지 않는다.
  const drop = {
    "data-drop-zone": true,
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return
      event.preventDefault()
      if (!uploading()) setDragging(true)
    },
    onDragLeave: (event: DragEvent) => {
      if (event.relatedTarget && event.currentTarget instanceof Node) {
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

  // 프로젝트 전체 트리에서 업로드 폴더만 지울 수 있다.
  const deletable = (node: FileNode) => isAssetPath(node.path)

  const removeNow = async (relative: string, label: string) => {
    const ok = await deleteAsset({ request: jitda.request, relative })
    refreshTree([relative])
    showToast(
      ok
        ? { title: language.t("session.files.delete.done", { name: label }) }
        : { title: language.t("common.requestFailed") },
    )
  }

  // 파일은 바로 지우고, 폴더(업로드 폴더 자체 = 전부)는 개수·용량을 보여 주고 한 번 묻는다.
  const remove = async (node: FileNode) => {
    const relative = assetRelativePath(node.path)
    if (relative === undefined) return

    if (node.type === "file") {
      await removeNow(relative, node.name)
      return
    }

    const subtree = await assetSubtree({ request: jitda.request, relative })
    dialog.show(() => (
      <AssetDeleteDialog
        name={node.path === ASSETS_DIR ? undefined : node.name}
        subtree={subtree}
        onConfirm={() => removeNow(relative, node.name)}
      />
    ))
  }

  return { run, progress, uploading, dragging, drop, deletable, remove }
}

function AssetDeleteDialog(props: { name?: string; subtree: { count: number; bytes: number }; onConfirm: () => void }) {
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
  if (bytes < 1024 * 1024 * 1024) return `${(Math.round((bytes / (1024 * 1024)) * 10) / 10).toLocaleString()} MB`
  return `${(Math.round((bytes / (1024 * 1024 * 1024)) * 10) / 10).toLocaleString()} GB`
}

export type AssetUpload = ReturnType<typeof createAssetUpload>

// 파일/폴더 선택용 숨은 input 을 따로 둔다 — webkitdirectory 를 한 input 에서 안정적으로 토글할 수 없다.
export function AssetUploadButton(props: { upload: AssetUpload; class?: string }) {
  const language = useLanguage()
  let filesInput: HTMLInputElement | undefined
  let folderInput: HTMLInputElement | undefined

  const pick = async (input: HTMLInputElement) => {
    const files = pickedFromInput(input.files ?? [])
    input.value = ""
    await props.upload.run(files)
  }

  return (
    <div class={`flex items-center gap-1 ${props.class ?? ""}`}>
      <input
        ref={filesInput}
        type="file"
        multiple
        // 레이어 밖 input { display: flex } 규칙이 hidden 유틸을 이기므로 인라인으로 숨긴다.
        style={{ display: "none" }}
        onChange={(event) => pick(event.currentTarget)}
        aria-hidden="true"
      />
      <input
        ref={(el) => {
          folderInput = el
          el.setAttribute("webkitdirectory", "")
        }}
        type="file"
        multiple
        // 레이어 밖 input { display: flex } 규칙이 hidden 유틸을 이기므로 인라인으로 숨긴다.
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
