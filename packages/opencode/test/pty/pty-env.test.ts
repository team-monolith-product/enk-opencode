import { describe, expect, test } from "bun:test"
import { writeFile } from "fs/promises"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Pty } from "../../src/pty"
import type { PtyID } from "../../src/pty/schema"
import { tmpdir } from "../fixture/fixture"
import { setTimeout as sleep } from "node:timers/promises"

// PTY 는 bash 툴과 같은 "에이전트가 명령을 짜 넣을 수 있는 셸" 경로다. bash 가 지키는 계약을
// 여기서도 지키는지 본다 — 배포 시크릿도, 프로젝트 .env 값도 셸 환경에 없어야 한다.
describe("pty env", () => {
  // 종료한 세션은 버퍼가 남지 않으므로 먼저 붙고, 셸에 stdin 으로 명령을 밀어 넣어 살아 있는
  // 출력을 받는다. `/usr/bin/env sh` 로 띄우는 이유는 Shell.login 이 `-l` 을 붙이지 않게 하려는 것 —
  // 로그인 셸이면 프로필이 환경을 다시 채워 무엇을 재는지 흐려진다.
  const run = async (script: string) => {
    const info = await Pty.create({ command: "/usr/bin/env", args: ["sh"], title: "env" })
    const out: string[] = []
    try {
      const ws = {
        readyState: 1,
        data: { events: { connection: "reader" } },
        send: (data: unknown) => {
          out.push(typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8"))
        },
        close: () => {},
      }
      Pty.connect(info.id, ws as any)
      await sleep(50)
      out.length = 0
      Pty.write(info.id, `${script}\n`)
      await sleep(300)
      return out.join("")
    } finally {
      await Pty.remove(info.id as PtyID)
    }
  }

  const swap = (values: Record<string, string>) => {
    const prev = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]))
    Object.assign(process.env, values)
    return () => {
      for (const [name, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  }

  test("project .env values are absent from the shell", async () => {
    if (process.platform === "win32") return

    await using dir = await tmpdir({ git: true })
    // 이름이 allowlist(접두사 NPM_CONFIG_)를 통과하는 시크릿. HTTP_PROXY 가 더 흔한 예지만
    // Bun 은 런타임에 대입한 프록시 변수를 열거되지 않게 숨겨서 테스트에서 재현이 안 된다
    // (부팅 때 .env 로 올라온 값은 열거된다).
    const secret = "https://user:pty-env-secret@registry.internal"
    await writeFile(path.join(dir.path, ".env"), `NPM_CONFIG_REGISTRY=${secret}\n`)

    // Bun 이 서버 부팅 때 cwd 의 .env 를 process.env 로 올려 둔 상태를 재현한다.
    // NODE_ENV 은 대조군: allowlist 를 통과하고 .env 에는 없는 이름이다. 없으면 셸이 아무것도
    // 못 읽어서 통과하는 가짜 성공을 구분할 수 없다.
    const restore = swap({ NPM_CONFIG_REGISTRY: secret, NODE_ENV: "pty-env-control" })
    try {
      await Instance.provide({
        directory: dir.path,
        fn: async () => {
          const output = await run("echo registry=[$NPM_CONFIG_REGISTRY] node=[$NODE_ENV]")
          expect(output).toContain("node=[pty-env-control]")
          expect(output).not.toContain("pty-env-secret")
          expect(output).toContain("registry=[]")
        },
      })
    } finally {
      restore()
    }
  })

  test("injected deploy secrets are absent from the shell", async () => {
    if (process.platform === "win32") return

    await using dir = await tmpdir({ git: true })
    const secrets = {
      JUPYTERHUB_API_TOKEN: "hub-pty-secret",
      ENK_AI_USAGE_TOKEN: "rails-pty-secret",
      GITHUB_TOKEN: "gh-pty-secret",
    }
    const restore = swap({ ...secrets, NODE_ENV: "pty-env-control" })
    try {
      await Instance.provide({
        directory: dir.path,
        fn: async () => {
          const script = [...Object.keys(secrets), "NODE_ENV"].map((name) => `echo ${name}=[$${name}]`).join("; ")
          const output = await run(script)
          expect(output).toContain("NODE_ENV=[pty-env-control]")
          for (const value of Object.values(secrets)) expect(output).not.toContain(value)
        },
      })
    } finally {
      restore()
    }
  })
})
