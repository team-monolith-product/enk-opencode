import { resolver } from "hono-openapi"
import z from "zod"
import { NotFoundError } from "../storage/db"

/** enk 기능이 돌려주는 예상된 실패(EnkFailure). errorHandler 가 이 모양으로 응답한다. */
export const EnkFailureBody = z.object({ code: z.string(), message: z.string() }).meta({ ref: "EnkFailure" })

const json = (schema: z.ZodType) => ({ "application/json": { schema: resolver(schema) } })

export function ok(description: string, schema: z.ZodType) {
  return { 200: { description, content: json(schema) } }
}

/** EnkFailure 로 끝날 수 있는 status 들. 404 는 세션·문서를 못 찾은 NotFoundError 와도 겹쳐 둘 다 싣는다. */
export function failures(...codes: number[]) {
  return Object.fromEntries(
    codes.map((code) => [
      code,
      {
        description: "Expected failure",
        content: json(code === 404 ? z.union([EnkFailureBody, NotFoundError.Schema]) : EnkFailureBody),
      },
    ]),
  )
}
