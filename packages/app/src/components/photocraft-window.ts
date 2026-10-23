import { fileExtension } from "@opencode-ai/ui/pierre/media"
import { readPsdComposite } from "@/utils/psd-composite"

// PhotoCraft(Rust/wasm 이미지 편집기) 웹 빌드는 public/photocraft 에 들어 있다. 앱 자산이 CDN 에서
// 서빙돼도 이 페이지는 pod(same-origin)에서 열어야 부모가 자식 창 문서에 손을 댈 수 있으므로,
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

// PhotoCraft 0.7.0 이 열 수 있는 이미지(README 의 지원 형식, HEIC 는 웹 빌드에도 들어 있다).
// AVIF 는 쓰기만 되고 읽지 못해, 편집 버튼을 보여 줘도 열리지 않는다.
const READABLE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "heic"])

/** 이 파일을 PhotoCraft 편집기로 열 수 있는지. */
export const canEditImage = (path: string) => READABLE.has(fileExtension(path))

/**
 * 원본을 그 형식으로 정확히 덮어쓸 수 없는 결과(16 bit, CMYK 등). 실패가 아니라 정해진 한계라, 원본은
 * 그대로 두고 편집 결과는 PSD 로 내려받게 한다.
 */
class LossyOverwrite extends Error {}

/** PSD 합성 이미지를 원본과 같은 형식으로 인코딩한다. 원본을 손상 없이 덮어쓸 수 없으면 LossyOverwrite. */
async function encodeComposite(psd: Blob, mime: string) {
  const bytes = new Uint8Array(await psd.arrayBuffer())
  const composite = (() => {
    try {
      return readPsdComposite(bytes)
    } catch (error) {
      // CMYK·Lab·32 bit 처럼 읽지 못하는 PSD: 근사 변환으로 원본 색을 바꿔 쓰지 않는다.
      throw new LossyOverwrite(reason(error))
    }
  })()
  // 16 bit 를 8 bit 로 내려 덮어쓰면 하위 바이트가 되돌릴 수 없게 사라진다. canvas 는 8 bit 만 인코딩한다.
  if (composite.depth !== 8) throw new LossyOverwrite(`${composite.depth}-bit image`)
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

type Translate = (key: string, params?: Record<string, string>) => string
type EditorWindow = Window & typeof globalThis

/** 파일 경로별로 열린 편집 창. 같은 파일을 다시 열면 새로 띄우지 않고 그 창을 앞으로 가져온다. */
const opened = new Map<string, EditorWindow>()

/**
 * 이미지를 PhotoCraft 자식 창으로 연다. 창에서 저장(⌘S)하면 onSave 로 원본을 덮어쓴다.
 * 저장 처리는 이 (부모) 창의 코드가 하므로, 부모가 닫히거나 새로고침되면 자식 창에 그 사실을 알리고
 * PhotoCraft 원래 동작(PSD 내려받기)으로 되돌린다.
 *
 * 팝업이 막혀 창을 못 열었으면 false. 창은 열렸지만 편집기가 뜨지 못하면 onError.
 */
export function openPhotocraftWindow(input: {
  key: string
  file: File
  onSave: (image: Blob) => Promise<void>
  onError: () => void
  t: Translate
}) {
  const existing = opened.get(input.key)
  if (existing && !existing.closed) {
    existing.focus()
    return true
  }

  // noopener 를 주면 부모가 창 문서에 접근할 수 없다. 클릭 핸들러 안에서 동기적으로 불러야 팝업 차단을 피한다.
  const win = window.open(editorUrl(), "_blank", "popup,width=1280,height=860") as EditorWindow | null
  if (!win) return false
  opened.set(input.key, win)

  const session = createSession(win, input)
  const onParentGone = () => session.parentGone()
  window.addEventListener("pagehide", onParentGone)
  // 창이 닫혔는지는 이벤트로 알 수 없어(닫힌 창의 unload 는 부모가 듣기 어렵다) 주기적으로 본다.
  const watch = setInterval(() => {
    if (!win.closed) return
    clearInterval(watch)
    window.removeEventListener("pagehide", onParentGone)
    if (opened.get(input.key) === win) opened.delete(input.key)
    session.dispose()
  }, 1000)

  void session.start().catch(() => {
    // Electron 의 file: 처럼 창 문서에 접근할 수 없으면 창 안에 알릴 수도 없다.
    session.notify(input.t("file.imageEditor.failed"), "error", true)
    input.onError()
  })
  return true
}

function createSession(win: EditorWindow, input: { file: File; onSave: (image: Blob) => Promise<void>; t: Translate }) {
  const { t, file } = input
  const original = fileExtension(file.name)
  const mime = ENCODABLE[original]
  let disposed = false
  let gone = false
  // 저장 뒤에 편집기를 건드렸는지. PhotoCraft 는 변경 여부를 밖에 알려 주지 않아, 캔버스에서 일어난
  // 마우스·키 입력을 변경으로 친다(확대·이동만 해도 경고가 뜰 수 있지만, 편집을 잃는 것보단 낫다).
  let edits = 0
  let savedAt = 0
  const dirty = () => edits !== savedAt
  const restore: Array<() => void> = []

  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!dirty()) return
    event.preventDefault()
    event.returnValue = ""
  }

  // 자식 창 안의 알림. 부모의 토스트는 부모 창에 떠서 편집 중인 사람에게 보이지 않는다.
  let notice: HTMLDivElement | undefined
  let hide: ReturnType<typeof setTimeout> | undefined
  const notify = (text: string, variant: "default" | "success" | "error" = "default", sticky = false) => {
    const doc = win.document
    if (!notice || !notice.isConnected) {
      notice = doc.createElement("div")
      notice.setAttribute("role", "status")
      Object.assign(notice.style, {
        position: "fixed",
        right: "16px",
        bottom: "40px",
        maxWidth: "min(420px, calc(100vw - 32px))",
        padding: "10px 14px",
        borderRadius: "8px",
        font: "13px/1.5 system-ui, sans-serif",
        color: "#f2f2f2",
        boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
        pointerEvents: "none",
        zIndex: "10",
      })
      doc.body.appendChild(notice)
    }
    notice.textContent = text
    notice.style.background = variant === "error" ? "#8f2d2d" : variant === "success" ? "#2f6b3a" : "#3a3a3a"
    notice.style.display = "block"
    if (hide) clearTimeout(hide)
    hide = sticky ? undefined : setTimeout(() => notice && (notice.style.display = "none"), 4000)
  }

  // 원본에 쓰지 못한 편집 결과를 PhotoCraft 원래 방식대로 내려받는다(창 고유 함수로, 가로채지 않게).
  let download: ((blob: Blob, name: string) => void) | undefined

  // 저장이 연달아 눌려도 원본에는 누른 순서대로 쓰이게 한 줄로 세운다. 원본에 쓰지 못하면(서버 거절,
  // 연결 끊김, 손상 없이 바꿀 수 없는 형식) 편집이 갈 곳이 없어지므로 PhotoCraft 가 만든 파일을 내려받는다.
  let saving = Promise.resolve()
  const save = (produce: () => Promise<Blob>, fallback: { blob: Blob; name: string }) => {
    const at = edits
    saving = saving.then(async () => {
      try {
        await input.onSave(await produce())
        if (gone || disposed) return
        savedAt = Math.max(savedAt, at)
        notify(t("file.imageEditor.saved", { name: file.name }), "success")
      } catch (error) {
        if (gone || disposed) return
        download?.(fallback.blob, fallback.name)
        if (error instanceof LossyOverwrite) {
          notify(t("file.imageEditor.saveLossy", { name: fallback.name, detail: error.message }), "error", true)
          return
        }
        const detail = reason(error)
        notify(
          t("file.imageEditor.saveFailed", { name: fallback.name }) + (detail ? ` — ${detail}` : ""),
          "error",
          true,
        )
      }
    })
  }

  // PhotoCraft 의 저장(⌘S)·내보내기는 Blob URL 을 단 <a download> 를 click() 해 내려받는 것뿐이다.
  // 그 click 을 가로채, 원본에 쓸 수 있는 결과면 내려받는 대신 원본 파일에 쓴다. 쓰지 못하는 것은
  // 원래대로 내려받게 둔다. click() 은 앵커와 Blob 이 다 만들어진 뒤라, URL→Blob 을 동기적으로 기억해 둔다.
  const interceptDownloads = () => {
    const blobs = new Map<string, Blob>()
    const url = win.URL
    const createObjectURL = url.createObjectURL
    const revokeObjectURL = url.revokeObjectURL
    url.createObjectURL = (object) => {
      const created = createObjectURL.call(url, object)
      if (object instanceof win.Blob) blobs.set(created, object)
      return created
    }
    url.revokeObjectURL = (target) => {
      blobs.delete(target)
      revokeObjectURL.call(url, target)
    }

    const proto = win.HTMLAnchorElement.prototype
    const click = proto.click
    proto.click = function (this: HTMLAnchorElement) {
      const blob = this.download ? blobs.get(this.href) : undefined
      const saved = blob ? fileExtension(this.download) : ""
      const fallback = { blob: blob!, name: this.download }
      // 원본과 같은 형식으로 내보낸 것은 그 바이트 그대로 쓴다(내보내기 설정을 존중).
      if (blob && sameFormat(saved, original)) return save(async () => blob, fallback)
      // 저장(⌘S)은 언제나 PSD 다. 원본 형식으로 인코딩할 수 있으면 합성 이미지를 꺼내 바꿔 쓴다.
      if (blob && (saved === "psd" || saved === "psb")) {
        if (mime) return save(() => encodeComposite(blob, mime), fallback)
        notify(t("file.imageEditor.saveUnsupported", { ext: original.toUpperCase() }))
      }
      return click.call(this)
    }

    download = (target, name) => {
      const anchor = win.document.createElement("a")
      anchor.href = createObjectURL.call(url, target)
      anchor.download = name
      click.call(anchor)
      setTimeout(() => revokeObjectURL.call(url, anchor.href), 60_000)
    }

    // 부모가 사라지면 이 함수들은 죽은 창의 코드가 되므로 창 고유의 것으로 되돌린다.
    restore.push(() => {
      proto.click = click
      url.createObjectURL = createObjectURL
      url.revokeObjectURL = revokeObjectURL
    })
  }

  // PhotoCraft 는 파일을 넣는 API 가 없고 열기는 파일 선택창뿐이다. 대신 캔버스에 떨어뜨린 파일을
  // 문서로 여므로(eframe 드래그앤드롭), 앱이 뜬 뒤 그 이미지를 담은 drop 이벤트를 캔버스에 보낸다.
  const start = async () => {
    const started = Date.now()
    const wait = () => new Promise((resolve) => setTimeout(resolve, 100))
    const timedOut = () => Date.now() - started > READY_TIMEOUT_MS
    // 막 연 창은 about:blank 였다가 편집기 페이지로 바뀐다. 그 전에 단 리스너는 문서와 함께 사라지므로
    // 편집기 문서가 생길 때까지 기다린다.
    while (!win.document.getElementById("photocraft_canvas")) {
      if (disposed || gone) return
      if (timedOut()) throw new Error("PhotoCraft did not load")
      await wait()
    }
    win.document.title = t("file.imageEditor.title", { name: file.name })
    // index.html 의 #photocraft_loading 은 앱이 이벤트 핸들러를 다 건 뒤 지운다.
    while (win.document.getElementById("photocraft_loading")) {
      if (disposed || gone) return
      if (timedOut()) throw new Error("PhotoCraft did not start")
      await wait()
    }
    const canvas = win.document.getElementById("photocraft_canvas")!
    interceptDownloads()

    const touch = () => edits++
    canvas.addEventListener("pointerdown", touch)
    win.addEventListener("keydown", touch, true)
    win.addEventListener("beforeunload", onBeforeUnload)
    restore.push(() => {
      canvas.removeEventListener("pointerdown", touch)
      win.removeEventListener("keydown", touch, true)
      win.removeEventListener("beforeunload", onBeforeUnload)
    })

    // 이벤트·파일은 자식 창 realm 의 생성자로 만들어야 wasm-bindgen 의 타입 검사(instanceof)를 통과한다.
    const bytes = await file.arrayBuffer()
    if (disposed || gone) return
    const transfer = new win.DataTransfer()
    transfer.items.add(new win.File([bytes], file.name, { type: file.type }))
    const rect = canvas.getBoundingClientRect()
    const point = { clientX: rect.width / 2, clientY: rect.height / 2 }
    for (const type of ["dragenter", "dragover", "drop"]) {
      canvas.dispatchEvent(
        new win.DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true, ...point }),
      )
    }
    notify(mime ? t("file.imageEditor.saveHint") : t("file.imageEditor.saveHintUnsupported"))
    win.focus()
  }

  const detach = () => {
    for (const undo of restore.splice(0)) undo()
  }

  return {
    start,
    notify: (text: string, variant: "default" | "success" | "error", sticky: boolean) => {
      try {
        notify(text, variant, sticky)
      } catch {}
    },
    parentGone() {
      if (gone || disposed || win.closed) return
      gone = true
      try {
        detach()
        notify(t("file.imageEditor.parentGone"), "error", true)
      } catch {}
    },
    dispose() {
      disposed = true
      if (hide) clearTimeout(hide)
    },
  }
}
