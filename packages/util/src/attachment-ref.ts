/**
 * Uploaded attachments (images, PDFs, text files) are stored once as doc assets and referenced
 * from message parts by URL — never inlined as base64, which would duplicate every byte into
 * PartTable and push it down every client's sync stream.
 *
 * The canonical reference is the path `/doc/{docID}/asset/{assetID}`. Parsing tolerates an
 * absolute origin, a server basePath prefix and a query string, so a URL that has been through
 * the app's resolver still round-trips back to its ids.
 */

const PATTERN = /\/doc\/(doc_[^/?#]+)\/asset\/([^/?#]+)/

export type AssetRef = {
  docID: string
  assetID: string
}

export function assetRefUrl(docID: string, assetID: string) {
  return `/doc/${docID}/asset/${encodeURIComponent(assetID)}`
}

export function parseAssetRef(url: string | undefined): AssetRef | undefined {
  if (!url) return
  const match = PATTERN.exec(url)
  if (!match) return
  const [, docID, assetID] = match
  if (!docID || !assetID) return
  try {
    return { docID, assetID: decodeURIComponent(assetID) }
  } catch {
    return { docID, assetID }
  }
}

export function isAssetRef(url: string | undefined): boolean {
  return !!parseAssetRef(url)
}
