import type { ContentfulStatusCode } from "hono/utils/http-status"

/** enk 기능이 사용자에게 돌려주는 예상된 실패. 서버 errorHandler 가 `{ code, message }` 와 status 로 그대로 응답한다. */
export class EnkFailure<Code extends string = string> extends Error {
  constructor(
    readonly code: Code,
    readonly status: ContentfulStatusCode,
    message?: string,
  ) {
    super(message || code)
    this.name = "EnkFailure"
  }
}
