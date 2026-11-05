// 짓다 기능이 사용자에게 돌려주는 예상된 실패. code 는 화면이 사유를 고르는 이름이고 500 은 원문을 내보내지 않는다.
export class EnkFailure<Code extends string = string> extends Error {
  constructor(
    readonly code: Code,
    readonly status: number,
    message?: string,
  ) {
    super(message || code)
    this.name = "EnkFailure"
  }
}

export function refusal(error: EnkFailure) {
  return {
    error: { code: error.code, status: error.status, message: error.status === 500 ? error.code : error.message },
  }
}
