import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Permission } from "../../src/permission"
import { Instance } from "../../src/project/instance"
import { GrepTool } from "../../src/tool/grep"
import { BashTool } from "../../src/tool/bash"
import { Log } from "../../src/util/log"
import { Secret } from "../../src/util/secret"
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

  // 파일만 막으면 서버 API 로 우회해 같은 값을 읽을 수 있다 — 값 조회 경로도 같은 가드가 덮는다.
  test("value read API is denied for bash and webfetch", () => {
    const guard = Permission.ENV_FILE_GUARD
    const url = "http://localhost:4096/env-file/API_KEY/value"
    expect(Permission.evaluate("bash", `curl -s ${url}`, guard).action).toBe("deny")
    expect(Permission.evaluate("bash", `curl -u opencode:pw ${url} | jq .value`, guard).action).toBe("deny")
    expect(Permission.evaluate("webfetch", url, guard).action).toBe("deny")
    // 이 저장소의 env-file 소스를 다루는 작업은 걸리지 않는다 — 경로에 슬래시가 뒤따르지 않는다.
    expect(Permission.evaluate("bash", "bun test test/server/env-file.test.ts", guard).action).not.toBe("deny")
    expect(Permission.evaluate("bash", "cat src/server/routes/env-file.ts", guard).action).not.toBe("deny")
    expect(Permission.evaluate("webfetch", "https://example.com/docs", guard).action).not.toBe("deny")
  })

  // ChildEnv 는 자식 프로세스의 환경만 바꾼다. exec 시점 environ 을 파일로 읽는 이 경로는
  // 필터로 못 막으므로 권한 계층이 덮어야 한다.
  test("process environ paths are denied", () => {
    const guard = Permission.ENV_FILE_GUARD
    expect(Permission.evaluate("read", "/proc/self/environ", guard).action).toBe("deny")
    expect(Permission.evaluate("read", "/proc/1/environ", guard).action).toBe("deny")
    expect(Permission.evaluate("bash", "cat /proc/self/environ", guard).action).toBe("deny")
    expect(Permission.evaluate("bash", "tr '\\0' '\\n' < /proc/1/environ", guard).action).toBe("deny")
    expect(Permission.evaluate("read", "/proc/self/status", guard).action).not.toBe("deny")
  })

  test("environment dump commands are denied", () => {
    const guard = Permission.ENV_FILE_GUARD
    for (const command of [
      "env",
      "printenv",
      "printenv JUPYTERHUB_API_TOKEN",
      "/usr/bin/env",
      "/usr/bin/printenv",
      "env -0",
      "export",
      "export -p",
      "declare",
      "declare -x",
      "typeset -p",
      "set",
      "Get-ChildItem Env:",
    ]) {
      expect([command, Permission.evaluate("bash", command, guard).action]).toEqual([command, "deny"])
    }
    // 환경을 덤프하지 않는 정상 사용은 걸리지 않는다
    for (const command of [
      "env FOO=1 npm run dev",
      "export FOO=1",
      "declare -a items",
      "set -e",
      "set -euo pipefail",
      "node -e 'console.log(1)'",
      "ls packages/opencode/src/env",
      "cat src/env/index.ts",
    ]) {
      expect([command, Permission.evaluate("bash", command, guard).action]).not.toEqual([command, "deny"])
    }
  })

  // 앱은 .env 값으로 동작하는데 그 앱 코드를 쓰는 게 에이전트다. `process.env` 를 뱉는 라우트를
  // 만들고 curl 로 되읽으면 ChildEnv 필터를 우회하므로, 도구 출력에서 값을 지우는 관문을 둔다.
  test("tool output never carries a .env value back to the model", async () => {
    const secret = "sk-proj-e2e-6d1a9c4f2b"
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => Bun.write(path.join(dir, ".env"), `OPENAI_API_KEY=${secret}\nPORT=3000\n`),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Secret.reset()
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
        const bash = await BashTool.init()
        // 에이전트가 자기 앱에서 값을 되읽어 오는 상황
        const result = await bash.execute(
          { command: `echo '{"key":"${secret}","port":3000}'`, description: "Read app response" },
          ctx,
        )
        expect(result.output).not.toContain(secret)
        expect(result.output).toContain("[redacted]")
        // 시크릿이 아닌 값은 멀쩡히 남는다
        expect(result.output).toContain("3000")
      },
    })
    Secret.reset()
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
