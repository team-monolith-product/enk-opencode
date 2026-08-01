import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { EnvRequest } from "../../src/env-request"
import { EnvRequestRoutes } from "../../src/server/routes/env-request"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { SessionID } from "../../src/session/schema"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const info = { name: "DATA_GO_KR_KEY", label: "식약처 공공데이터" }
const sessionID = SessionID.make("ses_test")

const post = (url: string, body?: unknown) =>
  EnvRequestRoutes().request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

describe("EnvRequestRoutes", () => {
  test("GET / lists pending requests without any value field", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const pending = EnvRequest.ask({ sessionID, info })

        const res = await EnvRequestRoutes().request("/")
        expect(res.status).toBe(200)
        const list = (await res.json()) as Array<Record<string, unknown>>
        expect(list.length).toBe(1)
        expect(list[0].name).toBe("DATA_GO_KR_KEY")
        expect(list[0]).not.toHaveProperty("value")

        await EnvRequest.reject((await EnvRequest.list())[0].id)
        await pending
      },
    })
  })

  test("POST submit stores the value in the project .env", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const pending = EnvRequest.ask({ sessionID, info })
        const [request] = await EnvRequest.list()

        const res = await post(`/${request.id}/submit`, { value: "from-the-dock" })
        expect(res.status).toBe(200)
        expect((await pending).status).toBe("saved")

        const content = await Bun.file(path.join(tmp.path, ".env")).text()
        expect(content).toContain("DATA_GO_KR_KEY=from-the-dock")
      },
    })
  })

  test("POST skip resolves without writing", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const pending = EnvRequest.ask({ sessionID, info })
        const [request] = await EnvRequest.list()

        const res = await post(`/${request.id}/skip`)
        expect(res.status).toBe(200)
        expect((await pending).status).toBe("skipped")
        expect(await Bun.file(path.join(tmp.path, ".env")).exists()).toBe(false)
      },
    })
  })

  test("POST submit rejects a value with newlines", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const pending = EnvRequest.ask({ sessionID, info })
        const [request] = await EnvRequest.list()

        // 개행이 섞이면 .env 한 줄 계약이 깨지고 뒤 라인이 다른 키로 읽힌다.
        const res = await post(`/${request.id}/submit`, { value: "line\nSNEAKY=injected" })
        expect(res.status).toBe(400)

        await EnvRequest.reject(request.id)
        await pending
      },
    })
  })
})
