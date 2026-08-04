import { describe, expect, test } from "bun:test"
import { assetRefUrl, isAssetRef, parseAssetRef } from "./attachment-ref"

describe("attachment-ref", () => {
  test("round-trips a doc asset reference", () => {
    const url = assetRefUrl("doc_1", "asset_1")
    expect(url).toBe("/doc/doc_1/asset/asset_1")
    expect(parseAssetRef(url)).toEqual({ docID: "doc_1", assetID: "asset_1" })
  })

  test("parses through an origin, a base path and a query", () => {
    expect(parseAssetRef("http://localhost:4096/doc/doc_1/asset/hash?directory=%2Ftmp")).toEqual({
      docID: "doc_1",
      assetID: "hash",
    })
    expect(parseAssetRef("https://host/user/abc/doc/doc_1/asset/hash")).toEqual({
      docID: "doc_1",
      assetID: "hash",
    })
  })

  test("keeps asset ids that need escaping intact", () => {
    const ref = parseAssetRef(assetRefUrl("doc_1", "a b/c"))
    expect(ref).toEqual({ docID: "doc_1", assetID: "a b/c" })
  })

  test("rejects everything that is not an asset reference", () => {
    expect(isAssetRef("data:image/png;base64,AAA")).toBe(false)
    expect(isAssetRef("file:///repo/doc/notes.md")).toBe(false)
    expect(isAssetRef("/doc/doc_1/sync")).toBe(false)
    expect(isAssetRef(undefined)).toBe(false)
  })
})
