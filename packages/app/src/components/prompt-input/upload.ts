import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { assetRefUrl } from "@opencode-ai/util/attachment-ref"

function b64(bytes: Uint8Array) {
  // Chunked: spreading a multi-megabyte array into String.fromCharCode blows the call stack.
  const size = 0x8000
  let binary = ""
  for (let i = 0; i < bytes.length; i += size) {
    binary += String.fromCharCode(...bytes.subarray(i, i + size))
  }
  return btoa(binary)
}

type UploadInput = {
  client: OpencodeClient
  directory: string
  docID: string
  file: File
  mime: string
}

/**
 * Stores a composer attachment in the doc asset store and returns the reference url the prompt
 * part carries. Doc-mode uploads already land there through BlockSuite's blob sync — this is the
 * same destination for files dropped or pasted into the plain composer, so no prompt part ever
 * has to carry base64. Returns undefined when the upload fails; the caller must not attach.
 */
export async function uploadAttachment(input: UploadInput) {
  const bytes = new Uint8Array(await input.file.arrayBuffer())
  const res = await input.client.doc.asset.create(
    {
      docID: input.docID,
      directory: input.directory,
      mime: input.mime,
      data: b64(bytes),
    },
    { throwOnError: false },
  )
  const assetID = res.data?.assetID
  if (!assetID) return undefined
  return assetRefUrl(input.docID, assetID)
}
