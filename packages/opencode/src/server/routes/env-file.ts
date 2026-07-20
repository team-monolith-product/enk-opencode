import path from "path"
import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Instance } from "../../project/instance"
import { EnvFile } from "../../util/env-file"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

// 프로젝트 루트 .env 관리(쓰기 전용). 값은 어떤 응답에도 포함하지 않는다 — 키 이름만 반환.
// 경로는 서버 측 Instance.directory 에서만 유도하므로 클라이언트발 path traversal 이 불가능하다.
const KeyName = z.string().regex(EnvFile.KEY_REGEX).max(256)
const KeyList = z.object({ keys: z.string().array() }).meta({ ref: "EnvFileKeys" })
const SetBody = z
  .object({
    values: z.record(
      KeyName,
      z
        .string()
        .max(8192)
        .refine((v) => !/[\r\n]/.test(v), { message: "value must not contain newlines" }),
    ),
  })
  .refine((o) => Object.keys(o.values).length > 0, { message: "values must not be empty" })

const file = () => path.join(Instance.directory, ".env")

export const EnvFileRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List env file keys",
        description: "List the key names stored in the project root .env file. Values are never returned.",
        operationId: "envFile.list",
        responses: {
          200: {
            description: "Key names",
            content: { "application/json": { schema: resolver(KeyList) } },
          },
        },
      }),
      async (c) => {
        return c.json({ keys: await EnvFile.names(file()) })
      },
    )
    .put(
      "/",
      describeRoute({
        summary: "Set env file keys",
        description:
          "Merge key=value pairs into the project root .env file. Existing keys are overwritten in place, new keys appended. Values are never returned.",
        operationId: "envFile.set",
        responses: {
          200: {
            description: "Key names after update",
            content: { "application/json": { schema: resolver(KeyList) } },
          },
          ...errors(400),
        },
      }),
      validator("json", SetBody),
      async (c) => {
        const body = c.req.valid("json")
        return c.json({ keys: await EnvFile.set(file(), body.values) })
      },
    )
    .delete(
      "/:name",
      describeRoute({
        summary: "Remove env file key",
        description: "Remove a key from the project root .env file.",
        operationId: "envFile.remove",
        responses: {
          200: {
            description: "Key names after removal",
            content: { "application/json": { schema: resolver(KeyList) } },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ name: KeyName })),
      async (c) => {
        const { name } = c.req.valid("param")
        return c.json({ keys: await EnvFile.remove(file(), name) })
      },
    ),
)
