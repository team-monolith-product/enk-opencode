export type PdfFit = "auto" | "width" | "height" | "none"

export type PdfSize = { width: number; height: number }

export const PDF_ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.5, 2]
export const PDF_ZOOM_DEFAULT = PDF_ZOOM_LEVELS.indexOf(1)
const PDF_PAGE_PADDING = 4

const WIDTH_SLACK = 2 * PDF_PAGE_PADDING + 16
const HEIGHT_SLACK = 2 * PDF_PAGE_PADDING + 2
const MIN_SCALE = 0.05

export function pdfScale(input: { container?: PdfSize; page?: PdfSize; fit: PdfFit; zoom: number }) {
  const fixed = PDF_ZOOM_LEVELS[input.zoom] ?? 1
  const { container, page } = input
  if (!container || !page || page.width === 0 || page.height === 0) return fixed
  if (input.fit === "none") return fixed

  const width = (container.width - WIDTH_SLACK) / page.width
  const height = (container.height - HEIGHT_SLACK) / page.height
  const scale = input.fit === "width" ? width : input.fit === "height" ? height : Math.min(width, height)
  return Math.max(scale, MIN_SCALE)
}

export function pdfZoomPercent(scale: number) {
  return Math.floor(scale * 100)
}

export function pdfPageForKey(key: string, page: number, total: number) {
  if (key === "ArrowLeft") return page > 1 ? page - 1 : undefined
  if (key === "ArrowRight") return page < total ? page + 1 : undefined
  if (key === "Home") return 1
  if (key === "End") return total
}

export function pdfPageInput(raw: string, total: number) {
  const digits = raw.replace(/\D/g, "")
  if (!digits) return
  return Math.min(Math.max(Number.parseInt(digits, 10), 1), Math.max(total, 1))
}

export function pdfBytesFromDataUrl(url: string) {
  const comma = url.indexOf(",")
  if (comma === -1 || !url.slice(0, comma).endsWith(";base64")) return
  const raw = atob(url.slice(comma + 1))
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}
