import { createSignal } from "solid-js"
import type { FileNodeType } from "./blocksuite/file-reference-block"
import type { LineRefInput } from "./blocksuite/line-reference-url"
import type { SelectedLineRange } from "./util/file-types"

export type LineReferenceInput = {
  path: string
  selection: SelectedLineRange
  label?: string
  comment?: string
  preview?: string
}

// V1 PromptDocBridge. 사이드 패널(파일 트리·파일 보기)과 컴포저는 형제라 공통 provider 가 없어 모듈 단위로 둔다.
// 컴포저가 add*, 파일을 여는 쪽(사이드 패널)이 open* 을 건다.
const [mode, setMode] = createSignal<"normal" | "shell" | "doc">("normal")
let addFile: ((path: string, nodeType?: FileNodeType) => boolean) | undefined
let addLine: ((input: LineReferenceInput) => boolean) | undefined
let openLine: ((input: LineRefInput) => boolean) | undefined
let openFile: ((path: string, nodeType?: FileNodeType) => boolean) | undefined

export const promptDocBridge = {
  mode,
  setMode,
  setAddReference: (next: typeof addFile) => {
    addFile = next
  },
  addReference: (path: string, nodeType?: FileNodeType) => addFile?.(path, nodeType) ?? false,
  setAddLineReference: (next: typeof addLine) => {
    addLine = next
  },
  addLineReference: (input: LineReferenceInput) => addLine?.(input) ?? false,
  setOpenLineReference: (next: typeof openLine) => {
    openLine = next
  },
  openLineReference: (input: LineRefInput) => openLine?.(input) ?? false,
  setOpenFileReference: (next: typeof openFile) => {
    openFile = next
  },
  openFileReference: (path: string, nodeType?: FileNodeType) => openFile?.(path, nodeType) ?? false,
}
