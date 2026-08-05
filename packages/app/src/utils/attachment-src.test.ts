import { describe, expect, test } from "bun:test"
import { attachmentSrc } from "./attachment-src"

const base = { baseUrl: "http://localhost:4096", directory: "/tmp/project" }

describe("attachmentSrc", () => {
  test("points an asset reference at the server, scoped to the directory", () => {
    expect(attachmentSrc({ ...base, url: "/doc/doc_1/asset/asset_1" })).toBe(
      "http://localhost:4096/doc/doc_1/asset/asset_1?directory=%2Ftmp%2Fproject",
    )
  })

  test("keeps a base path in the server url", () => {
    expect(attachmentSrc({ ...base, baseUrl: "https://host/user/alice", url: "/doc/doc_1/asset/asset_1" })).toBe(
      "https://host/user/alice/doc/doc_1/asset/asset_1?directory=%2Ftmp%2Fproject",
    )
  })

  test("leaves anything that is not an asset reference alone", () => {
    expect(attachmentSrc({ ...base, url: "data:image/png;base64,AAA" })).toBe("data:image/png;base64,AAA")
    expect(attachmentSrc({ ...base, url: "file:///repo/README.md" })).toBe("file:///repo/README.md")
  })
})
