import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { lazy } from "../../util/lazy"
import * as DevServer from "../../tool/dev-server"

export const DevServerRoutes = lazy(() =>
  new Hono().post(
    "/restart",
    describeRoute({
      summary: "Restart dev server",
      description:
        "Restart the preview dev server using the command remembered from the last ensure_dev_server call. " +
        "Idempotent: returns already_starting while a launch is in progress and already_running if the port is already listening, so it is safe to call repeatedly.",
      operationId: "devServer.restart",
      responses: {
        200: {
          description: "Dev server restart result",
          content: {
            "application/json": {
              schema: resolver(
                z
                  .object({
                    status: z.enum(["already_running", "started", "failed", "no_command", "already_starting"]),
                    url: z.string().optional(),
                    port: z.number(),
                    ms: z.number(),
                    reason: z.string().optional(),
                  })
                  .meta({ ref: "DevServerRestart" }),
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      const result = await DevServer.restart({ timeoutMs: 15000, abort: c.req.raw.signal })
      return c.json(result)
    },
  ),
)
