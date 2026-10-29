import type { DocApi } from "./doc-submit"

export type DocEvent = { type: string; properties: Record<string, unknown> }

// /api/jitda/doc/event SSE. 브라우저 EventSource 는 인증 헤더를 못 실어 fetch 스트림으로 읽는다.
// 접속(재접속 포함)마다 서버가 server.connected 를 먼저 보낸다.
export function subscribeDocEvents(api: DocApi, handler: (event: DocEvent) => void) {
  let closed = false
  let controller: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const parse = (frame: string) => {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    if (!data) return
    try {
      const value = JSON.parse(data) as DocEvent
      if (value && typeof value.type === "string") handler({ type: value.type, properties: value.properties ?? {} })
    } catch {}
  }

  const connect = async () => {
    if (closed) return
    controller = new AbortController()
    try {
      const res = await (api.fetch ?? fetch)(api.url("/event"), {
        headers: { ...api.headers(), Accept: "text/event-stream" },
        cache: "no-store",
        signal: controller.signal,
      })
      if (!res.ok || !res.body) throw new Error("doc event stream failed")
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ""
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += value
        let index = buffer.indexOf("\n\n")
        while (index >= 0) {
          parse(buffer.slice(0, index))
          buffer = buffer.slice(index + 2)
          index = buffer.indexOf("\n\n")
        }
      }
    } catch {}
    if (closed) return
    timer = setTimeout(() => void connect(), 1000)
  }

  void connect()

  return () => {
    closed = true
    if (timer) clearTimeout(timer)
    controller?.abort()
  }
}
