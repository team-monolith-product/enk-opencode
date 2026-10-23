import type { DocApi } from "./doc-submit"

// 테스트에서 /api/jitda/doc 주소와 fetch 를 갈아끼운다.
export function testDocApi(
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  base = "http://localhost:4096",
): DocApi {
  const url = (path: string) => {
    const next = new URL(`${base}/api/jitda/doc${path}`)
    next.searchParams.set("directory", "/tmp/project")
    return next
  }
  return {
    url,
    socket: (path) => {
      const next = url(path)
      next.protocol = next.protocol === "https:" ? "wss:" : "ws:"
      return next
    },
    headers: () => ({}),
    ...(fetch ? { fetch: fetch as unknown as typeof globalThis.fetch } : {}),
  }
}
