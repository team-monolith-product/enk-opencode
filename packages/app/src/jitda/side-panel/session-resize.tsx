import { createMediaQuery } from "@solid-primitives/media"
import { Show } from "solid-js"
import { ResizeHandle } from "@/jitda/env/ui/resize-handle"
import { sidePanelController } from "./controller"
import { panelSizing, sidePanelLayout } from "./layout"

// 채팅 컬럼(V1 codle-session-column) 오른쪽 끝의 좌·우 분할 핸들. 컬럼 안에 그려야 V1 과 같은 위치·스태킹이 된다.
// 확장 입력창이 펼쳐지면 그리지 않는다(드래그 불가이고, 전체 폭 입력창 위로 바가 올라온다).
export function JitdaSessionPanelResize() {
  const isDesktop = createMediaQuery("(min-width: 768px)")
  return (
    <Show when={isDesktop() && !sidePanelController.composerExpanded()}>
      <div
        class="absolute inset-y-0 right-0 w-0 overflow-visible"
        style={{ "--resize-gap-offset": "7px" }}
        onPointerDown={() => panelSizing.start()}
      >
        <ResizeHandle
          class="session-panel-resize"
          showHandle={true}
          direction="horizontal"
          size={sidePanelLayout.session.width()}
          min={300}
          max={typeof window === "undefined" ? 1000 : window.innerWidth - 380}
          onResize={(width) => {
            panelSizing.touch()
            sidePanelLayout.session.resize(width)
          }}
        />
      </div>
    </Show>
  )
}
