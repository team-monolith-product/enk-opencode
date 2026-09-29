import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { ImageRequest } from "../../image-request"
import { ImageRequestID } from "../../image-request/schema"
import { ImageQuota } from "../../enk/image-quota"
import { GenerateImage } from "../../tool/generate-image"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

const ok = (description: string) => ({
  200: { description, content: { "application/json": { schema: resolver(z.boolean()) } } },
  ...errors(400, 404),
})

const QuotaResponse = z
  .object({ enabled: z.boolean(), quota: ImageRequest.Quota.optional() })
  .meta({ ref: "ImageQuotaStatus" })

export const ImageRequestRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List pending image requests",
        description: "Get all image generations waiting for the user's approval.",
        operationId: "imageRequest.list",
        responses: {
          200: {
            description: "List of pending image requests",
            content: { "application/json": { schema: resolver(ImageRequest.Request.array()) } },
          },
        },
      }),
      async (c) => c.json(await ImageRequest.list()),
    )
    .get(
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
        const quota = await ImageQuota.status().catch(() => undefined)
        if (quota === null) return c.json({ enabled: false })
        return c.json({ enabled: quota === undefined || quota.limit > 0, quota })
      },
    )
    .post(
      "/:requestID/approve",
      describeRoute({
        summary: "Approve image request",
        description: "Generate the image, optionally with a prompt the user edited.",
        operationId: "imageRequest.approve",
        responses: ok("Image request approved"),
      }),
      validator("param", z.object({ requestID: ImageRequestID.zod })),
      validator("json", z.object({ prompt: z.string().max(4000).optional() })),
      async (c) => {
        await ImageRequest.approve({ requestID: c.req.valid("param").requestID, prompt: c.req.valid("json").prompt })
        return c.json(true)
      },
    )
    .post(
      "/:requestID/skip",
      describeRoute({
        summary: "Skip image request",
        description: "Do not generate this image.",
        operationId: "imageRequest.skip",
        responses: ok("Image request skipped"),
      }),
      validator("param", z.object({ requestID: ImageRequestID.zod })),
      async (c) => {
        await ImageRequest.skip(c.req.valid("param").requestID)
        return c.json(true)
      },
    )
    .post(
      "/:requestID/reject",
      describeRoute({
        summary: "Reject image request",
        description: "Close the image request without an answer.",
        operationId: "imageRequest.reject",
        responses: ok("Image request rejected"),
      }),
      validator("param", z.object({ requestID: ImageRequestID.zod })),
      async (c) => {
        await ImageRequest.reject(c.req.valid("param").requestID)
        return c.json(true)
      },
    ),
)
