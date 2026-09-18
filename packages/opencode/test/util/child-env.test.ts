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

  test("envFileKeys reads names from every .env variant except .env.example", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "child-env-"))
    await writeFile(path.join(dir, ".env"), "OPENAI_API_KEY=sk-1\nPORT=3000\n")
    await writeFile(path.join(dir, ".env.local"), "LOCAL_ONLY=1\n")
    await writeFile(path.join(dir, ".env.example"), "EXAMPLE_ONLY=1\n")
    const keys = await ChildEnv.envFileKeys(dir)
    expect(keys).toEqual(new Set(["OPENAI_API_KEY", "PORT", "LOCAL_ONLY"]))
  })

  // 이름이 allowlist 를 통과하는 .env 키가 이 저장소가 실제로 막으려는 것 — Bun 이 부팅 때
  // .env 를 process.env 로 올리므로 sanitize 만으로는 그대로 남는다.
  test("forAgent removes project .env keys that the allowlist would pass", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "child-env-"))
    await writeFile(path.join(dir, ".env"), "HTTP_PROXY=http://user:secret@proxy:8080\nNODE_ENV=from-env-file\n")
    await writeFile(path.join(dir, ".env.local"), "NPM_CONFIG_REGISTRY=http://secret-registry\n")

    const withEnvFile = {
      ...base,
      HTTP_PROXY: "http://user:secret@proxy:8080",
      NODE_ENV: "from-env-file",
      NPM_CONFIG_REGISTRY: "http://secret-registry",
    }
    // 대조군: sanitize 만으로는 셋 다 살아남는다
    const sanitized = ChildEnv.sanitize({ base: withEnvFile })
    expect(sanitized.HTTP_PROXY).toBe("http://user:secret@proxy:8080")

    const env = await ChildEnv.forAgent(dir, { base: withEnvFile })
    expect(env.HTTP_PROXY).toBeUndefined()
    expect(env.NODE_ENV).toBeUndefined()
    expect(env.NPM_CONFIG_REGISTRY).toBeUndefined()
    // .env 와 무관한 툴체인 변수는 그대로 남아야 한다 — 다 지워서 통과하는 가짜 성공 방지
    expect(env.PATH).toBe("/usr/bin")
    expect(env.JAVA_HOME).toBe("/usr/lib/jvm")
  })

  test("forAgent keeps names that were explicitly allowed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "child-env-"))
    await writeFile(path.join(dir, ".env"), "HTTP_PROXY=http://proxy:8080\n")
    const env = await ChildEnv.forAgent(dir, {
      base: { ...base, HTTP_PROXY: "http://proxy:8080" },
      allow: ["HTTP_PROXY"],
    })
    expect(env.HTTP_PROXY).toBe("http://proxy:8080")
  })

  test("maskForAgent matches forAgent when merged over the base", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "child-env-"))
    await writeFile(path.join(dir, ".env"), "HTTP_PROXY=http://user:secret@proxy:8080\n")
    const withEnvFile = { ...base, HTTP_PROXY: "http://user:secret@proxy:8080" }

    const masked = ChildEnv.maskForAgent(dir, { base: withEnvFile })
    expect(masked).toHaveProperty("HTTP_PROXY", undefined)

    const merged: Record<string, string | undefined> = { ...withEnvFile, ...masked }
    const kept = Object.entries(merged).filter(([, value]) => value !== undefined)
    expect(Object.fromEntries(kept)).toEqual(await ChildEnv.forAgent(dir, { base: withEnvFile }))
  })

  test("maskForAgent on a directory without .env behaves like mask", () => {
    const dir = path.join(tmpdir(), "child-env-missing-dir")
    expect(ChildEnv.maskForAgent(dir, { base })).toEqual(ChildEnv.mask({ base }))
  })
})
