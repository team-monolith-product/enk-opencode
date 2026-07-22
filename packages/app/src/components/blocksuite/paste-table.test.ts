import { HtmlAdapter } from "@blocksuite/blocks"
import { AffineSchemas } from "@blocksuite/blocks/schemas"
import { DocCollection, Job, Schema, type Doc } from "@blocksuite/store"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { afterEach, describe, expect, test } from "bun:test"
import { docMarkdown } from "./doc-content"
import { initDoc } from "./doc-init"
import { withFileReferenceSchema } from "./file-reference-block"
import { withLineReferenceSchema } from "./line-reference-block"

// Regression guard for the patched database html adapter
// (patches/@blocksuite%2Fblocks@0.0.0-canary-20250316001624.patch). Upstream
// only read direct text children of a <td>/<th>, so any cell wrapped in an
// inline element (a link, bold, code) pasted as an empty cell, and a table
// whose rows are not preceded by a <thead> threw instead of pasting.

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
  return { col, doc, note: note.id }
}

/** Runs the clipboard html through the adapter, the way a paste of `text/html` does. */
async function snapshot(html: string, ctx = page()) {
  const job = new Job({ collection: ctx.col })
  const slice = await new HtmlAdapter(job).toSliceSnapshot({
    file: html,
    assets: job.assetsManager,
    blockVersions: ctx.col.meta.blockVersions ?? {},
    pageId: ctx.doc.id,
    workspaceId: ctx.col.id,
  })
  return { ...ctx, job, slice }
}

/** The pasted table, read back the way the database block renders it. */
async function paste(html: string) {
  const { slice } = await snapshot(html)
  const find = (node: any): any =>
    node?.flavour === "affine:database" ? node : (node?.children ?? []).map(find).find(Boolean)
  const database = (slice?.content ?? []).map(find).find(Boolean)
  if (!database) throw new Error("missing database block")
  const columns = database.props.columns as Array<{ id: string; name: string }>
  const cells = database.props.cells as Record<string, Record<string, { value: { delta: unknown[] } }>>
  return {
    // The title column is stored as a child paragraph, not in `cells`.
    titles: (database.children ?? []).map((child: any) => child.props.text.delta),
    names: columns.map((column) => column.name),
    rows: Object.values(cells).map((row) => columns.map((column) => row[column.id]?.value.delta ?? [])),
  }
}

function texts(doc: Doc) {
  const found: string[] = []
  const walk = (model: any) => {
    model.text?.toDelta().forEach((op: any) => found.push(op.insert))
    model.children?.forEach(walk)
  }
  if (doc.root) walk(doc.root)
  return found
}

describe("html table paste", () => {
  afterEach(() => {
    cols.splice(0).forEach((col) => col.dispose())
  })

  test("keeps links inside cells", async () => {
    const { rows } = await paste(
      `<table><thead><tr><th>name</th><th>link</th></tr></thead><tbody>` +
        `<tr><td>plain</td><td><a href="https://example.com">label</a></td></tr>` +
        `</tbody></table>`,
    )
    expect(rows[0]).toEqual([
      [{ insert: "plain" }],
      [{ insert: "label", attributes: { link: "https://example.com" } }],
    ])
  })

  test("keeps inline formatting inside cells", async () => {
    const { rows } = await paste(
      `<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody>` +
        `<tr><td>plain</td><td><b>bold</b><code>code</code></td></tr>` +
        `</tbody></table>`,
    )
    expect(rows[0]?.[1]).toEqual([
      { insert: "bold", attributes: { bold: true } },
      { insert: "code", attributes: { code: true } },
    ])
  })

  test("keeps text mixed with a link in one cell", async () => {
    const { rows } = await paste(
      `<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody>` +
        `<tr><td>plain</td><td>see <a href="https://example.com">docs</a> now</td></tr>` +
        `</tbody></table>`,
    )
    // Leading/trailing whitespace of a cell is collapsed, same as a pasted paragraph.
    expect(rows[0]?.[1]).toEqual([
      { insert: "see" },
      { insert: "docs", attributes: { link: "https://example.com" } },
      { insert: "now" },
    ])
  })

  test("keeps header text wrapped in an inline element", async () => {
    const { names } = await paste(
      `<table><thead><tr><th>a</th><th><a href="https://example.com">b</a></th></tr></thead><tbody>` +
        `<tr><td>1</td><td>2</td></tr></tbody></table>`,
    )
    expect(names).toEqual(["a", "b"])
  })

  test("uses the first row as header when there is no thead", async () => {
    const { names, rows } = await paste(
      `<table><tbody>` +
        `<tr><td>name</td><td>link</td></tr>` +
        `<tr><td>plain</td><td><a href="https://example.com">label</a></td></tr>` +
        `</tbody></table>`,
    )
    expect(names).toEqual(["name", "link"])
    expect(rows).toEqual([[[{ insert: "plain" }], [{ insert: "label", attributes: { link: "https://example.com" } }]]])
  })

  test("reads the header past a colgroup", async () => {
    const { names, rows } = await paste(
      `<table><colgroup><col/><col/></colgroup><tbody>` +
        `<tr><td>name</td><td>link</td></tr>` +
        `<tr><td>plain</td><td><a href="https://example.com">label</a></td></tr>` +
        `</tbody></table>`,
    )
    expect(names).toEqual(["name", "link"])
    expect(rows[0]?.[1]).toEqual([{ insert: "label", attributes: { link: "https://example.com" } }])
  })

  test("keeps the title column of each row", async () => {
    const { titles } = await paste(
      `<table><tbody><tr><td>name</td></tr><tr><td><a href="https://a.com">first</a></td></tr>` +
        `<tr><td>second</td></tr></tbody></table>`,
    )
    expect(titles).toEqual([[{ insert: "first", attributes: { link: "https://a.com" } }], [{ insert: "second" }]])
  })

  test("drops cells the header row has no column for", async () => {
    const { names, rows } = await paste(
      `<table><tbody><tr><td>only</td></tr><tr><td>kept</td><td>extra</td></tr></tbody></table>`,
    )
    expect(names).toEqual(["only"])
    expect(rows).toEqual([[[{ insert: "kept" }]]])
  })

  test("leaves the walker balanced when a table has no rows", async () => {
    // enter() opens no database block here, so leave() must not close one either.
    const { slice } = await snapshot(`<p>before</p><table></table><p>after</p>`)
    const found: string[] = []
    const walk = (node: any) => {
      node?.props?.text?.delta?.forEach((delta: any) => found.push(delta.insert))
      node?.children?.forEach(walk)
    }
    slice?.content.forEach(walk)
    expect(found).toEqual(["before", "after"])
  })

  test("pastes the table into the doc and exports it as markdown", async () => {
    const ctx = await snapshot(
      `<table><thead><tr><th>name</th><th>link</th></tr></thead><tbody>` +
        `<tr><td>row</td><td><a href="https://example.com">label</a></td></tr>` +
        `</tbody></table>`,
    )
    if (!ctx.slice) throw new Error("missing slice snapshot")
    // The paste middleware unwraps the note the adapter wraps the slice in
    // (flatNote in root-block/clipboard/middlewares/paste.ts).
    const content = ctx.slice.content[0]?.flavour === "affine:note" ? ctx.slice.content[0].children : ctx.slice.content
    await ctx.job.snapshotToSlice({ ...ctx.slice, content }, ctx.doc, ctx.note)

    const database = ctx.doc.getBlockByFlavour("affine:database")[0]
    expect(database).toBeDefined()
    // The title column lands as a child paragraph, the other cells as database props.
    expect(texts(ctx.doc)).toEqual(["row"])
    const cells = Object.values((database as any).cells as Record<string, Record<string, { value: any }>>)[0]
    expect(Object.values(cells ?? {}).map((cell) => cell.value.toDelta())).toEqual([
      [{ insert: "row" }],
      [{ insert: "label", attributes: { link: "https://example.com" } }],
    ])

    const markdown = await docMarkdown(ctx.doc, {
      docID: "doc_1",
      directory: "/tmp/project",
      client: createOpencodeClient({
        baseUrl: "http://localhost:4096",
        directory: "/tmp/project",
        fetch: (() => {
          throw new Error("unexpected fetch")
        }) as unknown as typeof globalThis.fetch,
        throwOnError: true,
      }),
    })
    expect(markdown.text).toContain("label")
    // Known gap, unrelated to this patch: docMarkdown has no database serializer,
    // so a pasted table exports as a props json dump and the link url is dropped.
    expect(markdown.text).toContain("BlockSuite affine:database")
    expect(markdown.text).not.toContain("https://example.com")
  })
})
