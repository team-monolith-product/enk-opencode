import { and, eq } from "drizzle-orm"
import { parseAssetRef } from "@opencode-ai/util/attachment-ref"
import { DocAssetTable } from "@/doc/doc.sql"
import { AssetID, DocID } from "@/doc/schema"
import { Database } from "@/storage/db"

/**
 * Reads the bytes behind an `/doc/{docID}/asset/{assetID}` attachment reference.
 *
 * Queries the asset table directly instead of going through `Doc` — `doc/index.ts` imports
 * `session/prompt.ts`, so a static import the other way would close an import cycle. Returns
 * undefined for a url that is not a reference and for an asset that is gone, so callers can
 * fall back instead of failing the prompt.
 */
export function loadAssetRef(url: string | undefined) {
  const ref = parseAssetRef(url)
  if (!ref) return undefined
  const row = Database.use((db) =>
    db
      .select()
      .from(DocAssetTable)
      .where(and(eq(DocAssetTable.doc_id, DocID.make(ref.docID)), eq(DocAssetTable.id, AssetID.make(ref.assetID))))
      .get(),
  )
  if (!row) return undefined
  const raw = row.data
  return {
    ...ref,
    mime: row.mime,
    data: raw instanceof Uint8Array ? new Uint8Array(raw) : new Uint8Array(Buffer.from(raw as Buffer)),
  }
}
