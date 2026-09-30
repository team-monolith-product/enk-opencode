import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { ImageQuota } from "../../enk/image-quota"
import { GenerateImage } from "../../tool/generate-image"
import { lazy } from "../../util/lazy"

const Quota = z.object({ limit: z.number(), used: z.number(), remaining: z.number() }).meta({ ref: "ImageQuota" })

const QuotaResponse = z.object({ enabled: z.boolean(), quota: Quota.optional() }).meta({ ref: "ImageQuotaStatus" })

export const ImageRequestRoutes = lazy(() =>
  new Hono().get(
    "/quota",
    describeRoute({
      summary: "Image generation quota",
      description: "Whether image generation is available here and how many images the team has left.",
      operationId: "imageRequest.quota",
      responses: {
        200: { description: "Quota", content: { "application/json": { schema: resolver(QuotaResponse) } } },
      },
    }),
    async (c) => {
      if (!GenerateImage.available()) return c.json({ enabled: false })
      const quota = ImageQuota.cached()
      if (quota === null) return c.json({ enabled: false })
      return c.json({ enabled: quota === undefined || quota.limit > 0, quota })
    },
  ),
)
