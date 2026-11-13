import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { buffer } from "node:stream/consumers"
import { spawn } from "../../src/lsp/launch"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("lsp.launch", () => {
  // 언어 서버는 프로젝트 코드를 로드한다(eslint 설정, tsserver 플러그인 ...). 그 안에서 도는 건
  // 에이전트가 쓴 코드라 bash/PTY/MCP 와 같은 기준으로 프로젝트 .env 값이 없어야 한다.
  test("project .env values are absent from the spawned server", async () => {
    if (process.platform === "win32") return

    await using tmp = await tmpdir({ git: true })
    const secret = "https://user:lsp-env-secret@registry.internal"
    await fs.writeFile(path.join(tmp.path, ".env"), `NPM_CONFIG_REGISTRY=${secret}\n`)

    const prev = { NPM_CONFIG_REGISTRY: process.env["NPM_CONFIG_REGISTRY"], NODE_ENV: process.env["NODE_ENV"] }
    process.env["NPM_CONFIG_REGISTRY"] = secret
    // 대조군: allowlist 를 통과하고 .env 에는 없는 이름
    process.env["NODE_ENV"] = "lsp-env-control"

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const proc = spawn("/bin/sh", ["-c", "echo registry=[$NPM_CONFIG_REGISTRY] node=[$NODE_ENV]"], {
            cwd: tmp.path,
          })
          const output = (await buffer(proc.stdout!)).toString()
          expect(output).toContain("node=[lsp-env-control]")
          expect(output).not.toContain("lsp-env-secret")
          expect(output).toContain("registry=[]")
        },
      })
    } finally {
      for (const [name, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  test("spawns cmd scripts with spaces on Windows", async () => {
    if (process.platform !== "win32") return

    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "with space")
    const file = path.join(dir, "echo cmd.cmd")

    await fs.mkdir(dir, { recursive: true })
    await Bun.write(file, "@echo off\r\nif %~1==--stdio exit /b 0\r\nexit /b 7\r\n")

    const proc = spawn(file, ["--stdio"])

    expect(await proc.exited).toBe(0)
  })
})
