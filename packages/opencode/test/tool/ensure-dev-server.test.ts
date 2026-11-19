import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createServer, type Server } from "node:net"
import { networkInterfaces } from "node:os"
import { join } from "node:path"
import { probePort, reachableExternally, serveUrl } from "../../src/tool/ensure-dev-server"

function listen(host = "127.0.0.1"): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, host, () => {
      const addr = server.address()
      if (!addr || typeof addr === "string") {
        server.close()
        reject(new Error("expected TCP address"))
        return
      }
      resolve({ server, port: addr.port })
    })
  })
}

// reachableExternally 는 비루프백 IPv4 가 하나도 없으면 판정을 포기하고 true 를 돌려준다.
// 그 환경(격리된 CI 컨테이너 등)에서는 아래 두 케이스가 구분되지 않으므로 건너뛴다.
const hasExternalIPv4 = Object.values(networkInterfaces())
  .flatMap((infos) => infos ?? [])
  .some((info) => !info.internal && info.family === "IPv4")

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

describe("ensure-dev-server", () => {
  // txt 는 정적 파일이라 servePort() 와 동기화될 수 없다. 포트를 문서에 적어 두면 본행사(3000)와
  // 튜토리얼(3001) 중 한쪽에서 반드시 틀리고, 모델이 그 숫자를 베끼면 waitForPort 가 다른 포트를
  // 기다리다 failed 로 떨어진다. 포트의 유일한 출처는 cmd 인자의 동적 describe 다.
  describe("description doc", () => {
    const doc = readFileSync(join(import.meta.dir, "../../src/tool/ensure-dev-server.txt"), "utf8")

    function section(heading: string): string {
      const start = doc.indexOf(`## ${heading}`)
      expect(start).toBeGreaterThanOrEqual(0)
      const rest = doc.slice(start + heading.length)
      const end = rest.indexOf("\n## ")
      return end < 0 ? rest : rest.slice(0, end)
    }

    test("인자 목록은 스키마에 없는 port 를 문서화하지 않는다", () => {
      const args = section("인자")
        .split("\n")
        .flatMap((line) => line.match(/^- `(\w+)`:/)?.[1] ?? [])
      expect(args).toEqual(["cmd", "cwd", "ready_timeout_ms", "restart"])
    })

    test("명령 예시는 포트 숫자를 하드코딩하지 않는다", () => {
      expect(section("명령 예시 (`cmd` 인자 값)")).not.toMatch(/\b\d{4}\b/)
    })
  })

  describe("probePort", () => {
    test("returns false for an unbound port", async () => {
      // 일단 listen 으로 OS 가 할당한 포트를 잡았다가 즉시 닫아 "확실히 비어있는" 포트 번호를 얻는다.
      const { server, port } = await listen()
      await close(server)
      expect(await probePort(port, "127.0.0.1", 100)).toBe(false)
    })

    test("returns true when something is listening", async () => {
      const { server, port } = await listen()
      try {
        expect(await probePort(port, "127.0.0.1", 250)).toBe(true)
      } finally {
        await close(server)
      }
    })
  })

  describe("reachableExternally", () => {
    test.if(hasExternalIPv4)("is false for a loopback-only bind — the --host 0.0.0.0 case", async () => {
      // `npm run dev` 를 --host 없이 띄운 상태. probePort(127.0.0.1) 는 true 지만 CHP 는 못 닿는다.
      const { server, port } = await listen("127.0.0.1")
      try {
        expect(await probePort(port, "127.0.0.1")).toBe(true)
        expect(await reachableExternally(port)).toBe(false)
      } finally {
        await close(server)
      }
    })

    test.if(hasExternalIPv4)("is true when bound to all interfaces", async () => {
      const { server, port } = await listen("0.0.0.0")
      try {
        expect(await reachableExternally(port)).toBe(true)
      } finally {
        await close(server)
      }
    })

    test.if(hasExternalIPv4)("is false when nothing is listening at all", async () => {
      const { server, port } = await listen("0.0.0.0")
      await close(server)
      expect(await reachableExternally(port)).toBe(false)
    })

    test.if(!hasExternalIPv4)("is undefined when there is no non-loopback address to probe", async () => {
      // 판정 불가 — 호출자(/dev-server/status)는 이걸 "루프백 전용"으로 오해하면 안 된다.
      const { server, port } = await listen("127.0.0.1")
      try {
        expect(await reachableExternally(port)).toBeUndefined()
      } finally {
        await close(server)
      }
    })
  })

  describe("serveUrl", () => {
    const ORIGINAL_USER = process.env["JUPYTERHUB_USER"]
    const ORIGINAL_DOMAIN = process.env["OPENCODE_SERVE_DOMAIN"]

    afterEach(() => {
      if (ORIGINAL_USER === undefined) delete process.env["JUPYTERHUB_USER"]
      else process.env["JUPYTERHUB_USER"] = ORIGINAL_USER
      if (ORIGINAL_DOMAIN === undefined) delete process.env["OPENCODE_SERVE_DOMAIN"]
      else process.env["OPENCODE_SERVE_DOMAIN"] = ORIGINAL_DOMAIN
    })

    test("falls back to localhost when JupyterHub env vars are missing", () => {
      delete process.env["JUPYTERHUB_USER"]
      delete process.env["OPENCODE_SERVE_DOMAIN"]
      expect(serveUrl(3000)).toBe("http://localhost:3000/")
    })

    test("synthesizes https url from JUPYTERHUB_USER + OPENCODE_SERVE_DOMAIN", () => {
      process.env["JUPYTERHUB_USER"] = "student-42"
      process.env["OPENCODE_SERVE_DOMAIN"] = "preview.example.com"
      // 포트는 외부 URL 합성에 포함되지 않는다. 외부 프록시가 sub-domain 으로 라우팅.
      expect(serveUrl(3000)).toBe("https://student-42.preview.example.com/")
    })

    test("falls back when only one of the two env vars is set", () => {
      process.env["JUPYTERHUB_USER"] = "student-42"
      delete process.env["OPENCODE_SERVE_DOMAIN"]
      expect(serveUrl(3000)).toBe("http://localhost:3000/")
    })
  })
})
