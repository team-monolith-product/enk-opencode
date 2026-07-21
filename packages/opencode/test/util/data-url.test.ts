import { describe, expect, test } from "bun:test"
import { decodeDataUrl, decodeDataUrlBytes } from "../../src/util/data-url"

describe("decodeDataUrl", () => {
  test("decodes base64 data URLs", () => {
    const body = '{\n  "ok": true\n}\n'
    const url = `data:text/plain;base64,${Buffer.from(body).toString("base64")}`
    expect(decodeDataUrl(url)).toBe(body)
  })

  test("decodes plain data URLs", () => {
    expect(decodeDataUrl("data:text/plain,hello%20world")).toBe("hello world")
  })

  test("returns empty string when there is no comma separator", () => {
    expect(decodeDataUrl("not-a-data-url")).toBe("")
    expect(decodeDataUrl("")).toBe("")
  })

  test("decodes multibyte utf-8 payloads round-trip", () => {
    const body = "한글 😀 café"
    const url = `data:text/plain;base64,${Buffer.from(body, "utf8").toString("base64")}`
    expect(decodeDataUrl(url)).toBe(body)
  })
})

describe("decodeDataUrlBytes", () => {
  test("decodes base64 payloads to their exact bytes", () => {
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0x7f, 0x80])
    const url = `data:application/octet-stream;base64,${bytes.toString("base64")}`
    expect(decodeDataUrlBytes(url).equals(bytes)).toBe(true)
  })

  test("decodes non-base64 (percent-encoded) payloads as utf-8 bytes", () => {
    // "a b" — the space is percent-encoded; the result must be the raw utf-8 bytes, not the encoded form.
    expect(decodeDataUrlBytes("data:text/plain,a%20b").equals(Buffer.from("a b", "utf8"))).toBe(true)
  })

  test("preserves multibyte utf-8 bytes for base64 payloads", () => {
    const body = "café 😀"
    const url = `data:text/plain;base64,${Buffer.from(body, "utf8").toString("base64")}`
    expect(decodeDataUrlBytes(url).equals(Buffer.from(body, "utf8"))).toBe(true)
  })

  test("returns an empty buffer when there is no comma separator", () => {
    expect(decodeDataUrlBytes("garbage").length).toBe(0)
    expect(decodeDataUrlBytes("").length).toBe(0)
  })
})
