import path from "path"
import { afterEach, test, expect } from "bun:test"
import { Bus } from "../../src/bus"
import { EnvRequest } from "../../src/env-request"
import { Instance } from "../../src/project/instance"
import { EnvFile } from "../../src/util/env-file"
import { tmpdir } from "../fixture/fixture"
import { SessionID } from "../../src/session/schema"

afterEach(async () => {
  await Instance.disposeAll()
})

const info = {
  name: "DATA_GO_KR_KEY",
  label: "식약처 공공데이터",
  reason: "카페인 함량을 가져오려면 필요해요",
}

const sessionID = SessionID.make("ses_test")

async function drain() {
  for (const req of await EnvRequest.list()) await EnvRequest.reject(req.id)
}

test("submit - writes the value to .env and resolves saved", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const file = path.join(tmp.path, ".env")
      const pending = EnvRequest.ask({ sessionID, info })

      const [request] = await EnvRequest.list()
      expect(request.name).toBe("DATA_GO_KR_KEY")

      await EnvRequest.submit({ requestID: request.id, file, value: "super-secret" })
      expect((await pending).status).toBe("saved")

      expect(await EnvFile.names(file)).toEqual(["DATA_GO_KR_KEY"])
      expect(await Bun.file(file).text()).toContain("super-secret")
      expect(await EnvRequest.list()).toEqual([])
    },
  })
})

test("skip and reject - resolve without touching .env", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const file = path.join(tmp.path, ".env")

      const skipped = EnvRequest.ask({ sessionID, info })
      await EnvRequest.skip((await EnvRequest.list())[0].id)
      expect((await skipped).status).toBe("skipped")

      const canceled = EnvRequest.ask({ sessionID, info })
      await EnvRequest.reject((await EnvRequest.list())[0].id)
      expect((await canceled).status).toBe("canceled")

      expect(await EnvFile.names(file)).toEqual([])
    },
  })
})

// 이 기능의 핵심 계약. 값은 요청·이벤트 어디에도 실리지 않는다 — 실리면 모델 컨텍스트로 새는 경로가 생긴다.
test("the value never appears in the request or in bus events", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const file = path.join(tmp.path, ".env")
      const secret = "nobody-should-see-this"
      const seen: string[] = []
      const unsubscribe = [
        Bus.subscribe(EnvRequest.Event.Asked, async (event) => {
          seen.push(JSON.stringify(event.properties))
        }),
        Bus.subscribe(EnvRequest.Event.Resolved, async (event) => {
          seen.push(JSON.stringify(event.properties))
        }),
      ]

      const pending = EnvRequest.ask({ sessionID, info })
      const [request] = await EnvRequest.list()
      expect(JSON.stringify(request)).not.toContain(secret)

      await EnvRequest.submit({ requestID: request.id, file, value: secret })
      expect((await pending).status).toBe("saved")

      expect(seen.length).toBe(2)
      for (const payload of seen) expect(payload).not.toContain(secret)

      for (const stop of unsubscribe) stop()
    },
  })
})

test("submit - an unknown request is a no-op", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const file = path.join(tmp.path, ".env")
      const pending = EnvRequest.ask({ sessionID, info })
      const [request] = await EnvRequest.list()

      await EnvRequest.submit({ requestID: request.id, file, value: "first" })
      // 같은 요청에 두 번 제출해도 두 번째는 조용히 무시된다(두 명이 동시에 저장을 누른 경우).
      await EnvRequest.submit({ requestID: request.id, file, value: "second" })

      expect((await pending).status).toBe("saved")
      expect(await Bun.file(file).text()).toContain("first")
      expect(await Bun.file(file).text()).not.toContain("second")

      await drain()
    },
  })
})

test("submit - a renamed key wins and the tool is told the final name", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const file = path.join(tmp.path, ".env")
      const pending = EnvRequest.ask({ sessionID, info })
      const [request] = await EnvRequest.list()

      // 팀이 도크에서 이름을 고친 경우. 앱이 읽을 이름은 사람이 정한 쪽이다.
      await EnvRequest.submit({ requestID: request.id, file, name: "VITE_DATA_GO_KR_KEY", value: "v" })

      const result = await pending
      expect(result.status).toBe("saved")
      expect(result.name).toBe("VITE_DATA_GO_KR_KEY")
      expect(await EnvFile.names(file)).toEqual(["VITE_DATA_GO_KR_KEY"])
    },
  })
})

test("ask - opens even when a value already exists and submit replaces it", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const file = path.join(tmp.path, ".env")
      await EnvFile.set(file, { DATA_GO_KR_KEY: "expired" })

      // 이미 값이 있어도 요청을 연다. 저장하면 그 자리에서 교체된다.
      const pending = EnvRequest.ask({ sessionID, info })
      const [request] = await EnvRequest.list()
      expect(request.name).toBe("DATA_GO_KR_KEY")

      await EnvRequest.submit({ requestID: request.id, file, value: "fresh" })
      expect((await pending).status).toBe("saved")

      const content = await Bun.file(file).text()
      expect(content).toContain("DATA_GO_KR_KEY=fresh")
      expect(content).not.toContain("expired")
    },
  })
})
