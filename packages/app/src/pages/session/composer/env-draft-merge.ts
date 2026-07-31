// 원격 초안을 로컬에 반영할 때, 지금 잡고 있는 칸은 덮지 않는다.
// 소켓 왕복 값이 조합 중인 입력을 덮으면 한글이 "테스트트이입니다다" 처럼 깨진다.
export function merge(
  focused: "key" | "value" | undefined,
  next: { key: string; value: string },
): { key?: string; value?: string } {
  return {
    ...(focused === "key" ? {} : { key: next.key }),
    ...(focused === "value" ? {} : { value: next.value }),
  }
}
