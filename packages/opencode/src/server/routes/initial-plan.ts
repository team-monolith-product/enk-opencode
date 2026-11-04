import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { InitialPlan } from "../../enk/initial-plan"
import { ServeTargets } from "../../enk/serve-targets"
import { InstanceBootstrap } from "../../project/bootstrap"
import { Instance } from "../../project/instance"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"

const log = Log.create({ service: "server.initial-plan" })

const Delivered = z
  .object({ state: z.enum(["delivered", "already_delivered", "not_finalized", "pending_elsewhere", "failed"]) })
  .meta({ ref: "InitialPlanDelivery" })

const Failed = z.object({ error: z.string() }).meta({ ref: "InitialPlanDeliveryError" })

// 최초 기획은 언제나 본행사 프로젝트로 간다. 요청이 어느 디렉터리로 들어왔든(튜토리얼 화면이어도) 거기로 옮긴다.
function inProject<R>(fn: () => Promise<R>) {
  const dir = ServeTargets.project()?.dir
  if (!dir || dir === Instance.directory) return fn()
  return Instance.provide({ directory: dir, init: InstanceBootstrap, fn })
}

export const InitialPlanRoutes = lazy(() =>
  new Hono().post(
    "/deliver",
    describeRoute({
      summary: "Deliver the initial plan",
      description:
        "Claim the team's finalized initial plan from hackathon-rails and hand it to the plan agent in the main project session. Idempotent.",
      operationId: "enk.initialPlan.deliver",
      responses: {
        200: { description: "Delivery state", content: { "application/json": { schema: resolver(Delivered) } } },
        502: { description: "Delivery failed", content: { "application/json": { schema: resolver(Failed) } } },
        503: {
          description: "Rails is not configured",
          content: { "application/json": { schema: resolver(Failed) } },
        },
      },
    }),
    async (c) => {
      try {
        return c.json({ state: await inProject(() => InitialPlan.deliver()) })
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        log.warn("initial plan delivery failed", { error })
        return c.json({ error }, err instanceof InitialPlan.Unavailable ? 503 : 502)
      }
    },
  ),
)
