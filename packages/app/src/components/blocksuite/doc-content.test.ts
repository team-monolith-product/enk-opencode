import { AffineSchemas } from "@blocksuite/blocks/schemas"
import { DocCollection, Schema, Text, type Doc } from "@blocksuite/store"
import { afterEach, describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { docMarkdown, docPlain } from "./doc-content"
import { initDoc } from "./doc-init"
import { withFileReferenceSchema } from "./file-reference-block"
import { withLineReferenceSchema } from "./line-reference-block"

type Opts = Parameters<typeof docMarkdown>[1]
type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const cols: DocCollection[] = []

function page() {
  const schema = new Schema().register(withLineReferenceSchema(withFileReferenceSchema(AffineSchemas)))
  const col = new DocCollection({ schema })
  cols.push(col)
  col.meta.initialize()
  const doc = col.createDoc({ id: "page" })
  initDoc(doc)
  const note = doc.getBlockByFlavour("affine:note")[0]
  if (!note) throw new Error("missing note")
  return { doc, note: note.id }
}

function opts(fetch: Fetch): Opts {
  return {
    docID: "doc_1",
    directory: "/tmp/project",
    client: createOpencodeClient({
      baseUrl: "http://localhost:4096",
      directory: "/tmp/project",
      fetch: fetch as unknown as typeof globalThis.fetch,
      throwOnError: true,
    }),
  }
}

function add(doc: Doc, flavour: string, props: Record<string, unknown>, parent: string) {
  return doc.addBlock(flavour as never, props as never, parent)
}

describe("docMarkdown", () => {
  afterEach(() => {
    cols.splice(0).forEach((col) => col.dispose())
  })

  test("serializes BlockSuite embeds into json code blocks", async () => {
    const ctx = page()

    add(
      ctx.doc,
      "affine:embed-youtube",
      {
        url: "https://www.youtube.com/watch?v=clip",
        title: "Tropical House",
        description: "Album cover reference",
        creator: "Channel",
        creatorUrl: "https://youtube.com/@channel",
        videoId: "clip",
        caption: "Watch this",
      },
      ctx.note,
    )

    const out = await docMarkdown(
      ctx.doc,
      opts(async () => new Response(null, { status: 404 })),
    )

    expect(out.text).toContain("```json")
    expect(out.text).toContain('"type": "youtube"')
    expect(out.text).toContain('"url": "https://www.youtube.com/watch?v=clip"')
    expect(out.text).toContain('"title": "Tropical House"')
    expect(out.text).toContain('"caption": "Watch this"')
    expect(out.text).toContain('"description": "Album cover reference"')
    expect(out.text).toContain('"creator": "Channel"')
    expect(out.text).toContain('"creatorUrl": "https://youtube.com/@channel"')
    expect(out.text).toContain('"videoId": "clip"')
    expect(docPlain(ctx.doc)).toContain("Tropical House")
  })

  test("serializes file reference blocks into markdown links", async () => {
    const ctx = page()

    add(
      ctx.doc,
      "opencode:file-reference",
      {
        name: ".prettierignore",
        path: ".prettierignore",
        url: ".prettierignore",
      },
      ctx.note,
    )

    const out = await docMarkdown(
      ctx.doc,
      opts(async () => new Response(null, { status: 404 })),
    )

    expect(out.text).toContain("[.prettierignore](.prettierignore)")
    expect(docPlain(ctx.doc)).toContain(".prettierignore")
  })

  test("serializes folder reference blocks into folder notes", async () => {
    const ctx = page()

    add(
      ctx.doc,
      "opencode:file-reference",
      {
        name: "assets",
        path: "src/assets",
        url: "src/assets",
        nodeType: "directory",
      },
      ctx.note,
    )

    const out = await docMarkdown(
      ctx.doc,
      opts(async () => new Response(null, { status: 404 })),
    )

    expect(out.text).toContain("referenced folder src/assets")
    expect(out.text).toContain("[assets](src/assets)")
    expect(docPlain(ctx.doc)).toContain("assets")
  })

  test("serializes line reference blocks into notes and links", async () => {
    const ctx = page()

    add(
      ctx.doc,
      "opencode:line-reference",
      {
        name: "foo.ts",
        path: "src/foo.ts",
        url: "src/foo.ts?start=3&end=5",
        start: 3,
        end: 5,
        comment: "check this",
      },
      ctx.note,
    )

    const out = await docMarkdown(
      ctx.doc,
      opts(async () => new Response(null, { status: 404 })),
    )

    expect(out.text).toContain("lines 3 through 5 of src/foo.ts")
    expect(out.text).toContain("check this")
    expect(out.text).toContain("[foo.ts L3–5](src/foo.ts?start=3&end=5)")
    expect(docPlain(ctx.doc)).toContain("foo.ts")
    expect(docPlain(ctx.doc)).toContain("check this")
  })

  test("serializes single-line reference", async () => {
    const ctx = page()

    add(
      ctx.doc,
      "opencode:line-reference",
      {
        name: "bar.ts",
        path: "bar.ts",
        url: "bar.ts?start=5&end=5",
        start: 5,
        end: 5,
        label: "Line 5",
      },
      ctx.note,
    )

    const out = await docMarkdown(
      ctx.doc,
      opts(async () => new Response(null, { status: 404 })),
    )

    expect(out.text).toContain("line 5 of bar.ts")
    expect(out.text).toContain("[bar.ts L5](bar.ts?start=5&end=5)")
    expect(docPlain(ctx.doc)).toContain("L5")
  })

  test("serializes line reference with diff side", async () => {
    const ctx = page()

    add(
      ctx.doc,
      "opencode:line-reference",
      {
        name: "diff.ts",
        path: "diff.ts",
        url: "diff.ts?start=10&end=20&side=additions",
        start: 10,
        end: 20,
        side: "additions",
        label: "Lines 10–20",
      },
      ctx.note,
    )

    const out = await docMarkdown(
      ctx.doc,
      opts(async () => new Response(null, { status: 404 })),
    )

    expect(out.text).toContain("lines 10 through 20 of diff.ts")
    expect(out.text).not.toContain("(diff: additions)")
    expect(out.text).toContain("[diff.ts L10–20](diff.ts?start=10&end=20&side=additions)")
  })

  test("serializes attachments into markdown and assets", async () => {
    const ctx = page()

    add(
      ctx.doc,
      "affine:attachment",
      {
        sourceId: "file_1",
        name: "brief.pdf",
        type: "application/pdf",
        size: 3,
      },
      ctx.note,
    )

    const out = await docMarkdown(
      ctx.doc,
      opts(async () =>
        new Response(new TextEncoder().encode("%PDF-1.7\n"), { headers: { "Content-Type": "application/pdf" } }),
      ),
    )

    expect(out.text).toContain("[brief.pdf](attachment://brief.pdf)")
    expect(out.text).toContain("- Type: application/pdf")
    expect(out.text).toContain("- Size: 3")
    expect(out.assets).toHaveLength(1)
    expect(out.assets[0]).toMatchObject({
      id: "file_1",
      mime: "application/pdf",
      filename: "brief.pdf",
    })
    expect(out.missing).toHaveLength(0)
    expect(docPlain(ctx.doc)).toContain("brief.pdf")
  })

  test("reports an attachment the server does not have instead of dropping it silently", async () => {
    const ctx = page()

    add(
      ctx.doc,
      "affine:attachment",
      { sourceId: "gone_1", name: "notes.pdf", type: "application/pdf", size: 9 },
      ctx.note,
    )

    const out = await docMarkdown(
      ctx.doc,
      opts(async () => new Response("not found", { status: 404 })),
    )

    // The link still goes into the markdown, but nothing carries the bytes — that mismatch is the
    // whole bug, so the caller has to be told rather than left to send a dangling reference.
    expect(out.text).toContain("[notes.pdf](attachment://notes.pdf)")
    expect(out.assets).toHaveLength(0)
    expect(out.missing).toEqual([{ id: "gone_1", blockId: expect.any(String), name: "notes.pdf" }])
  })

  test("reports an image the server does not have", async () => {
    const ctx = page()

    add(ctx.doc, "affine:image", { sourceId: "gone_2", caption: "shot.png", size: 4 }, ctx.note)

    const out = await docMarkdown(
      ctx.doc,
      opts(async () => new Response("not found", { status: 404 })),
    )

    expect(out.text).toContain("![shot.png](attachment://gone_2)")
    expect(out.assets).toHaveLength(0)
    expect(out.missing).toEqual([{ id: "gone_2", blockId: expect.any(String), name: "shot.png" }])
  })

  test("a stored asset that is not exportable is not missing", async () => {
    const ctx = page()

    add(
      ctx.doc,
      "affine:attachment",
      { sourceId: "zip_2", name: "project.sb3", type: "image/png", size: 4 },
      ctx.note,
    )

    const out = await docMarkdown(
      ctx.doc,
      opts(async () =>
        new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { headers: { "Content-Type": "image/png" } }),
      ),
    )

    // The bytes ARE on the server; only the mime keeps them out of the file parts. The link the model
    // gets is all this asset was ever going to contribute, so sending is fine.
    expect(out.assets).toHaveLength(0)
    expect(out.missing).toHaveLength(0)
  })

  test("keeps mislabeled binary attachments out of assets", async () => {
    const ctx = page()

    add(
      ctx.doc,
      "affine:attachment",
      {
        sourceId: "zip_1",
        name: "project.sb3",
        type: "image/png",
        size: 4,
      },
      ctx.note,
    )

    const out = await docMarkdown(
      ctx.doc,
      opts(async () =>
        new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { headers: { "Content-Type": "image/png" } }),
      ),
    )

    expect(out.text).toContain("[project.sb3](attachment://project.sb3)")
    expect(out.text).toContain("- Type: image/png")
    expect(out.assets).toHaveLength(0)
    expect(docPlain(ctx.doc)).toContain("project.sb3")
  })

  test("exports text attachments served as octet-stream with text/plain mime", async () => {
    const ctx = page()

    add(
      ctx.doc,
      "affine:attachment",
      {
        sourceId: "doc_asset_1",
        name: "notes.md",
        type: "text/markdown",
        size: 14,
      },
      ctx.note,
    )

    const body = "# Hello\n\n안녕"
    const out = await docMarkdown(
      ctx.doc,
      opts(async () =>
        new Response(new TextEncoder().encode(body), {
          headers: { "Content-Type": "application/octet-stream" },
        }),
      ),
    )

    expect(out.text).toContain("[notes.md](attachment://notes.md)")
    expect(out.assets).toHaveLength(1)
    expect(out.assets[0]).toMatchObject({
      id: "doc_asset_1",
      mime: "text/plain",
      filename: "notes.md",
      // The bytes stay server-side: the prompt carries only the reference to the stored asset.
      url: "/doc/doc_1/asset/doc_asset_1",
    })
  })

  test("keeps binary attachments served as octet-stream out of assets", async () => {
    const ctx = page()

    add(
      ctx.doc,
      "affine:attachment",
      {
        sourceId: "zip_2",
        name: "bundle.zip",
        type: "application/zip",
        size: 4,
      },
      ctx.note,
    )

    const out = await docMarkdown(
      ctx.doc,
      opts(async () =>
        new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          headers: { "Content-Type": "application/octet-stream" },
        }),
      ),
    )

    expect(out.text).toContain("[bundle.zip](attachment://bundle.zip)")
    expect(out.assets).toHaveLength(0)
  })

  test("serializes rich BlockSuite blocks into markdown", async () => {
    const ctx = page()

    add(ctx.doc, "affine:code", { text: new Text("const value = 1"), language: "ts", caption: "Snippet" }, ctx.note)
    add(ctx.doc, "affine:latex", { latex: "E=mc^2" }, ctx.note)
    add(ctx.doc, "affine:divider", {}, ctx.note)
    add(
      ctx.doc,
      "affine:embed-html",
      { html: '<iframe src="https://example.com"></iframe>', caption: "Demo" },
      ctx.note,
    )

    const out = await docMarkdown(
      ctx.doc,
      opts(async () => new Response(null, { status: 404 })),
    )

    expect(out.text).toContain("Code: Snippet")
    expect(out.text).toContain("```ts\nconst value = 1\n```")
    expect(out.text).toContain("$$\nE=mc^2\n$$")
    expect(out.text).toContain("---")
    expect(out.text).toContain('"type": "html"')
    expect(out.text).toContain('"caption": "Demo"')
    expect(out.text).toContain('"html": "<iframe src=\\"https://example.com\\"></iframe>"')
    expect(docPlain(ctx.doc)).toContain("const value = 1")
    expect(docPlain(ctx.doc)).toContain("E=mc^2")
  })
})
