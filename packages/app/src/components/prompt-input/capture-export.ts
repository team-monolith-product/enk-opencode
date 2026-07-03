import type Konva from "konva"

// 내보내기 최장변 상한(과거 drawing-limits.ts 의 DRAW_*_MAX_EDGE 와 동일). 첨부 payload 를 제한한다.
export const EXPORT_MAX_EDGE = 2048

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = reject
    el.src = src
  })
}

type ExportRegion = { x: number; y: number; width: number; height: number; pixelRatio: number }

// Konva 버전마다 toBlob 이 Promise / callback 둘 중 하나라서 양쪽을 모두 흡수하고,
// 실패 시 toCanvas → canvas.toBlob 으로 폴백한다.
export function stageToBlob(stage: Konva.Stage, region: ExportRegion): Promise<Blob | null> {
  const config = { ...region, mimeType: "image/png" }
  return new Promise((resolve) => {
    let settled = false
    const done = (blob: Blob | null) => {
      if (settled) return
      settled = true
      resolve(blob)
    }
    const fallback = () => {
      try {
        const canvas = (stage as unknown as { toCanvas: (c: ExportRegion) => HTMLCanvasElement }).toCanvas(region)
        canvas.toBlob((blob) => done(blob), "image/png")
      } catch {
        done(null)
      }
    }
    try {
      const maybe = (
        stage as unknown as {
          toBlob: (c: typeof config & { callback?: (b: Blob | null) => void }) => unknown
        }
      ).toBlob({ ...config, callback: (b: Blob | null) => done(b) })
      if (maybe && typeof (maybe as Promise<Blob | null>).then === "function") {
        ;(maybe as Promise<Blob | null>).then(done).catch(fallback)
      }
    } catch {
      fallback()
    }
  })
}

export function blobToPngFile(blob: Blob): File {
  return new File([blob], `tab-capture-${Date.now()}.png`, { type: "image/png" })
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob | undefined> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob ?? undefined), mime, quality)
    } catch {
      resolve(undefined)
    }
  })
}

// 이미지를 주어진 최장변으로(비율 유지, 확대 금지) 그려 WebP 로 재인코딩한다.
// WebP 미지원 브라우저는 toBlob 이 다른 타입을 내므로 JPEG 로 폴백한다.
async function reencodeAtEdge(
  img: HTMLImageElement,
  sw: number,
  sh: number,
  maxEdge: number,
  quality: number,
): Promise<Blob | undefined> {
  const scale = Math.min(1, maxEdge / Math.max(sw, sh))
  const dw = Math.max(1, Math.round(sw * scale))
  const dh = Math.max(1, Math.round(sh * scale))
  const canvas = document.createElement("canvas")
  canvas.width = dw
  canvas.height = dh
  const ctx = canvas.getContext("2d")
  if (!ctx) return undefined
  ctx.drawImage(img, 0, 0, dw, dh)
  const webp = await canvasToBlob(canvas, "image/webp", quality)
  if (webp && webp.type === "image/webp") return webp
  return (await canvasToBlob(canvas, "image/jpeg", quality)) ?? webp
}

function blobToImageFile(blob: Blob, originalName: string): File {
  const suffix = blob.type === "image/webp" ? "webp" : "jpg"
  const base = originalName.replace(/\.[^.]+$/, "") || "capture"
  return new File([blob], `${base}.${suffix}`, { type: blob.type })
}

// 재인코딩 시 최장변을 줄여가는 하한. 이보다 작게는 줄이지 않는다(가독성 유지).
const FIT_MIN_EDGE = 320
// 재인코딩 품질(0~1). 스크린샷 첨부용으로 충분한 값.
const FIT_QUALITY = 0.85

/**
 * 이미지 File 이 바이트 상한을 넘으면 상한 이하로 "맞춰"(fit) 돌려준다.
 *
 * - 이미 상한 이하이거나 이미지가 아니면 **원본 그대로** 반환한다(호출부가 비이미지 초과는 거절).
 * - 넘으면 먼저 **해상도 유지로 WebP/JPEG 재인코딩**한다. 스크린샷 PNG 는 대개 이 한 번으로
 *   무손실 대비 수십분의 1 로 줄어 상한 밑으로 떨어진다(해상도 손실 없음).
 * - 그래도 넘으면 최장변을 단계적으로(×0.75) 줄여가며 상한 이하가 될 때까지 재인코딩한다.
 * - canvas/toBlob 미지원·인코딩 실패 등으로 못 줄이면 원본을 그대로 반환한다(호출부가 크기 재확인).
 *
 * 목적: 미리보기 캡처처럼 풀 해상도라 상한을 넘는 이미지를 "거절"하지 않고 전송 가능한 크기로 자동 축소.
 */
export async function fitImageToByteLimit(file: File, maxBytes: number): Promise<File> {
  if (file.size <= maxBytes) return file
  if (!file.type.startsWith("image/")) return file

  const url = URL.createObjectURL(file)
  try {
    const img = await loadImage(url)
    const sw = img.naturalWidth || img.width
    const sh = img.naturalHeight || img.height
    if (!sw || !sh) return file

    let maxEdge = Math.max(sw, sh)
    let smallest: Blob | undefined
    for (let i = 0; i < 8; i++) {
      const blob = await reencodeAtEdge(img, sw, sh, maxEdge, FIT_QUALITY)
      if (blob && (!smallest || blob.size < smallest.size)) smallest = blob
      if (blob && blob.size <= maxBytes) return blobToImageFile(blob, file.name)
      if (maxEdge <= FIT_MIN_EDGE) break
      maxEdge = Math.max(FIT_MIN_EDGE, Math.floor(maxEdge * 0.75))
    }
    // 상한까지는 못 내려도 원본보다 작아졌으면 그거라도 쓴다(전송 실패 확률↓).
    if (smallest && smallest.size < file.size) return blobToImageFile(smallest, file.name)
    return file
  } catch {
    return file
  } finally {
    URL.revokeObjectURL(url)
  }
}
