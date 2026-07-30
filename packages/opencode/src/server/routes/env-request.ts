import path from "path"
import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { EnvRequest } from "../../env-request"
import { EnvFile } from "../../util/env-file"
import { EnvRequestID } from "../../env-request/schema"
import { Instance } from "../../project/instance"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

// AI 가 띄운 값 요청에 참가자가 응답하는 경로. submit 본문의 값은 서버가 .env 로 쓰고 즉시 버린다 —
// 응답에도, 버스 이벤트에도, 로그에도 값이 실리지 않는다(EnvRequest 네임스페이스 주석 참고).
// 경로는 env-file 라우트와 같이 서버 측 Instance.directory 에서만 유도한다.
const file = () => path.join(Instance.directory, ".env")

const SubmitBody = z.object({
  // 참가자가 이름을 고쳤을 때만 실린다. 앱이 읽을 이름은 결국 사람이 정한다.
  name: z.string().regex(EnvFile.KEY_REGEX).max(256).optional(),
  value: z
    .string()
    .min(1)
    .max(8192)
    .refine((v) => !/[\r\n]/.test(v), { message: "value must not contain newlines" }),
})

export const EnvRequestRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List pending env requests",
        description: "Get all pending environment value requests across all sessions.",
        operationId: "envRequest.list",
        responses: {
          200: {
            description: "List of pending env requests",
            content: { "application/json": { schema: resolver(EnvRequest.Request.array()) } },
          },
        },
      }),
      async (c) => {
        return c.json(await EnvRequest.list())
      },
    )
    .post(
      "/:requestID/submit",
      describeRoute({
        summary: "Submit env request value",
        description:
          "Store the value for a pending env request in the project root .env file. The value is never returned and never reaches the model.",
        operationId: "envRequest.submit",
        responses: {
          200: {
            description: "Value stored",
            content: { "application/json": { schema: resolver(z.boolean()) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ requestID: EnvRequestID.zod })),
      validator("json", SubmitBody),
      async (c) => {
        const params = c.req.valid("param")
        const body = c.req.valid("json")
        await EnvRequest.submit({
          requestID: params.requestID,
          file: file(),
          value: body.value,
          ...(body.name ? { name: body.name } : {}),
        })
        return c.json(true)
      },
    )
    .post(
      "/:requestID/skip",
      describeRoute({
        summary: "Skip env request",
        description: "Continue without a value. The assistant is told to proceed with sample data.",
        operationId: "envRequest.skip",
        responses: {
          200: {
            description: "Request skipped",
            content: { "application/json": { schema: resolver(z.boolean()) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ requestID: EnvRequestID.zod })),
      async (c) => {
        await EnvRequest.skip(c.req.valid("param").requestID)
        return c.json(true)
      },
    )
    .post(
      "/:requestID/reject",
      describeRoute({
        summary: "Reject env request",
        description: "Dismiss the request without storing a value.",
        operationId: "envRequest.reject",
        responses: {
          200: {
            description: "Request rejected",
            content: { "application/json": { schema: resolver(z.boolean()) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ requestID: EnvRequestID.zod })),
      async (c) => {
        await EnvRequest.reject(c.req.valid("param").requestID)
        return c.json(true)
      },
    ),
)
