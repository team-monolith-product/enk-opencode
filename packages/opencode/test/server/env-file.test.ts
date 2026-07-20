import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { stat, readFile, writeFile } from "fs/promises"
import { EnvFileRoutes } from "../../src/server/routes/env-file"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const put = (values: Record<string, string>) =>
  EnvFileRoutes().request("/", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values }),
  })

describe("EnvFileRoutes", () => {
  test("PUT creates .env with mode 0600", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const res = await put({ API_KEY: "secret-value-1", OTHER_KEY: "v2" })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ keys: ["API_KEY", "OTHER_KEY"] })

        const file = path.join(tmp.path, ".env")
        expect(await readFile(file, "utf-8")).toBe("API_KEY=secret-value-1\nOTHER_KEY=v2\n")
        if (process.platform !== "win32") {
          const info = await stat(file)
          expect(info.mode & 0o777).toBe(0o600)
        }
      },
    })
  })

  test("PUT merges: preserves comments and unrelated keys, updates in place", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = path.join(tmp.path, ".env")
        await writeFile(file, "# comment\nOTHER=x\n\nexport API_KEY=old\n")

        const res = await put({ API_KEY: "new-value", ADDED: "added-value" })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ keys: ["OTHER", "API_KEY", "ADDED"] })
        expect(await readFile(file, "utf-8")).toBe("# comment\nOTHER=x\n\nAPI_KEY=new-value\nADDED=added-value\n")
      },
    })
  })

  test("GET returns names only, never values", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await put({ API_KEY: "super-secret-abc123" })
        const res = await EnvFileRoutes().request("/")
        expect(res.status).toBe(200)
        const raw = await res.text()
        expect(raw).not.toContain("super-secret-abc123")
        expect(JSON.parse(raw)).toEqual({ keys: ["API_KEY"] })
      },
    })
  })

  test("GET returns empty list when no .env", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const res = await EnvFileRoutes().request("/")
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ keys: [] })
      },
    })
  })

  test("rejects invalid key names and newline values", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await put({ "1BAD": "x" })).status).toBe(400)
        expect((await put({ "A-B": "x" })).status).toBe(400)
        expect((await put({ GOOD: "line1\nline2" })).status).toBe(400)
        expect((await put({})).status).toBe(400)
      },
    })
  })

  test("quotes values with special characters", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await put({ API_KEY: 'has spaces and "quotes"' })
        const file = path.join(tmp.path, ".env")
        expect(await readFile(file, "utf-8")).toBe('API_KEY="has spaces and \\"quotes\\""\n')
      },
    })
  })

  test("DELETE removes only the target key, including export form", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = path.join(tmp.path, ".env")
        await writeFile(file, "# keep\nexport API_KEY=gone\nOTHER=stays\n")

        const res = await EnvFileRoutes().request("/API_KEY", { method: "DELETE" })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ keys: ["OTHER"] })
        expect(await readFile(file, "utf-8")).toBe("# keep\nOTHER=stays\n")
      },
    })
  })

  test("DELETE rejects invalid key name", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const res = await EnvFileRoutes().request("/bad-name", { method: "DELETE" })
        expect(res.status).toBe(400)
      },
    })
  })
})
