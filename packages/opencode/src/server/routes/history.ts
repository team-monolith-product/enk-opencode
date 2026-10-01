import { Hono, type Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { History } from "../../enk/history"
import { Instance } from "../../project/instance"
import { lazy } from "../../util/lazy"

const Sha = z.string().regex(/^[0-9a-f]{40}$/)
const Entry = z
  .object({ sha: z.string(), time: z.number(), subject: z.string(), revert: z.string().optional() })
  .meta({ ref: "HistoryEntry" })
const Change = z.object({ status: z.enum(["A", "M", "D"]), file: z.string() }).meta({ ref: "HistoryChange" })
const Status = z
  .object({ enabled: z.boolean(), open: z.boolean(), entries: Entry.array() })
  .meta({ ref: "HistoryStatus" })
const Failure = z.object({ code: z.string(), message: z.string() }).meta({ ref: "HistoryError" })

const failures = (...codes: number[]) =>
  Object.fromEntries(
    codes.map((code) => [
      code,
      { description: "History error", content: { "application/json": { schema: resolver(Failure) } } },
    ]),
  )

const ok = (description: string, schema: z.ZodType) => ({
  200: { description, content: { "application/json": { schema: resolver(schema) } } },
})

async function handle<T>(c: Context, fn: () => Promise<T> | T) {
  return Promise.resolve()
    .then(fn)
    .then(
      (data) => c.json(data as object),
      (err) => {
        if (err instanceof History.Failure) return c.json({ code: err.code, message: err.message }, err.status)
        throw err
      },
    )
}

export const HistoryRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Version history",
        description:
          "Saved versions of the project folder, newest first. A version is saved every time an AI turn ends. `open` says whether rolling back is allowed right now.",
        operationId: "history.list",
        responses: ok("Version history", Status),
      }),
      (c) =>
        handle(c, async () => {
          const dir = Instance.directory
          if (!History.enabled(dir)) return { enabled: false, open: false, entries: [] }
          const [open, entries] = await Promise.all([History.open(), History.list(dir)])
          return { enabled: true, open, entries }
        }),
    )
    .get(
      "/:sha",
      describeRoute({
        summary: "Version changes",
        description: "Files that changed in this version compared with the one before it.",
        operationId: "history.changes",
        responses: { ...ok("Changed files", Change.array()), ...failures(404) },
      }),
      validator("param", z.object({ sha: Sha })),
      (c) => handle(c, () => History.changes(Instance.directory, c.req.valid("param").sha)),
    ),
)
