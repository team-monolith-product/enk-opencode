import { Show, createSignal, onCleanup, onMount } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { fileExtension } from "@opencode-ai/ui/pierre/media"
import { useLanguage } from "@/context/language"
import { readPsdComposite } from "@/utils/psd-composite"

// PhotoCraft(Rust/wasm 이미지 편집기) 웹 빌드는 public/photocraft 에 들어 있다. 앱 자산이 CDN 에서
// 서빙돼도 이 페이지는 pod(same-origin)에서 열어야 부모가 iframe 문서에 손을 댈 수 있으므로,
// 라우터와 같은 기준(<base href> 가 있으면 그 경로, 없으면 origin 루트)으로 주소를 만든다.
const editorUrl = () => {
  // Electron 패키지 앱은 렌더러를 loadFile() 로 열어 origin 이 "null" 이다. 그때는 public 이 렌더러
  // index.html 옆에 있으므로 문서 위치 기준으로 푼다(new URL(…, "null") 은 예외를 던진다).
  if (location.protocol === "file:") return new URL("photocraft/index.html", document.baseURI).href
  const base = document.querySelector("base")?.getAttribute("href")
  return new URL("photocraft/index.html", new URL(base || "/", location.origin)).href
}

// wasm(약 25MB) 다운로드·컴파일이 느린 망을 감안한 상한. 넘기면 실패로 보여 준다.
const READY_TIMEOUT_MS = 120_000

// 원본에 다시 쓸 수 있는 형식: 브라우저 canvas 가 인코딩할 수 있는 것만. 확장자 → MIME.
const ENCODABLE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
}
const sameFormat = (a: string, b: string) => !!ENCODABLE[a] && ENCODABLE[a] === ENCODABLE[b]

/** PSD 합성 이미지를 원본과 같은 형식으로 인코딩한다. 브라우저가 그 형식을 못 쓰면 예외. */
async function encodeComposite(psd: Blob, mime: string) {
  const composite = readPsdComposite(new Uint8Array(await psd.arrayBuffer()))
  const source = document.createElement("canvas")
  source.width = composite.width
  source.height = composite.height
  source.getContext("2d")!.putImageData(new ImageData(composite.data, composite.width, composite.height), 0, 0)

  let target = source
  if (mime === "image/jpeg") {
    // JPEG 은 투명도가 없어 그대로 두면 투명한 곳이 검게 된다. PhotoCraft·Photoshop 처럼 흰 바탕에 얹는다.
    target = document.createElement("canvas")
    target.width = composite.width
    target.height = composite.height
    const context = target.getContext("2d")!
    context.fillStyle = "#fff"
    context.fillRect(0, 0, target.width, target.height)
    context.drawImage(source, 0, 0)
  }
  const blob = await new Promise<Blob | null>((resolve) => target.toBlob(resolve, mime, 0.92))
  // 지원하지 않는 형식이면 toBlob 은 조용히 PNG 를 준다. 그걸 원본 자리에 쓰면 확장자와 내용이 어긋난다.
  if (!blob || blob.type !== mime) throw new Error(`This browser cannot encode ${mime}`)
  return blob
}

// SDK 는 서버가 거절하면 응답 본문을 그대로 던진다(HTTPException 이면 텍스트, NamedError 면 객체).
const reason = (error: unknown): string | undefined => {
  if (typeof error === "string") return error || undefined
  if (error instanceof Error) return error.message
  if (error && typeof error === "object") {
    const record = error as { message?: unknown; data?: { message?: unknown } }
    const message = record.data?.message ?? record.message
    if (typeof message === "string") return message
  }
}

export function PhotocraftDialog(props: { file: File; onSave: (image: Blob) => Promise<void> }) {
  const language = useLanguage()
  const [status, setStatus] = createSignal<"loading" | "ready" | "error">("loading")
  let root!: HTMLDivElement
  let frame!: HTMLIFrameElement
  let disposed = false
  onCleanup(() => {
    disposed = true
  })

  onMount(() => {
    // ui Dialog 의 size 프리셋(최대 960×600)으로는 편집기가 비좁아 화면을 거의 다 쓰게 넓힌다.
    const container = root.closest<HTMLElement>('[data-slot="dialog-container"]')
    if (container) {
      container.style.width = "calc(100vw - 32px)"
      container.style.height = "calc(100vh - 32px)"
    }
  })

  const original = fileExtension(props.file.name)
  const mime = ENCODABLE[original]

  // 저장이 연달아 눌려도 원본에는 누른 순서대로 쓰이게 한 줄로 세운다.
  let saving = Promise.resolve()
  const save = (produce: () => Promise<Blob>) => {
    saving = saving.then(async () => {
      try {
        await props.onSave(await produce())
        showToast({ variant: "success", title: language.t("file.imageEditor.saved", { name: props.file.name }) })
      } catch (error) {
        showToast({
          variant: "error",
          title: language.t("file.imageEditor.saveFailed"),
          description: reason(error),
        })
      }
    })
  }

  // PhotoCraft 의 저장(⌘S)·내보내기는 Blob URL 을 단 <a download> 를 click() 해 내려받는 것뿐이다.
  // 그 click 을 가로채, 원본에 쓸 수 있는 결과면 내려받는 대신 원본 파일에 쓴다. 쓰지 못하는 것은
  // 원래대로 내려받게 둔다. click() 은 앵커와 Blob 이 다 만들어진 뒤라, URL→Blob 을 동기적으로 기억해 둔다.
  const interceptDownloads = (win: Window & typeof globalThis) => {
    const blobs = new Map<string, Blob>()
    const createObjectURL = win.URL.createObjectURL.bind(win.URL)
    const revokeObjectURL = win.URL.revokeObjectURL.bind(win.URL)
    win.URL.createObjectURL = (object) => {
      const url = createObjectURL(object)
      if (object instanceof win.Blob) blobs.set(url, object)
      return url
    }
    win.URL.revokeObjectURL = (url) => {
      blobs.delete(url)
      revokeObjectURL(url)
    }

    const click = win.HTMLAnchorElement.prototype.click
    win.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      const blob = this.download ? blobs.get(this.href) : undefined
      const saved = blob ? fileExtension(this.download) : ""
      // 원본과 같은 형식으로 내보낸 것은 그 바이트 그대로 쓴다(내보내기 설정을 존중).
      if (blob && sameFormat(saved, original)) return save(async () => blob)
      // 저장(⌘S)은 언제나 PSD 다. 원본 형식으로 인코딩할 수 있으면 합성 이미지를 꺼내 바꿔 쓴다.
      if (blob && (saved === "psd" || saved === "psb")) {
        if (mime) return save(() => encodeComposite(blob, mime))
        showToast({ title: language.t("file.imageEditor.saveUnsupported", { ext: original.toUpperCase() }) })
      }
      return click.call(this)
    }
  }

  // PhotoCraft 는 파일을 넣는 API 가 없고 열기는 파일 선택창뿐이다. 대신 캔버스에 떨어뜨린 파일을
  // 문서로 여므로(eframe 드래그앤드롭), 앱이 뜬 뒤 그 이미지를 담은 drop 이벤트를 캔버스에 보낸다.
  const open = async () => {
    const win = frame.contentWindow as (Window & typeof globalThis) | null
    if (!win) return setStatus("error")

    // index.html 의 #photocraft_loading 은 앱이 이벤트 핸들러를 다 건 뒤 지운다.
    const started = Date.now()
    while (win.document.getElementById("photocraft_loading")) {
      if (disposed) return
      if (Date.now() - started > READY_TIMEOUT_MS) return setStatus("error")
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const canvas = win.document.getElementById("photocraft_canvas")
    if (!canvas) return setStatus("error")
    interceptDownloads(win)

    // 이벤트·파일은 iframe 쪽 realm 의 생성자로 만들어야 wasm-bindgen 의 타입 검사(instanceof)를 통과한다.
    const bytes = await props.file.arrayBuffer()
    if (disposed) return
    const transfer = new win.DataTransfer()
    transfer.items.add(new win.File([bytes], props.file.name, { type: props.file.type }))
    const rect = canvas.getBoundingClientRect()
    const point = { clientX: rect.width / 2, clientY: rect.height / 2 }
    for (const type of ["dragenter", "dragover", "drop"]) {
      canvas.dispatchEvent(
        new win.DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true, ...point }),
      )
    }
    setStatus("ready")
    frame.focus()
  }

  return (
    <Dialog
      size="x-large"
      title={
        <>
          {language.t("file.imageEditor.title", { name: props.file.name })}
          <span class="ml-2 text-12-regular text-text-weak">
            {mime ? language.t("file.imageEditor.saveHint") : language.t("file.imageEditor.saveHintUnsupported")}
          </span>
        </>
      }
      class="![height:100%]"
    >
      <div ref={root} class="relative size-full min-h-0 overflow-hidden rounded-md bg-[#262626]">
        {/* tabIndex -1: Kobalte 포커스 트랩은 탭 가능한 iframe 이면 그 문서 body 까지 뒤지는데, 로드 전에는
            body 가 null 이라 예외가 난다. 포커스는 open() 끝에서 코드로 넘긴다. */}
        <iframe
          ref={frame}
          tabIndex={-1}
          src={editorUrl()}
          title="PhotoCraft"
          class="absolute inset-0 size-full border-0"
          allow="fullscreen; clipboard-read; clipboard-write"
          onLoad={() => void open().catch(() => setStatus("error"))}
        />
        <Show when={status() !== "ready"}>
          <div class="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#262626] px-4 text-center text-14-regular text-[#b8b8b8]">
            {status() === "error" ? language.t("file.imageEditor.failed") : language.t("file.imageEditor.loading")}
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
