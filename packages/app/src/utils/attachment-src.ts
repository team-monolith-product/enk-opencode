import { isAssetRef } from "@opencode-ai/util/attachment-ref"
import { apiUrl } from "@/utils/api-url"

/**
 * Makes an attachment part's url loadable by the browser. Uploads are stored as
 * `/doc/{docID}/asset/{assetID}` references, which are relative to the opencode server rather than
 * to the app, and the asset route is directory-scoped. Anything else (a legacy data url, a
 * file:// reference) is handed back untouched.
 */
export function attachmentSrc(input: { baseUrl: string; directory: string; url: string }) {
  if (!isAssetRef(input.url)) return input.url
  const next = apiUrl(input.baseUrl, input.url)
  next.searchParams.set("directory", input.directory)
  return next.toString()
}
