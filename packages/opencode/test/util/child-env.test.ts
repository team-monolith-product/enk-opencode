import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { ChildEnv } from "../../src/util/child-env"

const base = {
  PATH: "/usr/bin",
  HOME: "/home/jovyan",
  LANG: "ko_KR.UTF-8",
  LC_ALL: "ko_KR.UTF-8",
  PLAYWRIGHT_BROWSERS_PATH: "/opt/playwright-browsers",
  JAVA_HOME: "/usr/lib/jvm",
  // 배포가 주입하는 운영 시크릿
  JUPYTERHUB_API_TOKEN: "hub-secret",
  JUPYTERHUB_USER: "student1",
  ENK_AI_USAGE_TOKEN: "rails-secret",
  OPENCODE_SERVER_PASSWORD: "server-secret",
  // opencode 가 런타임에 써넣는 토큰
  OPENCODE_CONSOLE_TOKEN: "console-secret",
  AWS_BEARER_TOKEN_BEDROCK: "bedrock-secret",
  // 사용자가 셸에 갖고 있을 법한 것
  GITHUB_TOKEN: "gh-secret",
  STRIPE_SECRET_KEY: "stripe-secret",
  MY_API_KEY: "app-secret",
}

describe("ChildEnv", () => {
  test("passes the base and toolchain variables", () => {
    const env = ChildEnv.sanitize({ base })
    expect(env.PATH).toBe("/usr/bin")
    expect(env.HOME).toBe("/home/jovyan")
    expect(env.LANG).toBe("ko_KR.UTF-8")
    expect(env.LC_ALL).toBe("ko_KR.UTF-8")
    expect(env.JAVA_HOME).toBe("/usr/lib/jvm")
    // 프로덕션 이미지의 playwright MCP 가 이 값 없이는 브라우저를 못 찾는다
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe("/opt/playwright-browsers")
  })

  test("drops injected and runtime secrets", () => {
    const env = ChildEnv.sanitize({ base })
    for (const name of [
      "JUPYTERHUB_API_TOKEN",
      "JUPYTERHUB_USER",
      "ENK_AI_USAGE_TOKEN",
      "OPENCODE_SERVER_PASSWORD",
      "OPENCODE_CONSOLE_TOKEN",
      "AWS_BEARER_TOKEN_BEDROCK",
      "GITHUB_TOKEN",
      "STRIPE_SECRET_KEY",
      "MY_API_KEY",
    ]) {
      expect(env[name]).toBeUndefined()
    }
    expect(Object.values(env)).not.toContain("hub-secret")
  })

  test("denies unknown names by default", () => {
    const env = ChildEnv.sanitize({ base: { ...base, SOME_FUTURE_DEPLOY_VAR: "value" } })
    expect(env.SOME_FUTURE_DEPLOY_VAR).toBeUndefined()
  })

  test("allow option opens specific names", () => {
    const env = ChildEnv.sanitize({ base: { ...base, DATABASE_URL: "postgres://x" }, allow: ["DATABASE_URL"] })
    expect(env.DATABASE_URL).toBe("postgres://x")
  })

  test("deploy namespaces stay closed even when explicitly allowed", () => {
    const env = ChildEnv.sanitize({ base, allow: ["ENK_AI_USAGE_TOKEN", "OPENCODE_SERVER_PASSWORD"] })
    expect(env.ENK_AI_USAGE_TOKEN).toBeUndefined()
    expect(env.OPENCODE_SERVER_PASSWORD).toBeUndefined()
  })

  test("extend is applied after the filter", () => {
    const env = ChildEnv.sanitize({ base, extend: { OPENCODE_TERMINAL: "1" } })
    expect(env.OPENCODE_TERMINAL).toBe("1")
  })

  test("OPENCODE_CHILD_ENV_ALLOW widens the list at call time", () => {
    const prev = process.env["OPENCODE_CHILD_ENV_ALLOW"]
    process.env["OPENCODE_CHILD_ENV_ALLOW"] = "MY_TOOL_HOME, MY_VENDOR_*"
    try {
      const env = ChildEnv.sanitize({ base: { MY_TOOL_HOME: "/opt/tool", MY_VENDOR_REGION: "kr", OTHER: "x" } })
      expect(env.MY_TOOL_HOME).toBe("/opt/tool")
      expect(env.MY_VENDOR_REGION).toBe("kr")
      expect(env.OTHER).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env["OPENCODE_CHILD_ENV_ALLOW"]
      else process.env["OPENCODE_CHILD_ENV_ALLOW"] = prev
    }
  })

  test("mask maps every blocked name to undefined", () => {
    const masked = ChildEnv.mask({ base })
    expect(masked).toHaveProperty("JUPYTERHUB_API_TOKEN", undefined)
    expect("PATH" in masked).toBe(false)
    // node 의 spawn 은 값이 undefined 인 항목을 환경에서 뺀다 — 병합 결과가 sanitize 와 같아야 한다
    const merged: Record<string, string | undefined> = { ...base, ...masked }
    const kept = Object.entries(merged).filter(([, value]) => value !== undefined)
    expect(Object.fromEntries(kept)).toEqual(ChildEnv.sanitize({ base }))
  })

  test("overlay blanks every blocked name instead of dropping it", () => {
    const env = ChildEnv.overlay({ base })
    // 환경을 덧씌우기만 하는 spawn 에서는 "빠진 이름"이 곧 "부모 값 그대로"다. 지우는 대신 덮는다.
    for (const name of Object.keys(base)) expect(name in env).toBe(true)
    for (const name of ["JUPYTERHUB_API_TOKEN", "ENK_AI_USAGE_TOKEN", "GITHUB_TOKEN", "MY_API_KEY"]) {
      expect(env[name]).toBe("")
    }
    // 값이 살아 있는 항목은 sanitize 와 정확히 같아야 한다
    const kept = Object.entries(env).filter(([, value]) => value !== "")
    expect(Object.fromEntries(kept)).toEqual(ChildEnv.sanitize({ base }) as Record<string, string>)
  })

  test("overlay keeps extend and never emits undefined", () => {
    const env = ChildEnv.overlay({
      base,
      extend: { TERM: "xterm-256color", OPENCODE_TERMINAL: "1", GITHUB_TOKEN: undefined },
    })
    expect(env.TERM).toBe("xterm-256color")
    // extend 는 필터 뒤에 얹는 값이라 차단 접두사여도 통과한다 (sanitize 와 같은 규칙)
    expect(env.OPENCODE_TERMINAL).toBe("1")
    // undefined 를 그대로 두면 bun-pty 가 "undefined" 라는 문자열 값으로 실어 보낸다
    expect(env.GITHUB_TOKEN).toBe("")
    for (const value of Object.values(env)) expect(typeof value).toBe("string")
  })

  test("envFileKeys reads names from every .env variant except .env.example", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "child-env-"))
    await writeFile(path.join(dir, ".env"), "OPENAI_API_KEY=sk-1\nPORT=3000\n")
    await writeFile(path.join(dir, ".env.local"), "LOCAL_ONLY=1\n")
    await writeFile(path.join(dir, ".env.example"), "EXAMPLE_ONLY=1\n")
    const keys = await ChildEnv.envFileKeys(dir)
    expect(keys).toEqual(new Set(["OPENAI_API_KEY", "PORT", "LOCAL_ONLY"]))
  })
})
