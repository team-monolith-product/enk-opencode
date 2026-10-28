import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { failures, ok } from "../enk-responses"
import z from "zod"
import { History } from "../../enk/history"
import { ServeTargets } from "../../enk/serve-targets"
import { Instance } from "../../project/instance"
import { lazy } from "../../util/lazy"

const Sha = z.string().regex(/^[0-9a-f]{40}$/)
const Entry = z
  .object({ sha: z.string(), time: z.number(), subject: z.string(), revert: z.string().optional() })
  .meta({ ref: "HistoryEntry" })
const Change = z.object({ status: z.enum(["A", "M", "D", "L"]), file: z.string() }).meta({ ref: "HistoryChange" })
const Status = z.object({ enabled: z.boolean(), entries: Entry.array() }).meta({ ref: "HistoryStatus" })

export const HistoryRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Version history",
        description:
          "Saved versions of the project folder, newest first. A version is saved every time an AI turn ends.",
        operationId: "history.list",
        responses: { ...ok("Version history", Status), ...failures(500) },
      }),
      async (c) => {
        const dir = Instance.directory
        if (!ServeTargets.isProject(dir)) return c.json({ enabled: false, entries: [] })
        return c.json({ enabled: true, entries: await History.list(dir) })
      },
    )
    .get(
      "/:sha",
      describeRoute({
        summary: "Version changes",
        description: "Files that changed in this version compared with the one before it.",
        operationId: "history.changes",
        responses: { ...ok("Changed files", Change.array()), ...failures(404, 500) },
      }),
      validator("param", z.object({ sha: Sha })),
      async (c) => c.json(await History.changes(Instance.directory, c.req.valid("param").sha)),
    ),
)
