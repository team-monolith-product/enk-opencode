import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Pty } from "../../src/pty"
import { tmpdir } from "../fixture/fixture"
import { setTimeout as sleep } from "node:timers/promises"

// PTY 는 bash 툴과 같은 "에이전트/사람이 명령을 짜는 셸" 경로다. 계약도 같아야 한다:
// 배포가 주입한 시크릿도, 프로젝트 .env 에 저장한 값도 셸 환경에 존재하지 않는다.
describe("pty env", () => {
  // Bun 이 서버 시작 시 cwd 의 .env 를 process.env 로 올리는 상황을 재현한다. 이름이 allowlist 를
  // 통과하면 ChildEnv.sanitize 만으로는 남으므로, .env 키를 한 번 더 지우는지 확인한다.
  test("project .env keys are absent even when they pass the allowlist", async () => {
    if (process.platform === "win32") return

    const secrets = {
      HTTP_PROXY: "http://user:proxysecret@proxy:8080",
      NPM_CONFIG_REGISTRY: "https://user:npmsecret@registry.example/",
    }
    // 대조군: allowlist 를 통과하고 .env 에는 없는 이름. 이게 보이지 않으면 셸이 아무것도 못 읽어서
    // 통과하는 가짜 성공과 구분할 수 없다.
    const control = { NODE_ENV: "pty-env-control" }

    await using dir = await tmpdir({ git: true })
    await Bun.write(
      path.join(dir.path, ".env"),
      Object.entries(secrets)
        .map(([name, value]) => `${name}=${value}`)
        .join("\n") + "\n",
    )

    const prev = Object.fromEntries(
      [...Object.keys(secrets), ...Object.keys(control)].map((name) => [name, process.env[name]]),
    )
    Object.assign(process.env, secrets, control)
    try {
      await Instance.provide({
        directory: dir.path,
        fn: async () => {
          const out: string[] = []
          const ws = {
            readyState: 1,
            data: { events: { connection: "env" } },
            send: (data: unknown) => {
              out.push(typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8"))
            },
            close: () => {},
          }

          // 로그인 셸 판정(Shell.login)에 걸려 "-l" 이 붙지 않도록 env 로 감싼다. sleep 은 printenv
          // 출력이 나오기 전에 소켓을 붙일 시간을 준다 — 프로세스가 끝나면 세션이 사라진다.
          const info = await Pty.create({
            command: "/usr/bin/env",
            args: ["sh", "-c", "sleep 0.3; printenv"],
            title: "env",
          })
          try {
            Pty.connect(info.id, ws as any)
            await sleep(1500)

            const output = out.join("")
            expect(output).toContain(control.NODE_ENV)
            for (const [name, value] of Object.entries(secrets)) {
              expect(output).not.toContain(value)
              expect(output).not.toContain(name)
            }
          } finally {
            await Pty.remove(info.id)
          }
        },
      })
    } finally {
      for (const [name, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})
