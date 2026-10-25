import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { ImageQuota } from "../../enk/image-quota"
import { ImageToggle } from "../../enk/image-toggle"
import { GenerateImage } from "../../tool/generate-image"
import { lazy } from "../../util/lazy"
import { errors } from "../error"

const Quota = z.object({ limit: z.number(), used: z.number(), remaining: z.number() }).meta({ ref: "ImageQuota" })

const QuotaResponse = z
  .object({ enabled: z.boolean(), on: z.boolean(), quota: Quota.optional() })
  .meta({ ref: "ImageQuotaStatus" })

async function status() {
  const on = await ImageToggle.on()
  if (!GenerateImage.available()) return { enabled: false, on }
  const state = ImageQuota.state()
  if (state.kind === "known") return { enabled: true, on, quota: state.quota }
  return { enabled: state.kind === "unlimited", on }
}

export const ImageQuotaRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Image generation quota",
        description:
          "Whether image generation is available here, whether the team's toggle is on, and how many images the team has left.",
        operationId: "imageQuota.get",
        responses: {
          200: { description: "Quota", content: { "application/json": { schema: resolver(QuotaResponse) } } },
        },
      }),
      async (c) => c.json(await status()),
    )
    .put(
      "/toggle",
      describeRoute({
        summary: "Set image generation toggle",
        description:
          "Turn the team's image generation toggle on or off. Every open screen of the workspace follows it.",
        operationId: "imageQuota.toggle",
        responses: {
          200: { description: "Quota", content: { "application/json": { schema: resolver(QuotaResponse) } } },
          ...errors(400),
        },
      }),
      validator("json", z.object({ on: z.boolean() })),
      async (c) => {
        await ImageToggle.set(c.req.valid("json").on)
        return c.json(await status())
      },
    ),
)
