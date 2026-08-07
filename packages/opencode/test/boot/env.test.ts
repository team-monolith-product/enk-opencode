import { describe, expect, test } from "bun:test"
import { existsSync } from "fs"
import { mkdtemp, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { BootEnv } from "../../src/boot/env"

const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64")

async function bootFile(lines: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "boot-env-"))
  const file = path.join(dir, "boot.env")
  await writeFile(file, lines)
  return file
}

describe("BootEnv", () => {
  test("restores values and deletes the file", async () => {
    const file = await bootFile(
      [`JUPYTERHUB_API_TOKEN ${b64("hub-secret")}`, `ENK_AI_USAGE_TOKEN ${b64("rails-secret")}`, ""].join("\n"),
    )
    const env: NodeJS.ProcessEnv = {}
    const names = BootEnv.load(file, env)

    expect(names).toEqual(["JUPYTERHUB_API_TOKEN", "ENK_AI_USAGE_TOKEN"])
    expect(env.JUPYTERHUB_API_TOKEN).toBe("hub-secret")
    expect(env.ENK_AI_USAGE_TOKEN).toBe("rails-secret")
    // 같은 uid 로 도는 셸에 노출되는 창을 부팅 순간으로 좁힌다
    expect(existsSync(file)).toBe(false)
  })

  test("survives values with newlines, spaces and equals signs", () => {
    const value = 'multi\nline = "value" with spaces'
    const parsed = BootEnv.parse(`WEIRD ${b64(value)}`)
    expect(parsed.WEIRD).toBe(value)
  })

  test("ignores blank and malformed lines", () => {
    expect(BootEnv.parse(["", "no-space-here", ` ${b64("orphan")}`, `OK ${b64("fine")}`].join("\n"))).toEqual({
      OK: "fine",
    })
  })

  test("is a no-op when the file is gone", () => {
    const env: NodeJS.ProcessEnv = { KEEP: "1" }
    expect(BootEnv.load(path.join(tmpdir(), "boot-env-missing", "nope.env"), env)).toEqual([])
    expect(env).toEqual({ KEEP: "1" })
  })
})
