import { createSignal } from "solid-js"
import type { SelectedLineRange } from "@/workspaces/files/model"

export type LineContextInput = { file: string; selection: SelectedLineRange; comment: string; preview?: string }

export type OpenSessionFileInput = {
  path: string
  nodeType?: "file" | "directory"
  selection?: SelectedLineRange | null
  origin?: "review" | "file"
  commentFocus?: { file: string; id: string }
}

type Actions = {
  openFile: (input: OpenSessionFileInput) => void
  openFileSearch: () => void
  showPreview: () => void
}

const [actions, setActions] = createSignal<Actions | undefined>()
const [contextAdd, setContextAdd] = createSignal<((path: string, type: "file" | "directory") => void) | undefined>()
const [lineContext, setLineContext] = createSignal<((input: LineContextInput) => void) | undefined>()
const [composerExpanded, setComposerExpanded] = createSignal(false)

// 컴포저·타임라인(리드 소유)이 사이드 패널을 다루는 창구. 패널과 컴포저는 형제라 공통 provider 가 없다.
export const sidePanelController = {
  /** 패널이 마운트돼 있으면 파일/폴더/diff 를 연다(V1 createOpenSessionFile). */
  openFile: (input: OpenSessionFileInput) => actions()?.openFile(input),
  /** 파일 검색 모달(V1 DialogSelectFile mode="files")을 연다. */
  openFileSearch: () => actions()?.openFileSearch(),
  showPreview: () => actions()?.showPreview(),
  /** doc 모드 컴포저가 등록하면 파일 트리 행에 "컨텍스트에 추가" 버튼이 생긴다(V1 bridge.mode() === "doc"). */
  contextAdd,
  setContextAdd: (fn: ((path: string, type: "file" | "directory") => void) | undefined) => setContextAdd(() => fn),
  /** doc 모드 컴포저가 등록하면 줄 코멘트가 기본 컴포저 컨텍스트 대신 이쪽으로 간다(V1 addLineContext). */
  lineContext,
  setLineContext: (fn: ((input: LineContextInput) => void) | undefined) => setLineContext(() => fn),
  /** 확장 입력창이 펼쳐지면 세션 폭 리사이즈 핸들을 숨긴다(V1 composerLift). */
  composerExpanded,
  setComposerExpanded,
  register: (value: Actions) => {
    setActions(() => value)
    return () => setActions((current) => (current === value ? undefined : current))
  },
}
