import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Process } from "../../src/util/process"
import { tmpdir } from "../fixture/fixture"

const root = path.join(import.meta.dir, "../..")
const worker = path.join(import.meta.dir, "../fixture/pty-env-worker.ts")

/**
 * test/tool/bash.test.ts 의 "injected secrets are absent from the child shell" 과 짝이 되는 테스트다.
 *
 * bash 쪽과 다른 점: 여기서는 시크릿을 `process.env` 에 직접 넣으면 안 된다. bun-pty 는 부모의
 * **exec 시점** `environ` 을 자식에게 물려주는데 런타임 대입은 거기 안 들어가므로, 그렇게 짠
 * 테스트는 필터가 없어도 통과한다. 그래서 오염된 환경으로 워커를 exec 한다.
 */
describe("pty env", () => {
  // /usr/bin/env 를 덤프 명령으로 쓴다. 윈도우 동등물은 셸에 따라 갈려서 제외한다.
  if (process.platform === "win32") return

  const secrets = {
    // allowlist 를 통과하지 못하고, 이름에 시크릿 키워드도 없는 순수한 상속 케이스
    PTY_EXEC_TIME_MARKER: "exec-time-marker-value",
    // 배포가 주입하는 운영 시크릿
    JUPYTERHUB_API_TOKEN: "hub-secret-value",
    GITHUB_TOKEN: "gh-secret-value",
    // 컨테이너 entrypoint 의 *TOKEN*/*KEY*/... 글롭에 안 걸리는 이름
    SSH_AUTH_SOCK: "/tmp/agent-secret-value",
  }
  // 대조군: allowlist 를 통과하는 이름은 그대로 보여야 한다. 없으면 덤프를 아예 못 읽어서
  // 통과하는 가짜 성공을 구분할 수 없다.
  const control = { NODE_ENV: "pty-env-control" }

  test(
    "exec-time environment does not leak into the child terminal",
    async () => {
      await using dir = await tmpdir({ git: true })
      const out = path.join(dir.path, "pty-env-dump.txt")

      const result = await Process.run([process.execPath, worker, JSON.stringify({ dir: dir.path, out })], {
        cwd: root,
        env: { ...secrets, ...control },
        nothrow: true,
      })
      if (result.code !== 0) throw new Error(result.stderr.toString("utf8"))

      const output = await fs.readFile(out, "utf8")
      expect(output).toContain(control.NODE_ENV)
      for (const value of Object.values(secrets)) expect(output).not.toContain(value)
    },
    { timeout: 60_000 },
  )
})
