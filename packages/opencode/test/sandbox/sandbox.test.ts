import { afterEach, describe, expect, test } from "bun:test"
import { realpathSync } from "fs"
import { Global } from "../../src/global"
import { Sandbox } from "../../src/sandbox"

const prev = process.env["OPENCODE_SANDBOX"]

function mode(value?: string) {
  if (value === undefined) delete process.env["OPENCODE_SANDBOX"]
  else process.env["OPENCODE_SANDBOX"] = value
  Sandbox.reset()
}

afterEach(() => mode(prev))

describe("Sandbox", () => {
  test("is off unless asked for", async () => {
    mode(undefined)
    expect(Sandbox.mode()).toBe("off")
    expect(await Sandbox.backend()).toBe("none")
    expect(await Sandbox.wrap({ shell: "/bin/sh", command: "echo hi", cwd: "/tmp" })).toBeUndefined()
  })

  // 조용히 무방비로 도는 게 최악이다 — require 는 백엔드가 없으면 도구 호출을 실패시킨다.
  test("require throws when no backend is usable", async () => {
    mode("require")
    if ((await Sandbox.backend()) !== "none") return
    await expect(Sandbox.wrap({ shell: "/bin/sh", command: "echo hi", cwd: "/tmp" })).rejects.toThrow("require")
  })

  test("hides opencode's own data directory, not its bin cache", () => {
    // auth.json / opencode.db / log 는 data 아래, 설치한 LSP 바이너리는 cache 아래다
    expect(Sandbox.hidden()).toEqual([realpathSync(Global.Path.data)])
    expect(Sandbox.hidden().some((dir) => realpathSync(Global.Path.cache).startsWith(dir + "/"))).toBe(false)
  })

  // macOS 의 sandbox 프로파일은 해석된 경로로 매칭한다. /var/folders 같은 심링크 경로를 그대로
  // 넣으면 규칙이 조용히 아무것도 안 막는다 — 실패가 드러나지 않는 종류라 못 박아 둔다.
  test("hidden paths have symlinks resolved", () => {
    for (const dir of Sandbox.hidden()) expect(dir).toBe(realpathSync(dir))
  })

  if (process.platform === "darwin" || process.platform === "linux") {
    test("auto wraps the shell when the platform backend works", async () => {
      mode("auto")
      const found = await Sandbox.backend()
      const argv = await Sandbox.wrap({ shell: "/bin/sh", command: "echo hi", cwd: "/tmp" })
      if (found === "none") {
        expect(argv).toBeUndefined()
        return
      }
      expect(argv![0]).toBe(found === "bwrap" ? "bwrap" : "sandbox-exec")
      // 원래 명령은 그대로 셸에 넘어간다
      expect(argv!.slice(-3)).toEqual(["/bin/sh", "-c", "echo hi"])
      expect(argv!.join(" ")).toContain(Sandbox.hidden()[0])
    })

    test("a wrapped shell still runs and cannot read the data directory", async () => {
      mode("auto")
      if ((await Sandbox.backend()) === "none") return
      const file = `${Global.Path.data}/auth.json`
      await Bun.write(file, '{"probe":"sandbox"}')
      const argv = (await Sandbox.wrap({
        shell: "/bin/sh",
        command: `echo alive; cat ${JSON.stringify(file)} 2>&1 || true`,
        cwd: "/tmp",
      }))!
      const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })
      const out = await new Response(proc.stdout).text()
      await proc.exited
      expect(out).toContain("alive")
      expect(out).not.toContain("sandbox")
    })
  }
})
