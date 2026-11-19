// 짓다 화면(iframe 부모)의 입력 칸에 커서가 있는 동안은 부모가 알려 준다.
// 그동안 BlockSuite 가 붙거나 다시 그려지며 자동으로 커서를 가져가면 부모에서 치던 글자가 이쪽으로 새어 들어온다.
const MESSAGE = "jitda.host-input"

let active = false

export type HostInputMessage = { type: typeof MESSAGE; active: boolean }

export function applyHostInputMessage(data: unknown): boolean {
  const message = data as Partial<HostInputMessage> | null
  if (!message || message.type !== MESSAGE) return false
  active = message.active === true
  return true
}

export function hostInputActive(): boolean {
  return active
}

if (typeof window !== "undefined" && window.parent !== window) {
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return
    applyHostInputMessage(event.data)
  })
}
