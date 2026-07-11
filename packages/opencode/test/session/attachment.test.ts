import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Effect, Layer } from "effect"
import { Attachment } from "../../src/session/attachment"
import { AppFileSystem } from "../../src/filesystem"
import { ATTACHMENT_DIR } from "../../src/session/attachment-dir"
import { decodeDataUrlBytes } from "../../src/util/data-url"

const layer = Attachment.layer.pipe(Layer.provideMerge(AppFileSystem.defaultLayer))

function run<A>(program: Effect.Effect<A, unknown, Attachment.Service>) {
  return Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))))
}

const save = (input: { url: string; mime: string; filename?: string }) =>
  run(
    Effect.gen(function* () {
      const attachment = yield* Attachment.Service
      return yield* attachment.save(input)
    }),
  )

// 1x1 transparent png
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"

describe("Attachment.save", () => {
  test("writes the decoded bytes to disk and returns the path", async () => {
    const saved = await save({ url: PNG, mime: "image/png", filename: "shot.png" })
    expect(saved).toBeTruthy()
    expect(fs.existsSync(saved!)).toBe(true)
    const onDisk = new Uint8Array(fs.readFileSync(saved!))
    expect(onDisk).toEqual(new Uint8Array(decodeDataUrlBytes(PNG)))
  })

  test("stores the file directly under ATTACHMENT_DIR with a prt_-prefixed name", async () => {
    const saved = await save({ url: PNG, mime: "image/png", filename: "shot.png" })
    expect(path.dirname(saved!)).toBe(ATTACHMENT_DIR)
    expect(path.basename(saved!)).toMatch(/^prt_[^/\\]+-shot\.png$/)
  })

  test("keeps the original text extension (e.g. .html) rather than the mime extension", async () => {
    const html = "<!doctype html><h1>hi</h1>"
    const url = `data:text/plain;base64,${Buffer.from(html, "utf8").toString("base64")}`
    const saved = await save({ url, mime: "text/plain", filename: "index.html" })
    expect(saved!.endsWith("-index.html")).toBe(true)
    expect(fs.readFileSync(saved!, "utf8")).toBe(html)
  })

  test("sanitizes a traversal filename so it cannot escape ATTACHMENT_DIR", async () => {
    const saved = await save({ url: PNG, mime: "image/png", filename: "../../../etc/passwd" })
    // The stored file must live inside ATTACHMENT_DIR, never at the client-supplied path.
    expect(path.dirname(saved!)).toBe(ATTACHMENT_DIR)
    const base = path.basename(saved!)
    expect(base).not.toContain("/")
    expect(base).not.toContain("..")
    expect(base.endsWith("-passwd")).toBe(true)
  })

  test("returns undefined for an empty data url and writes nothing", async () => {
    const saved = await save({ url: "data:text/plain;base64,", mime: "text/plain", filename: "empty.txt" })
    expect(saved).toBeUndefined()
  })

  test("returns undefined for a non data url", async () => {
    const saved = await save({ url: "not-a-data-url", mime: "text/plain", filename: "x.txt" })
    expect(saved).toBeUndefined()
  })
})
