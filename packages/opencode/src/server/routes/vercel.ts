import { Hono, type Context } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { Vercel } from "../../enk/vercel"
import { Instance } from "../../project/instance"
import { lazy } from "../../util/lazy"

const Status = z
  .object({
    enabled: z.boolean(),
    connectUrl: z.string().optional(),
    username: z.string().optional(),
    linkedBy: z.string().optional(),
    project: z.object({ id: z.string(), name: z.string(), url: z.string().optional() }).optional(),
    deployment: z
      .object({ state: z.string(), url: z.string().optional(), time: z.number(), blocked: z.string().optional() })
      .optional(),
    backend: z.boolean().optional(),
    exposed: z.string().array().optional(),
  })
  .meta({ ref: "VercelStatus" })
const Failure = z.object({ code: z.string(), message: z.string() }).meta({ ref: "VercelError" })

const ok = (description: string) => ({
  200: { description, content: { "application/json": { schema: resolver(Status) } } },
})

async function handle<T>(c: Context, fn: () => Promise<T> | T) {
  return Promise.resolve()
    .then(fn)
    .then(
      (data) => c.json(data as object),
      (err) => {
        if (!(err instanceof Vercel.Failure)) throw err
        return c.json({ code: err.code, message: err.message }, err.status)
      },
    )
}

export const VercelRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Vercel link status",
        description:
          "The Vercel account the team linked in Jitda, the project imported from the team's GitHub repository and its latest production deployment. Never returns an access token.",
        operationId: "vercel.status",
        responses: ok("Link status"),
      }),
      (c) => handle(c, () => Vercel.status(Instance.directory)),
    )
    .post(
      "/project",
      describeRoute({
        summary: "Import into Vercel",
        description:
          "Import the team's GitHub repository as a Vercel project, copy the stored env values and start the first production deployment.",
        operationId: "vercel.project.create",
        responses: {
          ...ok("Link status"),
          ...Object.fromEntries(
            [404, 409, 502].map((code) => [
              code,
              { description: "Vercel error", content: { "application/json": { schema: resolver(Failure) } } },
            ]),
          ),
        },
      }),
      (c) => handle(c, () => Vercel.create(Instance.directory)),
    ),
)
