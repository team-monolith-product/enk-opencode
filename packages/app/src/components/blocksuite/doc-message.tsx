import { Component, createEffect, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js"
import { Skeleton } from "@opencode-ai/ui/skeleton"
import { useSDK } from "@/context/sdk"
import { usePromptDocBridge } from "@/context/prompt-doc-bridge"
import { useDelayed } from "@/hooks/use-delayed"
import { useColorScheme } from "@/utils/color-scheme"
import {
  OPEN_FILE_REFERENCE,
  OPEN_LINE_REFERENCE,
  type OpenFileReferenceDetail,
  type OpenLineReferenceDetail,
} from "./doc-block-events"
import { createPage } from "./blocksuite-doc"

export const DocMessage: Component<{ id: string; fallback?: JSX.Element }> = (props) => {
  const sdk = useSDK()
  const bridge = usePromptDocBridge()
  const theme = useColorScheme()
  const [fail, setFail] = createSignal(false)
  const [attached, setAttached] = createSignal(false)
  // attach 전까지 말풍선은 내용 없는 납작한 줄로 남는다. 그 자리를 스켈레톤이 채운다.
  const pending = useDelayed(() => !attached())
  // 아래 테마 동기화 이펙트가 붙는 시점보다 mount 가 늦으므로 시그널로 둔다 — 평범한 변수면
  // 페이지가 준비돼도 이펙트가 다시 돌지 않아 첫 색을 놓친다.
  const [page, setPage] = createSignal<Awaited<ReturnType<typeof createPage>>>()
  let el: HTMLDivElement | undefined
  let stop = false

  onMount(() => {
    const host = el
    if (!host) {
      setFail(true)
      return
    }

    const onFile = (event: Event) => {
      const detail = (event as CustomEvent<OpenFileReferenceDetail>).detail
      if (!detail?.path) return
      bridge.openFileReference(detail.path, detail.nodeType)
    }
    const onLine = (event: Event) => {
      const detail = (event as CustomEvent<OpenLineReferenceDetail>).detail
      if (!detail?.path) return
      bridge.openLineReference(detail)
    }
    host.addEventListener(OPEN_FILE_REFERENCE, onFile)
    host.addEventListener(OPEN_LINE_REFERENCE, onLine)
    onCleanup(() => {
      host.removeEventListener(OPEN_FILE_REFERENCE, onFile)
      host.removeEventListener(OPEN_LINE_REFERENCE, onLine)
    })

    void createPage({
      theme: theme(),
      init: false,
      readonly: true,
      preview: true,
      sync: {
        docID: props.id,
        baseUrl: sdk.url,
        directory: sdk.directory,
        client: sdk.client,
        actorID: "viewer",
        name: "Viewer",
        color: "#3574D9",
      },
    })
      .then(async (next) => {
        if (stop) {
          await next.dispose()
          return
        }
        setPage(next)
        await next.attach(host)
        if (!stop) setAttached(true)
      })
      .catch(() => {
        void page()?.dispose()
        setPage(undefined)
        setFail(true)
      })
  })

  // 색 구성은 마운트 뒤에도 바뀐다(OS 전환). 에디터는 테마를 내부 상태로 들고 있어서 다시
  // 알려주지 않으면 마운트 시점 색에 굳는다.
  createEffect(() => {
    page()?.setTheme(theme())
  })

  onCleanup(() => {
    stop = true
    void page()?.dispose()
  })

  return (
    <Show
      when={!fail()}
      fallback={props.fallback ?? <span data-component="prompt-doc-viewer-error">문서를 불러올 수 없습니다.</span>}
    >
      <Show when={pending()}>
        <div data-component="prompt-doc-viewer-loading" class="flex flex-col gap-2 py-1">
          <Skeleton width="88%" delay={0} />
          <Skeleton width="60%" delay={0.12} />
        </div>
      </Show>
      <div ref={el} data-component="prompt-doc-viewer" />
    </Show>
  )
}
