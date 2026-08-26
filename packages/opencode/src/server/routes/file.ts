import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { describeRoute, validator, resolver } from "hono-openapi"
import fs from "fs/promises"
import path from "path"
import z from "zod"
import { File } from "../../file"
import { Assets } from "../../file/assets"
import { Ripgrep } from "../../file/ripgrep"
import { LSP } from "../../lsp"
import { Instance } from "../../project/instance"
import { lazy } from "../../util/lazy"
import { errors } from "../error"

const AssetEntry = z
  .object({
    path: z.string(),
    size: z.number().int(),
    modified: z.number().int(),
  })
  .meta({ ref: "AssetEntry" })

const AssetList = z
  .object({
    files: AssetEntry.array(),
    usage: z.object({ count: z.number().int(), bytes: z.number().int() }),
    limits: z.object({
      file: z.number().int(),
      total: z.number().int(),
      count: z.number().int(),
    }),
  })
  .meta({ ref: "AssetList" })

function limits() {
  return { file: Assets.MAX_FILE_BYTES, total: Assets.MAX_TOTAL_BYTES, count: Assets.MAX_FILE_COUNT }
}

export const FileRoutes = lazy(() =>
  new Hono()
    .get(
      "/find",
      describeRoute({
        summary: "Find text",
        description: "Search for text patterns across files in the project using ripgrep.",
        operationId: "find.text",
        responses: {
          200: {
            description: "Matches",
            content: {
              "application/json": {
                schema: resolver(Ripgrep.Match.shape.data.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          pattern: z.string(),
        }),
      ),
      async (c) => {
        const pattern = c.req.valid("query").pattern
        const result = await Ripgrep.search({
          cwd: Instance.directory,
          pattern,
          limit: 10,
        })
        return c.json(result)
      },
    )
    .get(
      "/find/file",
      describeRoute({
        summary: "Find files",
        description: "Search for files or directories by name or pattern in the project directory.",
        operationId: "find.files",
        responses: {
          200: {
            description: "File paths",
            content: {
              "application/json": {
                schema: resolver(z.string().array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z.string(),
          dirs: z.enum(["true", "false"]).optional(),
          type: z.enum(["file", "directory"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query").query
        const dirs = c.req.valid("query").dirs
        const type = c.req.valid("query").type
        const limit = c.req.valid("query").limit
        const results = await File.search({
          query,
          limit: limit ?? 10,
          dirs: dirs !== "false",
          type,
        })
        return c.json(results)
      },
    )
    .get(
      "/find/symbol",
      describeRoute({
        summary: "Find symbols",
        description: "Search for workspace symbols like functions, classes, and variables using LSP.",
        operationId: "find.symbols",
        responses: {
          200: {
            description: "Symbols",
            content: {
              "application/json": {
                schema: resolver(LSP.Symbol.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z.string(),
        }),
      ),
      async (c) => {
        /*
      const query = c.req.valid("query").query
      const result = await LSP.workspaceSymbol(query)
      return c.json(result)
      */
        return c.json([])
      },
    )
    .get(
      "/file",
      describeRoute({
        summary: "List files",
        description: "List files and directories in a specified path.",
        operationId: "file.list",
        responses: {
          200: {
            description: "Files and directories",
            content: {
              "application/json": {
                schema: resolver(File.Node.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
        }),
      ),
      async (c) => {
        const path = c.req.valid("query").path
        const content = await File.list(path)
        return c.json(content)
      },
    )
    .get(
      "/file/content",
      describeRoute({
        summary: "Read file",
        description: "Read the content of a specified file.",
        operationId: "file.read",
        responses: {
          200: {
            description: "File content",
            content: {
              "application/json": {
                schema: resolver(File.Content),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
        }),
      ),
      async (c) => {
        const path = c.req.valid("query").path
        const content = await File.read(path)
        return c.json(content)
      },
    )
    .get(
      "/file/status",
      describeRoute({
        summary: "Get file status",
        description: "Get the git status of all files in the project.",
        operationId: "file.status",
        responses: {
          200: {
            description: "File status",
            content: {
              "application/json": {
                schema: resolver(File.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const content = await File.status()
        return c.json(content)
      },
    )
    .get(
      "/file/asset",
      describeRoute({
        summary: "List uploaded files",
        description: `List the files stored in the ${Assets.DIR} upload folder.`,
        operationId: "file.asset.list",
        responses: {
          200: {
            description: "Uploaded files",
            content: {
              "application/json": {
                schema: resolver(AssetList),
              },
            },
          },
        },
      }),
      async (c) => {
        const files = Assets.list()
        return c.json({
          files,
          usage: files.reduce((acc, f) => ({ count: acc.count + 1, bytes: acc.bytes + f.size }), {
            count: 0,
            bytes: 0,
          }),
          limits: limits(),
        })
      },
    )
    .post(
      "/file/asset",
      describeRoute({
        summary: "Upload a file",
        description: [
          `Store a file in the ${Assets.DIR} upload folder, verbatim and without involving the model.`,
          "The body is the raw bytes; the destination comes from the `path` query parameter.",
        ].join(" "),
        operationId: "file.asset.create",
        // Raw bytes rather than multipart or base64: multipart would have to be buffered whole to
        // be parsed, and base64 inflates every upload by a third. The route streams this to disk.
        requestBody: {
          required: true,
          content: {
            "application/octet-stream": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        responses: {
          200: {
            description: "Stored file",
            content: {
              "application/json": {
                schema: resolver(AssetEntry),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "query",
        z.object({
          path: z
            .string()
            .min(1)
            .meta({ description: "Destination relative to the upload folder, e.g. `spec/api.md`" }),
        }),
      ),
      async (c) => {
        // The client controls this string, so nothing downstream may assume it is well formed:
        // `resolve` is what confines the write to the upload folder.
        const target = Assets.resolve(c.req.valid("query").path)
        if (!target) throw new HTTPException(400, { message: "Invalid upload path" })

        const usage = Assets.usage()
        if (usage.count + 1 > Assets.MAX_FILE_COUNT)
          throw new HTTPException(400, { message: `Upload folder holds at most ${Assets.MAX_FILE_COUNT} files` })

        // Content-Length is a hint, not a guarantee — it lets an oversized upload fail before any
        // bytes are written, but the streaming loop below is what actually enforces the cap.
        const declared = Number(c.req.header("content-length") ?? 0)
        if (declared > Assets.MAX_FILE_BYTES) throw new HTTPException(400, { message: "File is too large" })
        if (usage.bytes + declared > Assets.MAX_TOTAL_BYTES)
          throw new HTTPException(400, { message: "Upload folder is full" })

        const body = c.req.raw.body
        if (!body) throw new HTTPException(400, { message: "Missing request body" })

        if (!Assets.prepare(target)) throw new HTTPException(400, { message: "Invalid upload path" })
        Assets.exclude()

        // "wx" fails if the destination exists and does not follow a symlink at the final segment,
        // so a name computed a moment ago cannot be turned into a write somewhere else.
        let destination = Assets.unique(target)
        let handle = await fs.open(destination, "wx", 0o644).catch(() => undefined)
        // Two people uploading the same name at once both compute the same free name; whoever
        // loses the open just takes the next one.
        for (let attempt = 0; !handle && attempt < 5; attempt++) {
          destination = Assets.unique(target)
          handle = await fs.open(destination, "wx", 0o644).catch(() => undefined)
        }
        if (!handle) throw new HTTPException(400, { message: "Could not create file" })

        let written = 0
        try {
          const reader = body.getReader()
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            written += value.byteLength
            if (written > Assets.MAX_FILE_BYTES || usage.bytes + written > Assets.MAX_TOTAL_BYTES) {
              await reader.cancel().catch(() => {})
              throw new HTTPException(400, { message: "File is too large" })
            }
            await handle.write(value)
          }
        } catch (error) {
          await handle.close().catch(() => {})
          // A partial file would look like a successful upload to the agent, so it must not survive.
          await fs.rm(destination, { force: true }).catch(() => {})
          throw error
        }
        await handle.close()

        return c.json({
          path: path.relative(Assets.root(), destination).split(path.sep).join("/"),
          size: written,
          modified: Date.now(),
        })
      },
    )
    .delete(
      "/file/asset",
      describeRoute({
        summary: "Delete uploaded files",
        description: `Delete one uploaded file, or the whole ${Assets.DIR} folder when no path is given.`,
        operationId: "file.asset.delete",
        responses: {
          200: {
            description: "Deleted",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string().optional().meta({ description: "Path relative to the upload folder. Omit to delete all." }),
        }),
      ),
      async (c) => {
        const requested = c.req.valid("query").path
        if (!requested) {
          await fs.rm(Assets.root(), { recursive: true, force: true })
          return c.json(true)
        }

        const target = Assets.resolve(requested)
        if (!target) throw new HTTPException(400, { message: "Invalid path" })
        await fs.rm(target, { recursive: true, force: true })
        return c.json(true)
      },
    ),
)
