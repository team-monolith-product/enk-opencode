import path from "path"
import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Instance } from "../../project/instance"
import { EnvFile } from "../../util/env-file"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

// 프로젝트 루트 .env 관리. 목록에는 값을 싣지 않고, 값은 단건 조회(GET /:name/value)로만 나간다.
// 사람은 opencode UI 에서 값을 볼 수 있고, LLM 은 Permission.ENV_FILE_GUARD 가 파일 접근과 이
// 엔드포인트를 함께 deny 해서 닿지 못한다 — 차단은 네트워크 인증이 아니라 도구 계층이 맡는다.
// 경로는 서버 측 Instance.directory 에서만 유도하므로 클라이언트발 path traversal 이 불가능하다.
const KeyName = z.string().regex(EnvFile.KEY_REGEX).max(256)
const KeyList = z
  .object({
    keys: z.string().array(),
    updated_at: z.record(z.string(), z.number()).optional(),
    /** 이름은 있는데 값이 비어 있는 키. UI 가 「값 필요」줄로 구분한다. */
    empty: z.string().array(),
  })
  .meta({ ref: "EnvFileKeys" })
const KeyValue = z
  .object({
    name: z.string(),
    value: z.string(),
  })
  .meta({ ref: "EnvFileValue" })
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

async function payload() {
  const entries = await EnvFile.entries(file())
  const updated_at: Record<string, number> = {}
  for (const entry of entries) {
    if (entry.updated_at !== undefined) updated_at[entry.name] = entry.updated_at
  }
  return {
    keys: entries.map((entry) => entry.name),
    updated_at,
    empty: entries.filter((entry) => entry.empty).map((entry) => entry.name),
  }
}

export const EnvFileRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List env file keys",
        description:
          "List the key names stored in the project root .env file, with optional updated_at timestamps. Values are never included here — read one with GET /env-file/{name}/value.",
        operationId: "envFile.list",
        responses: {
          200: {
            description: "Key names and update times",
            content: { "application/json": { schema: resolver(KeyList) } },
          },
        },
      }),
      async (c) => {
        return c.json(await payload())
      },
    )
    .get(
      "/:name/value",
      describeRoute({
        summary: "Read one env file value",
        description:
          "Read a single stored value so a person can check it in the opencode UI. Agent tools are denied this path by Permission.ENV_FILE_GUARD, the same guard that blocks reading .env directly.",
        operationId: "envFile.value",
        responses: {
          200: {
            description: "The stored value",
            content: { "application/json": { schema: resolver(KeyValue) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ name: KeyName })),
      async (c) => {
        const { name } = c.req.valid("param")
        const value = await EnvFile.value(file(), name)
        if (value === undefined) return c.json({ error: `${name} is not stored` }, 404)
        return c.json({ name, value })
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
        await EnvFile.set(file(), body.values)
        return c.json(await payload())
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
        await EnvFile.remove(file(), name)
        return c.json(await payload())
      },
    ),
)
