import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Permission } from "../../src/permission"
import { Instance } from "../../src/project/instance"
import { GrepTool } from "../../src/tool/grep"
import { Log } from "../../src/util/log"
import { SessionID, MessageID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const allowAll: Permission.Ruleset = [{ permission: "*", pattern: "*", action: "allow" }]

const ask = (permission: string, pattern: string, ruleset: Permission.Ruleset = allowAll) =>
  Permission.ask({
    sessionID: SessionID.make("session_test"),
    permission,
    patterns: [pattern],
    metadata: {},
    always: [],
    ruleset,
  })

describe("ENV_FILE_GUARD", () => {
  test("denies .env read/edit even with allow-all ruleset", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expect(ask("read", "/project/.env")).rejects.toBeInstanceOf(Permission.DeniedError)
        await expect(ask("read", "/project/.env.local")).rejects.toBeInstanceOf(Permission.DeniedError)
        await expect(ask("read", "/project/secrets.env")).rejects.toBeInstanceOf(Permission.DeniedError)
        await expect(ask("edit", "/project/.env")).rejects.toBeInstanceOf(Permission.DeniedError)
      },
    })
  })

  test("denied error does not leak file contents", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const err = await ask("read", "/project/.env").catch((e) => e)
        expect(err).toBeInstanceOf(Permission.DeniedError)
        expect(err.message).not.toContain("SECRET")
      },
    })
  })

  test("allows .env.example", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expect(ask("read", "/project/.env.example")).resolves.toBeUndefined()
        await expect(ask("edit", "/project/.env.example")).resolves.toBeUndefined()
      },
    })
  })

  test("bash command patterns", () => {
    const guard = Permission.ENV_FILE_GUARD
    expect(Permission.evaluate("bash", "cat .env", guard).action).toBe("deny")
    expect(Permission.evaluate("bash", "cat .env.local", guard).action).toBe("deny")
    expect(Permission.evaluate("bash", "cat ./.env", guard).action).toBe("deny")
    expect(Permission.evaluate("bash", "cat /abs/dir/.env", guard).action).toBe("deny")
    expect(Permission.evaluate("bash", "head -n5 .env | base64", guard).action).toBe("deny")
    // 시크릿과 무관한 명령은 오탐하지 않는다
    expect(Permission.evaluate("bash", "grep process.env src", guard).action).not.toBe("deny")
    expect(Permission.evaluate("bash", "ls -la", guard).action).not.toBe("deny")
    expect(Permission.evaluate("bash", "bun run dev", guard).action).not.toBe("deny")
  })

  test("grep tool never returns .env contents", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, ".env"), "SECRET_TOKEN=super-secret-grep\n")
        await Bun.write(path.join(dir, "app.ts"), "const token = 'visible-value'\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ctx = {
          sessionID: SessionID.make("ses_test"),
          messageID: MessageID.make(""),
          callID: "",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        }
        const grep = await GrepTool.init()
        const secret = await grep.execute({ pattern: "super-secret-grep", path: tmp.path, include: undefined }, ctx)
        expect(secret.output).toBe("No files found")
        const normal = await grep.execute({ pattern: "visible-value", path: tmp.path, include: undefined }, ctx)
        expect(normal.output).toContain("app.ts")
      },
    })
  })
})
