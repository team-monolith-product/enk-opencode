import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { describeRoute, validator, resolver } from "hono-openapi"
import fs from "fs/promises"
import { createHash } from "crypto"
import path from "path"
import z from "zod"
import { File } from "../../file"
import { Assets } from "../../file/assets"
import { Ripgrep } from "../../file/ripgrep"
import { LSP } from "../../lsp"
import { Instance } from "../../project/instance"
import { lazy } from "../../util/lazy"
import { EnvFile } from "../../util/env-file"
import { Filesystem } from "../../util/filesystem"
import { Bus } from "../../bus"
import { FileWatcher } from "../../file/watcher"
import { errors } from "../error"

const WrittenFile = z
  .object({
    path: z.string(),
    size: z.number().int(),
  })
  .meta({ ref: "FileWritten" })

/** Same cap as one uploaded file (Assets.MAX_FILE_BYTES); an edited image is never near it. */
const MAX_WRITE_BYTES = 100 * 1024 * 1024

/**
 * The file `requested` names, if the write route may replace it: an existing regular file whose
 * real location (symlinks followed) is inside the project, outside `.git`, and not a secret env file.
 * The client controls `requested`, so every one of those checks is needed — a lexical check alone
 * lets a symlink in the project point the write at any file the server can reach.
 */
async function writableFile(requested: string) {
  const full = path.resolve(Instance.directory, requested)
  if (!Instance.containsPath(full)) return
  if (EnvFile.isSecretFile(full)) return

  const stat = await fs.stat(full).catch(() => undefined)
  if (!stat?.isFile()) return

  const real = await fs.realpath(full)
  const roots = [Instance.directory, ...(Instance.worktree === "/" ? [] : [Instance.worktree])]
  const realRoots = await Promise.all(roots.map((root) => fs.realpath(root).catch(() => root)))
  const root = realRoots.find((item) => Filesystem.contains(item, real))
  if (!root) return
  const relative = path.relative(root, real)
  if (relative.split(path.sep).includes(".git")) return
  if (EnvFile.isSecretFile(real)) return

  return { real, relative: path.relative(Instance.directory, full).split(path.sep).join("/"), mode: stat.mode & 0o777 }
}

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
    .put(
      "/file/content",
      describeRoute({
        summary: "Overwrite file",
        description: [
          "Replace the bytes of an existing file in the project, such as an image saved from the image editor.",
          "The body is the raw bytes; the file comes from the `path` query parameter. Only existing files are written.",
        ].join(" "),
        operationId: "file.write",
        // Raw bytes for the same reason as the upload route: images are binary, and base64 would
        // inflate every save by a third.
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
            description: "Written file",
            content: {
              "application/json": {
                schema: resolver(WrittenFile),
              },
            },
          },
          ...errors(400),
          409: { description: "The file changed since the client read it (see `expected`)" },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string().min(1).meta({ description: "File path relative to the project directory" }),
          expected: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .optional()
            .meta({
              description:
                "SHA-256 (hex) of the bytes the client edited. When given and the file no longer matches, nothing is written and the route answers 409.",
            }),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const target = await writableFile(query.path)
        if (!target) throw new HTTPException(400, { message: "Invalid file path" })

        // 편집기를 연 뒤 에이전트·다른 사람이 같은 파일을 바꿨다면, 옛 사본에서 만든 결과로 덮어써
        // 그 변경을 지우지 않는다.
        if (query.expected) {
          const current = createHash("sha256").update(await fs.readFile(target.real)).digest("hex")
          if (current !== query.expected) {
            throw new HTTPException(409, { message: "File changed since it was opened" })
          }
        }

        // Content-Length is a hint only; the streaming loop below is what enforces the cap.
        const declared = Number(c.req.header("content-length") ?? 0)
        if (declared > MAX_WRITE_BYTES) throw new HTTPException(400, { message: "File is too large" })

        const body = c.req.raw.body
        if (!body) throw new HTTPException(400, { message: "Missing request body" })

        // Written next to the file and renamed over it, so a save cut off half way leaves the old
        // file whole instead of a truncated one.
        const temp = path.join(path.dirname(target.real), `.${path.basename(target.real)}.${crypto.randomUUID()}.tmp`)
        const handle = await fs.open(temp, "wx", target.mode)
        let written = 0
        try {
          const reader = body.getReader()
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            written += value.byteLength
            if (written > MAX_WRITE_BYTES) {
              await reader.cancel().catch(() => {})
              throw new HTTPException(400, { message: "File is too large" })
            }
            // write() 는 디스크가 부족하면 일부만 쓰고 resolve 할 수 있다. 남은 바이트를 다 쓸 때까지
            // 이어 쓰지 않으면 잘린 파일이 원본을 대신하게 된다.
            for (let offset = 0; offset < value.byteLength; ) {
              const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset)
              if (bytesWritten <= 0) throw new Error("Could not write file")
              offset += bytesWritten
            }
          }
          // open() 의 mode 에는 프로세스 umask 가 걸려(예: 0664 → 0644) 원본 권한이 바뀌므로 다시 맞춘다.
          await handle.chmod(target.mode)
          await handle.close()
          await fs.rename(temp, target.real)
        } catch (error) {
          await handle.close().catch(() => {})
          await fs.rm(temp, { force: true }).catch(() => {})
          throw error
        }

        // Same notifications as the write tool, so open file tabs and the tree reload the new bytes.
        Bus.publish(File.Event.Edited, { file: target.real })
        await Bus.publish(FileWatcher.Event.Updated, { file: target.real, event: "change" })
        return c.json({ path: target.relative, size: written })
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
        // The client calls this right before a batch to see whether it fits, so the walk it costs is
        // also the one that primes the upload path's cached totals.
        const { files, usage } = Assets.snapshot()
        return c.json({ files, usage, limits: limits() })
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

        // Content-Length is a hint, not a guarantee — it lets an oversized upload fail before any
        // bytes are written, but the streaming loop below is what actually enforces the cap.
        const declared = Number(c.req.header("content-length") ?? 0)
        if (declared > Assets.MAX_FILE_BYTES) throw new HTTPException(400, { message: "File is too large" })

        // Room is taken now, not merely checked: the client uploads several at a time, and a check
        // that only reads leaves every one of them believing it is the file that still fits.
        const claim = Assets.claim(declared)
        if (claim === "count")
          throw new HTTPException(400, { message: `Upload folder holds at most ${Assets.MAX_FILE_COUNT} files` })
        if (claim === "total") throw new HTTPException(400, { message: "Upload folder is full" })

        // Whatever happens from here, the room goes back — as a stored file if one was stored, and
        // as nothing at all otherwise. A leaked claim would shrink the folder's capacity for good.
        let stored: number | undefined
        try {
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
              if (written > Assets.MAX_FILE_BYTES) {
                await reader.cancel().catch(() => {})
                throw new HTTPException(400, { message: "File is too large" })
              }
              // Against the claim, not the snapshot: a client that understated content-length gets
              // caught here, and the uploads running beside this one still hold their own room.
              if (Assets.projectedBytes(claim, written) > Assets.MAX_TOTAL_BYTES) {
                await reader.cancel().catch(() => {})
                throw new HTTPException(400, { message: "Upload folder is full" })
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
          stored = written

          return c.json({
            path: path.relative(Assets.root(), destination).split(path.sep).join("/"),
            size: written,
            modified: Date.now(),
          })
        } finally {
          Assets.settle(claim, stored)
        }
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
          // The cached totals describe a folder that is no longer there.
          Assets.invalidate()
          return c.json(true)
        }

        const target = Assets.resolve(requested)
        if (!target) throw new HTTPException(400, { message: "Invalid path" })
        await fs.rm(target, { recursive: true, force: true })
        Assets.invalidate()
        return c.json(true)
      },
    ),
)
