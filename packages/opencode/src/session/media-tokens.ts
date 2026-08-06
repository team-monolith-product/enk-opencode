/**
 * Token estimates for media attachments (images and PDFs).
 *
 * Media costs tokens by *content*, not by bytes: a one-page PDF costs the same whether it is
 * 0.3MB or 1.8MB, and a 20-page scan costs the same at 0.3MB as at 8.9MB. Measured on synthetic
 * scans where page count and byte size were varied independently — minimax MiniMax-M3 billed
 * 2,721 tokens/page and Anthropic ~1,560 tokens/page, both perfectly linear in pages and flat
 * in bytes. So anything that sizes media by `url.length` is measuring the wrong axis, by orders
 * of magnitude.
 *
 * These are estimates for accounting (deciding what to prune), never for billing.
 */
export namespace MediaTokens {
  /** Per PDF page. Between the two providers we route to; erring toward the more expensive one. */
  export const PDF_PER_PAGE = 2_700

  /**
   * Per image. Images bill by resolution, which we would have to decode headers to know; the
   * session logs put real attachments in a narrow band (a 211KB screenshot ≈ 1.3k tokens, a
   * 997KB PNG ≈ 2.0k), so a flat estimate is within a small factor — unlike bytes.
   */
  export const IMAGE = 1_600

  /**
   * Fallback when the page count can't be read (PDFs that keep their page objects inside
   * compressed object streams). Counting such a file as zero would hide it from the pruner,
   * which is the exact bug this accounting exists to fix, so assume a nontrivial document.
   */
  export const UNKNOWN_PDF_PAGES = 10

  /**
   * Page count from raw PDF bytes, without a parser: page objects are `/Type /Page` dictionaries
   * (`/Pages` is the tree node, hence the trailing-character check), and the page tree root
   * carries the total as `/Count`. Both live in the uncompressed object soup of a plain PDF;
   * neither is visible when the cross-reference data is packed into object streams.
   */
  export function pdfPageCount(bytes: Uint8Array): number | undefined {
    const text = Buffer.from(bytes).toString("latin1")
    const pages = text.match(/\/Type\s*\/Page(?![\w])/g)?.length
    if (pages) return pages
    // No page objects in the clear — fall back to the tree's own count. Nested page trees each
    // carry one, and the root's is the largest.
    const counts = text.match(/\/Count\s+(\d+)/g)
    if (!counts) return undefined
    const max = Math.max(...counts.map((match) => Number.parseInt(match.replace(/\/Count\s+/, ""), 10)))
    return Number.isFinite(max) && max > 0 ? max : undefined
  }

  const base64Payload = (url: string) => {
    if (!url.startsWith("data:")) return undefined
    const comma = url.indexOf(",")
    return comma === -1 ? undefined : url.slice(comma + 1)
  }

  /** Estimated tokens one attachment adds to a request. Non-media attachments count as zero. */
  export function estimate(attachment: { mime: string; url: string }): number {
    if (attachment.mime === "application/pdf") {
      const payload = base64Payload(attachment.url)
      const pages = payload ? pdfPageCount(Buffer.from(payload, "base64")) : undefined
      return (pages ?? UNKNOWN_PDF_PAGES) * PDF_PER_PAGE
    }
    if (attachment.mime.startsWith("image/")) return IMAGE
    return 0
  }

  export function estimateAll(attachments?: Array<{ mime: string; url: string }>): number {
    let total = 0
    for (const attachment of attachments ?? []) total += estimate(attachment)
    return total
  }
}
