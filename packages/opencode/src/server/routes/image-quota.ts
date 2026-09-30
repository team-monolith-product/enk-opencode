import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { ImageQuota } from "../../enk/image-quota"
import { GenerateImage } from "../../tool/generate-image"
import { lazy } from "../../util/lazy"

const Quota = z.object({ limit: z.number(), used: z.number(), remaining: z.number() }).meta({ ref: "ImageQuota" })

const QuotaResponse = z.object({ enabled: z.boolean(), quota: Quota.optional() }).meta({ ref: "ImageQuotaStatus" })

export const ImageQuotaRoutes = lazy(() =>
  new Hono().get(
    "/",
    describeRoute({
      summary: "Image generation quota",
      description: "Whether image generation is available here and how many images the team has left.",
      operationId: "imageQuota.get",
      responses: {
        200: { description: "Quota", content: { "application/json": { schema: resolver(QuotaResponse) } } },
      },
    }),
    async (c) => {
      if (!GenerateImage.available()) return c.json({ enabled: false })
      const state = ImageQuota.state()
      if (state.kind === "unavailable") return c.json({ enabled: false })
      if (state.kind !== "known") return c.json({ enabled: true })
      return c.json({ enabled: state.quota.limit > 0, quota: state.quota })
    },
  ),
)
