import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { Sandbox } from "../src/sandbox"

afterEach(() => Sandbox.reset())

describe("Sandbox", () => {
  test("is off unless asked for", () => {
    expect(Sandbox.mode({})).toBe("off")
    expect(Sandbox.mode({ OPENCODE_SANDBOX: "AUTO" })).toBe("auto")
    expect(Sandbox.wrap("/bin/sh", {})).toBe("/bin/sh")
  })

  test("bwrap wrapper hides other processes and the data directory, and keeps the cwd", () => {
    const text = Sandbox.script("bwrap", "/bin/bash", ["/data/opencode"])
    expect(text).toContain("'--unshare-pid' '--proc' '/proc' '--tmpfs' '/data/opencode'")
    expect(text).toContain(`'--chdir' "$PWD" '--' '/bin/bash' "$@"`)
  })

  test("a wrapped shell still runs commands with -c", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return
    const env = { ...process.env, OPENCODE_SANDBOX: "auto" }
    const shell = Sandbox.wrap("/bin/sh", env)
    if (Sandbox.backend(env) === "none") return
    expect(shell).not.toBe("/bin/sh")
    const out = spawnSync(shell, ["-c", "echo inside $((1+1))"], { cwd: "/tmp" })
    expect(out.stdout.toString().trim()).toBe("inside 2")
  })
})
