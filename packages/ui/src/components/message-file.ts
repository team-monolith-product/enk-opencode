import type { FilePart } from "@opencode-ai/sdk/v2"
import { isAssetRef } from "@opencode-ai/util/attachment-ref"

export function attached(part: FilePart) {
  // An upload the user attached to the prompt: a `/doc/{docID}/asset/{assetID}` reference to the
  // stored bytes, or — for messages sent before uploads moved to the asset store — an inline data
  // url. Everything else is a workspace file reference, which renders as text, not as a chip.
  return part.url.startsWith("data:") || isAssetRef(part.url)
}

export function inline(part: FilePart) {
  if (attached(part)) return false
  return part.source?.text?.start !== undefined && part.source?.text?.end !== undefined
}

export function kind(part: FilePart) {
  return part.mime.startsWith("image/") ? "image" : "file"
}
