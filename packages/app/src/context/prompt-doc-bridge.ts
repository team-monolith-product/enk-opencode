import { createSimpleContext } from "@opencode-ai/ui/context"
import { createSignal } from "solid-js"
import type { SelectedLineRange } from "@/context/file"
import type { FileNodeType } from "@/components/blocksuite/file-reference-block"
import type { LineRefInput } from "@/components/blocksuite/line-reference-url"

type Mode = "normal" | "shell" | "doc"

export type LineReferenceInput = {
  path: string
  selection: SelectedLineRange
  label?: string
  comment?: string
  preview?: string
}

export type AddFilesResult = { added: boolean; tooLarge: boolean; overflow: boolean }

export const { use: usePromptDocBridge, provider: PromptDocBridgeProvider } = createSimpleContext({
  name: "PromptDocBridge",
  gate: false,
  init: () => {
    const [mode, setMode] = createSignal<Mode>("normal")
    let addFile: ((path: string, nodeType?: FileNodeType) => boolean) | undefined
    let addLine: ((input: LineReferenceInput) => boolean) | undefined
    let addText: ((text: string) => boolean) | undefined
    let addFiles: ((files: File[]) => Promise<AddFilesResult>) | undefined
    let openLine: ((input: LineRefInput) => boolean) | undefined
    let openFile: ((path: string, nodeType?: FileNodeType) => boolean) | undefined
    // 컴포저는 질문·권한 독이 뜨면 언마운트되어 등록이 풀린다. 넘기기처럼 나중에 다시 넣어야 하는 쪽이
    // "다시 붙었다"를 알아챌 수 있게, 넣는 함수가 바뀔 때마다 올린다.
    const [revision, setRevision] = createSignal(0)
    const bump = () => setRevision((value) => value + 1)

    return {
      mode,
      setMode,
      revision,
      /** doc 모드 컴포저가 마운트되어 블록을 받을 수 있는지. */
      ready: () => mode() === "doc" && !!addText,
      setAddReference: (next: typeof addFile) => {
        addFile = next
      },
      addReference: (path: string, nodeType?: FileNodeType) => addFile?.(path, nodeType) ?? false,
      setAddLineReference: (next: typeof addLine) => {
        addLine = next
      },
      addLineReference: (input: LineReferenceInput) => addLine?.(input) ?? false,
      setAddText: (next: typeof addText) => {
        addText = next
        bump()
      },
      addText: (text: string) => addText?.(text) ?? false,
      setAddFiles: (next: typeof addFiles) => {
        addFiles = next
        bump()
      },
      addFiles: (files: File[]): Promise<AddFilesResult> =>
        addFiles?.(files) ?? Promise.resolve({ added: false, tooLarge: false, overflow: false }),
      setOpenLineReference: (next: typeof openLine) => {
        openLine = next
      },
      openLineReference: (input: LineRefInput) => openLine?.(input) ?? false,
      setOpenFileReference: (next: typeof openFile) => {
        openFile = next
      },
      openFileReference: (path: string, nodeType?: FileNodeType) => openFile?.(path, nodeType) ?? false,
    }
  },
})
