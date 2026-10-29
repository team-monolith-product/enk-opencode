import { onCleanup, onMount } from "solid-js"

type DocDropInput = {
  enabled: () => boolean
  isDialogActive: () => boolean
  setDraggingType: (type: "image" | "@mention" | null) => void
  focusEditor: () => void
  dropPath: (path: string) => Promise<boolean> | boolean
  dropFiles: (files: File[]) => Promise<boolean>
}

// 파일 탐색기 업로드 영역처럼 자기 드롭 영역(data-drop-zone)을 가진 곳의 드래그는 건드리지 않는다.
function ownedByDropZone(event: DragEvent) {
  const target = event.target
  return target instanceof Element && !!target.closest("[data-drop-zone]")
}

// V1 createPromptAttachments 의 문서 모드 경로(전역 드래그·드롭). 일반 입력창용 붙여넣기·이미지 첨부는 운영에서 쓰지 않는다.
export function createDocDrop(input: DocDropInput) {
  const handleGlobalDragOver = (event: DragEvent) => {
    if (!input.enabled()) return
    if (input.isDialogActive()) return
    if (ownedByDropZone(event)) return

    event.preventDefault()
    const hasFiles = event.dataTransfer?.types.includes("Files")
    const hasText = event.dataTransfer?.types.includes("text/plain")
    if (hasFiles) {
      input.setDraggingType("image")
    } else if (hasText) {
      input.setDraggingType("@mention")
    }
  }

  const handleGlobalDragLeave = (event: DragEvent) => {
    if (!input.enabled()) return
    if (input.isDialogActive()) return
    if (ownedByDropZone(event)) return
    if (!event.relatedTarget) {
      input.setDraggingType(null)
    }
  }

  const handleGlobalDrop = async (event: DragEvent) => {
    if (!input.enabled()) return
    if (input.isDialogActive()) return
    if (ownedByDropZone(event)) return

    event.preventDefault()
    event.stopPropagation()
    input.setDraggingType(null)

    const plainText = event.dataTransfer?.getData("text/plain")
    const filePrefix = "file:"
    if (plainText?.startsWith(filePrefix)) {
      const filePath = plainText.slice(filePrefix.length)
      if (await input.dropPath(filePath)) return
      input.focusEditor()
      return
    }

    const dropped = event.dataTransfer?.files
    if (!dropped) return
    await input.dropFiles(Array.from(dropped))
  }

  onMount(() => {
    document.addEventListener("dragover", handleGlobalDragOver)
    document.addEventListener("dragleave", handleGlobalDragLeave)
    document.addEventListener("drop", handleGlobalDrop, true)
  })

  onCleanup(() => {
    document.removeEventListener("dragover", handleGlobalDragOver)
    document.removeEventListener("dragleave", handleGlobalDragLeave)
    document.removeEventListener("drop", handleGlobalDrop, true)
  })
}
