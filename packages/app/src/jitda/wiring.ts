import { promptDocBridge } from "@/jitda/composer/bridge"
import { sidePanelController } from "@/jitda/side-panel/controller"

// 컴포저와 사이드 패널은 형제라 서로를 모른다. V1 PromptDocBridge 처럼 여기서 한 번 이어 준다.
// 문서 안 파일·줄 참조를 누르면 사이드 패널에서 열고, 파일 트리 "추가"와 줄 코멘트는 문서로 넣는다.
export function wireJitda() {
  promptDocBridge.setOpenFileReference((path, nodeType) => {
    sidePanelController.openFile({ path, nodeType: nodeType === "directory" ? "directory" : "file" })
    return true
  })
  promptDocBridge.setOpenLineReference((ref) => {
    sidePanelController.openFile({
      path: ref.path,
      selection: {
        start: ref.start,
        end: ref.end,
        ...(ref.side === "additions" || ref.side === "deletions" ? { side: ref.side } : {}),
        ...(ref.endSide === "additions" || ref.endSide === "deletions" ? { endSide: ref.endSide } : {}),
      },
    })
    return true
  })
  sidePanelController.setContextAdd((path, type) => {
    promptDocBridge.addReference(path, type)
  })
  sidePanelController.setLineContext((input) => {
    promptDocBridge.addLineReference({
      path: input.file,
      selection: input.selection,
      comment: input.comment,
      preview: input.preview,
    })
  })
}
