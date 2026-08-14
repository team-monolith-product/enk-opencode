import { Component, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import {
  OPEN_FILE_REFERENCE,
  OPEN_LINE_REFERENCE,
  type OpenFileReferenceDetail,
  type OpenLineReferenceDetail,
} from "@/components/blocksuite/doc-block-events"
import { usePromptDocBridge } from "@/context/prompt-doc-bridge"
import { useColorScheme } from "@/utils/color-scheme"
import type { createPromptDoc } from "./doc"

type PanelProps = {
  doc: ReturnType<typeof createPromptDoc>
}

export const PromptDocPanel: Component<PanelProps> = (props) => {
  const bridge = usePromptDocBridge()
  const theme = useColorScheme()
  const [root, setRoot] = createSignal<HTMLDivElement>()

  onMount(() => {
    const el = root()
    if (!el) return

    const onLine = (event: Event) => {
      const detail = (event as CustomEvent<OpenLineReferenceDetail>).detail
      if (!detail?.path) return
      bridge.openLineReference(detail)
    }
    const onFile = (event: Event) => {
      const detail = (event as CustomEvent<OpenFileReferenceDetail>).detail
      if (!detail?.path) return
      bridge.openFileReference(detail.path, detail.nodeType)
    }

    el.addEventListener(OPEN_LINE_REFERENCE, onLine)
    el.addEventListener(OPEN_FILE_REFERENCE, onFile)

    void props.doc.mount({ el, theme: theme() })
    onCleanup(() => {
      el.removeEventListener(OPEN_LINE_REFERENCE, onLine)
      el.removeEventListener(OPEN_FILE_REFERENCE, onFile)
      props.doc.detach()
    })
  })

  createEffect(() => {
    props.doc.setTheme(theme())
  })

  return (
    <div
      data-component="prompt-doc"
      class="h-full w-full overflow-hidden bg-transparent"
      ref={setRoot}
      onPointerDown={(e) => {
        e.stopPropagation()
        props.doc.guard()
      }}
      onClick={(e) => e.stopPropagation()}
    />
  )
}
