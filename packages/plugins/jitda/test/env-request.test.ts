import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EnvRequest } from "../src/env-request"
import { Protect } from "../src/protect"
import { Secret } from "../src/secret"

const dirs: string[] = []
afterEach(async () => {
  Secret.reset()
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})
async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), "jitda-env-request-"))
  dirs.push(dir)
  return dir
}

const info = { name: "WEATHER_API_KEY", label: "날씨 API" }

describe("EnvRequest", () => {
  test("submit writes the value to .env and resolves saved", async () => {
    const dir = await project()
    const requests = EnvRequest.createRequests(() => path.join(dir, ".env"))
    const result = requests.ask({ sessionID: "ses_1", info })
    const [pending] = requests.list()
    expect(await requests.submit({ requestID: pending.id, value: "abc-123" })).toBe(true)
    expect(await result).toEqual({ status: "saved", name: "WEATHER_API_KEY" })
    expect(await readFile(path.join(dir, ".env"), "utf8")).toBe("WEATHER_API_KEY=abc-123\n")
    expect(requests.list()).toEqual([])
  })

  test("skip and reject resolve without touching .env", async () => {
    const dir = await project()
    const requests = EnvRequest.createRequests(() => path.join(dir, ".env"))
    const skipped = requests.ask({ sessionID: "ses_1", info })
    requests.skip(requests.list()[0].id)
    expect((await skipped).status).toBe("skipped")
    const rejected = requests.ask({ sessionID: "ses_1", info })
    requests.reject(requests.list()[0].id)
    expect((await rejected).status).toBe("canceled")
    expect(await readFile(path.join(dir, ".env"), "utf8").catch(() => undefined)).toBeUndefined()
  })

  test("the value never appears in the request or in events", async () => {
    const dir = await project()
    const requests = EnvRequest.createRequests(() => path.join(dir, ".env"))
    const events: unknown[] = []
    requests.on((event) => void events.push(event))
    const result = requests.ask({ sessionID: "ses_1", info })
    await requests.submit({ requestID: requests.list()[0].id, value: "super-secret-value" })
    await result
    expect(JSON.stringify(events)).not.toContain("super-secret-value")
    expect(events.map((event: any) => event.type)).toEqual(["asked", "resolved"])
  })

  test("an unknown request is a no-op and invalid values are rejected", async () => {
    const dir = await project()
    const requests = EnvRequest.createRequests(() => path.join(dir, ".env"))
    expect(await requests.submit({ requestID: "envreq_missing", value: "x" })).toBe(false)
    void requests.ask({ sessionID: "ses_1", info })
    await expect(requests.submit({ requestID: requests.list()[0].id, value: "a\nb" })).rejects.toThrow()
    expect(requests.list()).toHaveLength(1)
  })

  test("a renamed key wins and the tool is told the final name", async () => {
    const dir = await project()
    const requests = EnvRequest.createRequests(() => path.join(dir, ".env"))
    const result = requests.ask({ sessionID: "ses_1", info })
    await requests.submit({ requestID: requests.list()[0].id, value: "v", name: "WEATHER_KEY" })
    expect((await result).name).toBe("WEATHER_KEY")
    expect(await readFile(path.join(dir, ".env"), "utf8")).toBe("WEATHER_KEY=v\n")
  })

  test("aborting the tool call cancels the request", async () => {
    const dir = await project()
    const requests = EnvRequest.createRequests(() => path.join(dir, ".env"))
    const controller = new AbortController()
    const result = requests.ask({ sessionID: "ses_1", info, signal: controller.signal })
    controller.abort()
    expect((await result).status).toBe("canceled")
  })
})

describe("Protect", () => {
  test("tool output never carries a .env value back to the model", async () => {
    const dir = await project()
    await writeFile(path.join(dir, ".env"), "API_KEY=sk-live-1234567890abcdef\n")
    const result = await Protect.protectResult(
      "shell",
      {
        content: [{ type: "text", text: "key is sk-live-1234567890abcdef" }],
        metadata: { output: "sk-live-1234567890abcdef" },
      },
      dir,
    )
    expect(JSON.stringify(result)).not.toContain("sk-live-1234567890abcdef")
    expect(JSON.stringify(result)).toContain("[redacted]")
  })

  test("grep drops grouped .env matches", () => {
    const text = [
      "Found 3 matches",
      "/p/app.js:",
      "  Line 1: const k = process.env.WEATHER_API_KEY",
      "",
      "/p/.env:",
      "  Line 1: WEATHER_API_KEY=x",
      "",
      "/p/.env.example:",
      "  Line 1: WEATHER_API_KEY=",
    ].join("\n")
    expect(Protect.filterSearch(text)).toBe(
      [
        "Found 3 matches",
        "/p/app.js:",
        "  Line 1: const k = process.env.WEATHER_API_KEY",
        "",
        "/p/.env.example:",
        "  Line 1: WEATHER_API_KEY=",
      ].join("\n"),
    )
  })

  test("grep and glob never return .env lines", () => {
    const text = [
      ".env:1:API_KEY=x",
      "src/app.ts:3:const key = process.env.API_KEY",
      "app/.env.local",
      ".env.example:1:A=",
    ].join("\n")
    expect(Protect.filterSearch(text).split("\n")).toEqual([
      "src/app.ts:3:const key = process.env.API_KEY",
      ".env.example:1:A=",
    ])
  })
})
