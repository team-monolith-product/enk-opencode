import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { stat, readFile, writeFile } from "fs/promises"
import { EnvFileRoutes } from "../../src/server/routes/env-file"
import { EnvFile } from "../../src/util/env-file"
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

describe("EnvFile.isSecretFile / mask", () => {
  test("isSecretFile detects .env variants but not .env.example", () => {
    expect(EnvFile.isSecretFile(".env")).toBe(true)
    expect(EnvFile.isSecretFile(".env.local")).toBe(true)
    expect(EnvFile.isSecretFile("sub/dir/.env.production")).toBe(true)
    expect(EnvFile.isSecretFile(".env.example")).toBe(false)
    expect(EnvFile.isSecretFile("env.ts")).toBe(false)
    expect(EnvFile.isSecretFile("README.md")).toBe(false)
  })

  test("mask hides values but keeps key names, comments and blanks", () => {
    const input = "# comment\n\nexport API_KEY=super-secret\nOTHER=value123\nnot a key line\n"
    const masked = EnvFile.mask(input)
    expect(masked).not.toContain("super-secret")
    expect(masked).not.toContain("value123")
    expect(masked).toContain("# comment")
    expect(masked).toContain("API_KEY=••••••••")
    expect(masked).toContain("OTHER=••••••••")
    expect(masked).toContain("not a key line")
  })
})

describe("EnvFile.value", () => {
  test("reads back exactly what set() wrote, quoting included", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, ".env")
    await EnvFile.set(file, { PLAIN: "abc123", TRICKY: 'a b "c" \\d', EMPTY: "" })
    expect(await EnvFile.value(file, "PLAIN")).toBe("abc123")
    expect(await EnvFile.value(file, "TRICKY")).toBe('a b "c" \\d')
    expect(await EnvFile.value(file, "EMPTY")).toBe("")
  })

  test("returns undefined for a missing file or unknown key", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, ".env")
    expect(await EnvFile.value(file, "NOPE")).toBeUndefined()
    await EnvFile.set(file, { A: "1" })
    expect(await EnvFile.value(file, "NOPE")).toBeUndefined()
  })

  test("reads hand-written export and single quoted forms", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, ".env")
    await writeFile(file, "export QUOTED='hello world'\nBARE = spaced-out\n")
    expect(await EnvFile.value(file, "QUOTED")).toBe("hello world")
    expect(await EnvFile.value(file, "BARE")).toBe("spaced-out")
  })
})

describe("EnvFileRoutes", () => {
  test("PUT creates .env with mode 0600", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const res = await put({ API_KEY: "secret-value-1", OTHER_KEY: "v2" })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.keys).toEqual(["API_KEY", "OTHER_KEY"])
        expect(typeof body.updated_at.API_KEY).toBe("number")
        expect(typeof body.updated_at.OTHER_KEY).toBe("number")

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
        const body = await res.json()
        expect(body.keys).toEqual(["OTHER", "API_KEY", "ADDED"])
        expect(await readFile(file, "utf-8")).toBe("# comment\nOTHER=x\n\nAPI_KEY=new-value\nADDED=added-value\n")
      },
    })
  })

  test("GET returns names and times only, never values", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await put({ API_KEY: "super-secret-abc123" })
        const res = await EnvFileRoutes().request("/")
        expect(res.status).toBe(200)
        const raw = await res.text()
        expect(raw).not.toContain("super-secret-abc123")
        const body = JSON.parse(raw)
        expect(body.keys).toEqual(["API_KEY"])
        expect(typeof body.updated_at.API_KEY).toBe("number")
      },
    })
  })

  // 값 조회는 사람용 경로다. LLM 차단은 네트워크 인증이 아니라 ENV_FILE_GUARD 가 맡는다(env-guard 테스트).
  test("GET value returns the stored value", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await put({ API_KEY: "super-secret-abc123" })
        const res = await EnvFileRoutes().request("/API_KEY/value")
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ name: "API_KEY", value: "super-secret-abc123" })
      },
    })
  })

  test("GET value rejects unknown keys and invalid names", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await put({ API_KEY: "value" })
        expect((await EnvFileRoutes().request("/MISSING/value")).status).toBe(404)
        expect((await EnvFileRoutes().request("/bad-name/value")).status).toBe(400)
      },
    })
  })

  // UI 는 「값 필요」줄을 이걸로 가른다 — 이름은 있는데 값이 빈 키.
  test("GET reports which keys have an empty value", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await put({ FILLED: "v", BLANK: "" })
        const body = await (await EnvFileRoutes().request("/")).json()
        expect(body.keys).toEqual(["FILLED", "BLANK"])
        expect(body.empty).toEqual(["BLANK"])
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
        expect(await res.json()).toEqual({ keys: [], updated_at: {}, empty: [] })
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

  test("PUT accepts empty string values", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const res = await put({ EMPTY_OK: "" })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.keys).toEqual(["EMPTY_OK"])
        const file = path.join(tmp.path, ".env")
        expect(await readFile(file, "utf-8")).toBe("EMPTY_OK=\n")
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
        const body = await res.json()
        expect(body.keys).toEqual(["OTHER"])
        expect(body.updated_at.API_KEY).toBeUndefined()
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
