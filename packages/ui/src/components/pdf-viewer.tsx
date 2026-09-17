import {
  AnnotationLayer,
  AnnotationType,
  getDocument,
  OutputScale,
  PDFWorker,
  RenderingCancelledException,
  TextLayer,
  version,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist/legacy/build/pdf.mjs"
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { useI18n } from "../context/i18n"
import { createWorker } from "../pierre/create-worker"
import { Button } from "./button"
import { DropdownMenu } from "./dropdown-menu"
import { Icon } from "./icon"
import { IconButton } from "./icon-button"
import { Spinner } from "./spinner"
import { Tooltip } from "./tooltip"
import {
  PDF_ZOOM_DEFAULT,
  PDF_ZOOM_LEVELS,
  pdfBytesFromDataUrl,
  pdfPageForKey,
  pdfPageInput,
  pdfScale,
  pdfZoomPercent,
  type PdfFit,
  type PdfSize,
} from "./pdf-viewer-model"

const THUMBNAIL_WIDTH = 138
const RERENDER_DELAY = 200
const MAX_CANVAS_PIXELS = 2 ** 25
const MAX_CANVAS_DIM = 32767

type Navigator = {
  page: () => number
  total: () => number
  go: (page: number) => void
}

function resources() {
  const worker = new URL(workerUrl, location.href)
  const root = import.meta.env.DEV ? new URL("../../", worker) : new URL(`pdfjs-${version}/`, worker)
  return {
    cMapUrl: new URL("cmaps/", root).href,
    standardFontDataUrl: new URL("standard_fonts/", root).href,
    wasmUrl: new URL("wasm/", root).href,
    iccUrl: new URL("iccs/", root).href,
  }
}

async function openPdf(data: Uint8Array) {
  const port = createWorker(workerUrl)
  const worker = PDFWorker.create({ port })
  const task = getDocument({ data, worker, ...resources() })
  const close = async () => {
    await task.destroy().catch(() => {})
    worker.destroy()
    port.terminate()
  }
  const pdf = await task.promise.catch(async (error) => {
    await close()
    throw error
  })
  const sizes = await Promise.all(
    Array.from({ length: pdf.numPages }, (_, index) =>
      pdf.getPage(index + 1).then((page) => {
        const viewport = page.getViewport({ scale: 1 })
        return { width: viewport.width, height: viewport.height }
      }),
    ),
  ).catch(async (error) => {
    await close()
    throw error
  })
  return { pdf, sizes, close }
}

function createLinkService(pdf: PDFDocumentProxy, nav: Navigator) {
  const goTo = async (dest: unknown) => {
    const explicit = typeof dest === "string" ? await pdf.getDestination(dest) : dest
    if (!Array.isArray(explicit)) return
    const ref = explicit[0]
    const index =
      typeof ref === "object" && ref !== null ? await pdf.getPageIndex(ref) : Number.isInteger(ref) ? ref : undefined
    if (typeof index === "number") nav.go(index + 1)
  }

  return {
    externalLinkEnabled: true,
    addLinkAttributes(link: HTMLAnchorElement, url: string) {
      link.href = url
      link.title = url
      link.target = "_blank"
      link.rel = "noopener noreferrer nofollow"
    },
    getDestinationHash: () => "#",
    getAnchorUrl: () => "#",
    goToDestination(dest: unknown) {
      goTo(dest).catch(() => {})
    },
    executeNamedAction(action: string) {
      if (action === "NextPage") nav.go(Math.min(nav.page() + 1, nav.total()))
      if (action === "PrevPage") nav.go(Math.max(nav.page() - 1, 1))
      if (action === "FirstPage") nav.go(1)
      if (action === "LastPage") nav.go(nav.total())
    },
    executeSetOCGState() {},
    async getAttachmentContent() {
      return null
    },
  }
}

function renderPage(input: {
  pdf: PDFDocumentProxy
  number: number
  scale: number
  layer: HTMLDivElement
  links?: ReturnType<typeof createLinkService>
}) {
  let cancelled = false
  let task: RenderTask | undefined
  let text: TextLayer | undefined

  const promise = (async () => {
    const page = await input.pdf.getPage(input.number)
    if (cancelled) throw new RenderingCancelledException("cancelled")

    const viewport = page.getViewport({ scale: input.scale })
    const { layer } = input
    layer.style.setProperty("--scale-factor", String(viewport.scale))
    layer.style.setProperty("--user-unit", String(viewport.userUnit))
    layer.style.width = `${Math.floor(viewport.width)}px`
    layer.style.height = `${Math.floor(viewport.height)}px`

    const output = new OutputScale()
    output.limitCanvas(viewport.width, viewport.height, MAX_CANVAS_PIXELS, MAX_CANVAS_DIM)
    const canvas = document.createElement("canvas")
    canvas.width = Math.floor(viewport.width * output.sx)
    canvas.height = Math.floor(viewport.height * output.sy)
    canvas.style.width = layer.style.width
    canvas.style.height = layer.style.height
    layer.append(canvas)

    task = page.render({
      canvas,
      viewport,
      transform: output.scaled ? [output.sx, 0, 0, output.sy, 0, 0] : undefined,
    })
    await task.promise

    const links = input.links
    if (!links || cancelled) return

    const textDiv = document.createElement("div")
    textDiv.className = "textLayer"
    const annotationDiv = document.createElement("div")
    annotationDiv.className = "annotationLayer"
    layer.append(textDiv, annotationDiv)

    text = new TextLayer({
      textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
      container: textDiv,
      viewport,
    })
    const annotationViewport = viewport.clone({ dontFlip: true })
    const annotations = new AnnotationLayer({
      div: annotationDiv,
      page,
      viewport: annotationViewport,
      linkService: links,
      annotationStorage: input.pdf.annotationStorage,
      accessibilityManager: null,
      annotationCanvasMap: null,
      annotationEditorUIManager: null,
      structTreeLayer: null,
      commentManager: null,
    })
    await Promise.allSettled([
      text.render(),
      page.getAnnotations({ intent: "display" }).then((items) =>
        annotations.render({
          annotations: items.filter((item) => item.annotationType === AnnotationType.LINK),
          viewport: annotationViewport,
          div: annotationDiv,
          page,
          linkService: links as never,
          renderForms: false,
          imageResourcesPath: "",
        }),
      ),
    ])
  })()

  return {
    promise,
    cancel() {
      cancelled = true
      task?.cancel()
      text?.cancel()
    },
  }
}

function PdfPage(props: {
  pdf: PDFDocumentProxy
  number: number
  size: PdfSize
  scale: number
  links: ReturnType<typeof createLinkService>
  errorLabel: string
}) {
  let frame!: HTMLDivElement
  let shown: HTMLDivElement | undefined
  let job: ReturnType<typeof renderPage> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const [drawn, setDrawn] = createSignal<number>()
  const [failed, setFailed] = createSignal(false)

  const draw = (scale: number) => {
    job?.cancel()
    const layer = document.createElement("div")
    layer.dataset.slot = "pdf-viewer-layer"
    const current = renderPage({ pdf: props.pdf, number: props.number, scale, layer, links: props.links })
    job = current
    current.promise.then(
      () => {
        if (job !== current) return
        shown?.remove()
        shown = layer
        frame.append(layer)
        batch(() => {
          setDrawn(scale)
          setFailed(false)
        })
      },
      (error) => {
        if (job !== current || error instanceof RenderingCancelledException) return
        setFailed(true)
      },
    )
  }

  onMount(() => draw(props.scale))
  createEffect(
    on(
      () => props.scale,
      (scale) => {
        clearTimeout(timer)
        timer = setTimeout(() => draw(scale), RERENDER_DELAY)
      },
      { defer: true },
    ),
  )
  onCleanup(() => {
    clearTimeout(timer)
    job?.cancel()
    job = undefined
  })

  return (
    <div
      ref={frame}
      data-slot="pdf-viewer-page-frame"
      style={{
        width: `${Math.floor(props.size.width * props.scale)}px`,
        height: `${Math.floor(props.size.height * props.scale)}px`,
        "--pdf-layer-scale": String(props.scale / (drawn() ?? props.scale)),
      }}
    >
      <Show when={failed()}>
        <div data-slot="pdf-viewer-page-error">{props.errorLabel}</div>
      </Show>
    </div>
  )
}

function Thumbnail(props: {
  pdf: PDFDocumentProxy
  number: number
  size: PdfSize
  active: boolean
  label: string
  onSelect: (page: number) => void
}) {
  let item!: HTMLLIElement
  let frame!: HTMLDivElement
  const [visible, setVisible] = createSignal(false)

  onMount(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        setVisible(true)
        observer.disconnect()
      },
      { rootMargin: "500px" },
    )
    observer.observe(item)
    onCleanup(() => observer.disconnect())
  })

  createEffect(() => {
    if (props.active) item.scrollIntoView({ block: "nearest" })
  })

  createEffect(() => {
    if (!visible()) return
    const layer = document.createElement("div")
    layer.dataset.slot = "pdf-viewer-thumbnail-layer"
    const job = renderPage({ pdf: props.pdf, number: props.number, scale: THUMBNAIL_WIDTH / props.size.width, layer })
    job.promise.then(
      () => frame.append(layer),
      () => {},
    )
    onCleanup(() => {
      job.cancel()
      layer.remove()
    })
  })

  const select = () => props.onSelect(props.number)

  return (
    <li
      ref={item}
      role="button"
      tabIndex={0}
      aria-label={props.label}
      aria-current={props.active ? "page" : undefined}
      data-slot="pdf-viewer-thumbnail"
      data-active={props.active}
      onClick={select}
      on:keydown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        event.stopPropagation()
        select()
      }}
    >
      <div
        ref={frame}
        data-slot="pdf-viewer-thumbnail-frame"
        style={{ "padding-bottom": `${Math.floor((props.size.height / props.size.width) * THUMBNAIL_WIDTH)}px` }}
      />
      <p aria-hidden="true" data-slot="pdf-viewer-thumbnail-number">
        {props.number}
      </p>
    </li>
  )
}

function PageInput(props: {
  page: number
  total: number
  label: string
  disabled: boolean
  onCommit: (page: number) => void
}) {
  const [value, setValue] = createSignal(String(props.page))
  const [invalid, setInvalid] = createSignal(false)

  createEffect(
    on(
      () => props.page,
      (page) => {
        setValue(String(page))
        setInvalid(false)
      },
    ),
  )

  const commit = () => {
    const page = pdfPageInput(value(), props.total)
    if (page === undefined) {
      setInvalid(true)
      return
    }
    props.onCommit(page)
  }

  return (
    <div
      data-slot="pdf-viewer-page-field"
      data-invalid={invalid()}
      style={{ width: `${String(props.total).length * 10 + 36}px` }}
    >
      <input
        inputMode="numeric"
        aria-label={props.label}
        aria-invalid={invalid()}
        disabled={props.disabled}
        value={value()}
        onInput={(event) => {
          const page = pdfPageInput(event.currentTarget.value, props.total)
          const next = page === undefined ? "" : String(page)
          event.currentTarget.value = next
          setValue(next)
          setInvalid(page === undefined)
        }}
        onBlur={commit}
        on:selectionchange={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit()
        }}
      />
    </div>
  )
}

function PdfState(props: { name?: string; kind: "loading" | "error" }) {
  const i18n = useI18n()
  return (
    <div data-slot="pdf-viewer-state" role={props.kind === "error" ? "alert" : "status"}>
      <Show when={props.name}>
        <div data-slot="pdf-viewer-state-name">
          <Icon name="file" size="small" />
          <span>{props.name}</span>
        </div>
      </Show>
      <Switch>
        <Match when={props.kind === "loading"}>
          <Spinner class="size-5" />
          <div data-slot="pdf-viewer-state-text">{i18n.t("ui.pdfViewer.loading")}</div>
        </Match>
        <Match when={props.kind === "error"}>
          <Icon name="warning" />
          <div data-slot="pdf-viewer-state-title">{i18n.t("ui.pdfViewer.error.title")}</div>
          <div data-slot="pdf-viewer-state-text">{i18n.t("ui.pdfViewer.error.description")}</div>
        </Match>
      </Switch>
    </div>
  )
}

export default function PdfViewer(props: { src: string; name?: string; onLoad?: () => void }) {
  const i18n = useI18n()
  let root!: HTMLDivElement
  let panel!: HTMLDivElement
  let scroller: HTMLDivElement | undefined
  let lastScrollTop = 0

  const [pdf, setPdf] = createSignal<PDFDocumentProxy>()
  const [sizes, setSizes] = createSignal<PdfSize[]>([])
  const [failed, setFailed] = createSignal(false)
  const [page, setPage] = createSignal(1)
  const [zoom, setZoom] = createSignal(PDF_ZOOM_DEFAULT)
  const [fit, setFit] = createSignal<PdfFit>("auto")
  const [thumbnails, setThumbnails] = createSignal(false)
  const [fullscreen, setFullscreen] = createSignal(false)
  const [height, setHeight] = createSignal<number>()
  const [panelSize, setPanelSize] = createSignal<PdfSize>()

  const total = () => pdf()?.numPages ?? 0
  const go = (next: number) => {
    if (next < 1 || next > total()) return
    setPage(next)
  }
  const ready = () => !!pdf() && sizes().length > 0
  const scale = createMemo(() => pdfScale({ container: panelSize(), page: sizes()[0], fit: fit(), zoom: zoom() }))
  const links = createMemo(() => {
    const doc = pdf()
    if (!doc) return
    return createLinkService(doc, { page, total, go })
  })
  const current = createMemo(() => {
    const doc = pdf()
    const service = links()
    const number = page()
    const size = sizes()[number - 1]
    if (!doc || !service || !size) return
    return { doc, links: service, number, size }
  })

  createEffect(
    on(
      () => props.src,
      (src) => {
        batch(() => {
          setPdf(undefined)
          setSizes([])
          setFailed(false)
          setPage(1)
        })
        const data = pdfBytesFromDataUrl(src)
        if (!data) {
          setFailed(true)
          return
        }

        let closed = false
        let close: (() => Promise<void>) | undefined
        onCleanup(() => {
          closed = true
          void close?.()
        })
        openPdf(data).then(
          (opened) => {
            if (closed) {
              void opened.close()
              return
            }
            close = opened.close
            batch(() => {
              setPdf(opened.pdf)
              setSizes(opened.sizes)
            })
            props.onLoad?.()
          },
          () => {
            if (!closed) setFailed(true)
          },
        )
      },
    ),
  )

  onMount(() => {
    const viewport = root.closest(".scroll-view__viewport")
    const observer = new ResizeObserver(() => {
      setPanelSize({ width: panel.offsetWidth, height: panel.offsetHeight })
      if (viewport instanceof HTMLElement) setHeight(viewport.clientHeight)
    })
    observer.observe(panel)
    if (viewport) observer.observe(viewport)

    const onFullscreenChange = () => setFullscreen(document.fullscreenElement === panel)
    document.addEventListener("fullscreenchange", onFullscreenChange)

    onCleanup(() => {
      observer.disconnect()
      document.removeEventListener("fullscreenchange", onFullscreenChange)
    })
  })

  createEffect(
    on(scale, (next, prev) => {
      if (!scroller || prev === undefined || prev === next) return
      const top = (lastScrollTop * next) / prev
      scroller.scrollTo(0, top)
      lastScrollTop = top
    }),
  )

  const openSlideshow = async () => {
    await panel.requestFullscreen().catch(() => {})
    panel.focus()
  }

  const onPanelKeyDown = (event: KeyboardEvent) => {
    if (!ready()) return
    const active = document.activeElement
    if (active && active !== panel && panel.contains(active)) return
    const next = pdfPageForKey(event.key, page(), total())
    if (next === undefined) return
    event.preventDefault()
    event.stopPropagation()
    go(next)
  }

  const onPanelClick = () => {
    if (!fullscreen() || page() >= total()) return
    go(page() + 1)
  }

  const zoomLabel = (percent: number) => i18n.t("ui.pdfViewer.zoomLevel", { percent })

  return (
    <div ref={root} data-component="pdf-viewer" style={{ height: height() ? `${height()}px` : undefined }}>
      <button type="button" data-slot="pdf-viewer-skip" onClick={() => panel.focus()}>
        {i18n.t("ui.pdfViewer.skip")}
      </button>
      <div data-slot="pdf-viewer-toolbar">
        <DropdownMenu>
          <DropdownMenu.Trigger
            as={Button}
            size="small"
            variant="ghost"
            disabled={!ready()}
            title={i18n.t("ui.pdfViewer.zoom")}
          >
            {zoomLabel(pdfZoomPercent(scale()))}
            <Icon name="chevron-down" size="small" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content>
              <For each={PDF_ZOOM_LEVELS}>
                {(level, index) => (
                  <DropdownMenu.Item
                    onSelect={() => {
                      batch(() => {
                        setFit("none")
                        setZoom(index())
                      })
                    }}
                  >
                    <DropdownMenu.ItemLabel>{zoomLabel(level * 100)}</DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                )}
              </For>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
        <Tooltip value={i18n.t("ui.pdfViewer.fitWidth")} placement="bottom">
          <IconButton
            icon="fit-width"
            variant="ghost"
            size="small"
            aria-label={i18n.t("ui.pdfViewer.fitWidth")}
            aria-pressed={fit() === "width"}
            disabled={!ready()}
            onClick={() => setFit("width")}
          />
        </Tooltip>
        <Tooltip value={i18n.t("ui.pdfViewer.fitHeight")} placement="bottom">
          <IconButton
            icon="fit-height"
            variant="ghost"
            size="small"
            aria-label={i18n.t("ui.pdfViewer.fitHeight")}
            aria-pressed={fit() === "height"}
            disabled={!ready()}
            onClick={() => setFit("height")}
          />
        </Tooltip>
        <div data-slot="pdf-viewer-divider" />
        <Tooltip value={i18n.t("ui.pdfViewer.slideshow")} placement="bottom">
          <IconButton
            icon="slideshow"
            variant="ghost"
            size="small"
            aria-label={i18n.t("ui.pdfViewer.slideshow")}
            disabled={!ready() || !document.fullscreenEnabled}
            onClick={openSlideshow}
          />
        </Tooltip>
        <Tooltip
          value={i18n.t(thumbnails() ? "ui.pdfViewer.thumbnails.close" : "ui.pdfViewer.thumbnails.open")}
          placement="bottom"
        >
          <IconButton
            icon={thumbnails() ? "sidebar-active" : "sidebar"}
            variant="ghost"
            size="small"
            aria-label={i18n.t(thumbnails() ? "ui.pdfViewer.thumbnails.close" : "ui.pdfViewer.thumbnails.open")}
            aria-expanded={thumbnails()}
            disabled={!ready()}
            onClick={() => setThumbnails((open) => !open)}
          />
        </Tooltip>
      </div>
      <div data-slot="pdf-viewer-body">
        <Show when={thumbnails() && ready() && pdf()}>
          {(doc) => (
            <div data-slot="pdf-viewer-thumbnails">
              <ol>
                <Index each={sizes()}>
                  {(size, index) => (
                    <Thumbnail
                      pdf={doc()}
                      number={index + 1}
                      size={size()}
                      active={page() === index + 1}
                      label={i18n.t("ui.pdfViewer.pageLabel", { page: index + 1 })}
                      onSelect={go}
                    />
                  )}
                </Index>
              </ol>
            </div>
          )}
        </Show>
        <div
          ref={panel}
          data-slot="pdf-viewer-content"
          data-fullscreen={fullscreen()}
          tabIndex={0}
          on:keydown={onPanelKeyDown}
          onClick={onPanelClick}
        >
          <Switch>
            <Match when={failed()}>
              <PdfState kind="error" name={props.name} />
            </Match>
            <Match when={!ready()}>
              <PdfState kind="loading" name={props.name} />
            </Match>
            <Match when={current()} keyed>
              {(item) => (
                <div
                  ref={(el) => {
                    scroller = el
                    lastScrollTop = 0
                  }}
                  data-slot="pdf-viewer-scroll"
                  onScroll={(event) => {
                    lastScrollTop = event.currentTarget.scrollTop
                  }}
                >
                  <ol data-slot="pdf-viewer-pages">
                    <li data-slot="pdf-viewer-page">
                      <PdfPage
                        pdf={item.doc}
                        number={item.number}
                        size={item.size}
                        scale={scale()}
                        links={item.links}
                        errorLabel={i18n.t("ui.pdfViewer.pageError")}
                      />
                    </li>
                  </ol>
                </div>
              )}
            </Match>
          </Switch>
        </div>
      </div>
      <div data-slot="pdf-viewer-navigation">
        <Button
          size="small"
          variant="primary"
          icon="chevron-left"
          disabled={!ready() || page() <= 1}
          onClick={() => go(page() - 1)}
        >
          {i18n.t("ui.pdfViewer.previous")}
        </Button>
        <div data-slot="pdf-viewer-indicator">
          <PageInput
            page={page()}
            total={total()}
            label={i18n.t("ui.pdfViewer.pageInput")}
            disabled={!ready()}
            onCommit={go}
          />
          <span>{`/ ${total()}`}</span>
        </div>
        <Button size="small" variant="primary" disabled={!ready() || page() >= total()} onClick={() => go(page() + 1)}>
          {i18n.t("ui.pdfViewer.next")}
          <Icon name="chevron-right" size="small" />
        </Button>
      </div>
    </div>
  )
}
