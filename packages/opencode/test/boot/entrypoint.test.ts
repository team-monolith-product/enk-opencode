import { afterEach, describe, expect, test } from "bun:test"
import { rm, stat } from "fs/promises"
import path from "path"
import { BootEnv } from "../../src/boot/env"
import { ChildEnv } from "../../src/util/child-env"

const SCRIPT = path.resolve(import.meta.dir, "../../../../docker/entrypoint.sh")
const files: string[] = []

afterEach(async () => {
  while (files.length) await rm(files.pop()!, { force: true })
})

/**
 * entrypoint 를 실제로 돌려 자식 환경과 부팅 파일을 확인한다. `sh`/`awk`/`base64` 만 쓰므로
 * macOS 와 리눅스에서 같이 돈다 — 컨테이너에서만 검증되는 스크립트를 두면 아무도 안 고친다.
 *
 * Bun.spawn 의 env 는 상속이 아니라 교체라, 테스트 러너가 들고 있는 실제 시크릿이 섞여 들어와
 * 단언을 흔드는 일이 없다.
 */
async function run(env: Record<string, string>) {
  const dump =
    'printenv | sort; echo "===BOOT==="; cat "$OPENCODE_BOOT_ENV"; echo "===PATH==="; printf %s "$OPENCODE_BOOT_ENV"'
  const proc = Bun.spawn(["sh", SCRIPT, "sh", "-c", dump], {
    env: { PATH: process.env.PATH!, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const text = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  if ((await proc.exited) !== 0) throw new Error(`entrypoint failed: ${err}`)
  const [child, boot, raw] = text.split(/^===(?:BOOT|PATH)===$/m)
  const file = raw.trim()
  files.push(file)
  return { child, boot, file }
}

describe("docker/entrypoint.sh", () => {
  test("moves secret-looking names out of the child environment", async () => {
    const { child, boot } = await run({
      JUPYTERHUB_API_TOKEN: "hub-secret",
      ENK_AI_USAGE_TOKEN: "rails-secret",
      OPENCODE_SERVER_PASSWORD: "server-secret",
      JUPYTERHUB_API_URL: "http://hub/api",
    })

    for (const value of ["hub-secret", "rails-secret", "server-secret"]) expect(child).not.toContain(value)
    // 시크릿이 아닌 값은 그대로 둔다 — 넓게 잡되 필요한 건 안 건드린다
    expect(child).toContain("JUPYTERHUB_API_URL=http://hub/api")

    expect(BootEnv.parse(boot)).toEqual({
      JUPYTERHUB_API_TOKEN: "hub-secret",
      ENK_AI_USAGE_TOKEN: "rails-secret",
      OPENCODE_SERVER_PASSWORD: "server-secret",
    })
  })

  test("covers the same keywords as the ChildEnv deny list", async () => {
    // 한쪽만 아는 이름은 "자식 환경에서는 걸러지는데 exec environ 에는 남는" 틈이 된다.
    const names = ["MY_AUTH_HEADER", "SSH_AUTH_SOCK", "MY_APIKEY", "MY_CREDENTIALS", "MY_PRIVATE_PEM"]
    const { child } = await run(Object.fromEntries(names.map((name, i) => [name, `deny-secret-${i}`])))
    for (const name of names) {
      expect(ChildEnv.allowed(name)).toBe(false)
      expect(child).not.toContain(name + "=")
    }
  })

  test("OPENCODE_SCRUB_ENV adds names the pattern does not catch", async () => {
    const { child, boot } = await run({
      JUPYTERHUB_CLIENT_ID: "client-id-value",
      OPENCODE_SCRUB_ENV: "JUPYTERHUB_CLIENT_ID",
    })
    expect(child).not.toContain("client-id-value")
    expect(BootEnv.parse(boot)).toEqual({ JUPYTERHUB_CLIENT_ID: "client-id-value" })
  })

  test("carries values with newlines through base64 intact", async () => {
    const value = 'multi\nline = "value"'
    const { boot } = await run({ MY_SECRET: value })
    expect(BootEnv.parse(boot).MY_SECRET).toBe(value)
  })

  test("writes the boot file with owner-only permissions", async () => {
    const { file } = await run({ MY_TOKEN: "x" })
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })
})
