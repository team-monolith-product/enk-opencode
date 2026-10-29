import { describe, expect, test } from "bun:test"
import { Guard } from "../src/guard"

const deny = (action: string, resource: string) => Guard.decide(action, resource) === "deny"

describe("Guard", () => {
  test("denies .env read and edit but allows .env.example", () => {
    for (const resource of [".env", ".env.local", "app/.env", "/project/.env"]) {
      expect(deny("read", resource)).toBe(true)
      expect(deny("edit", resource)).toBe(true)
    }
    expect(deny("read", ".env.example")).toBe(false)
    expect(deny("edit", "app/.env.example")).toBe(false)
  })

  test("shell command patterns", () => {
    expect(deny("shell", "cat .env")).toBe(true)
    expect(deny("shell", "cat .env.local")).toBe(true)
    expect(deny("shell", "cat ./.env")).toBe(true)
    expect(deny("shell", "cat /abs/dir/.env")).toBe(true)
    expect(deny("shell", "head -n5 .env")).toBe(true)
    expect(deny("shell", "grep process.env src")).toBe(false)
    expect(deny("shell", "ls -la")).toBe(false)
    expect(deny("shell", "bun run dev")).toBe(false)
  })

  test("value read RPC is denied for shell and webfetch", () => {
    const url = "http://127.0.0.1:8888/api/rpc/jitda.env-file/value"
    expect(deny("shell", `curl -s ${url}`)).toBe(true)
    expect(deny("webfetch", url)).toBe(true)
    expect(deny("webfetch", "https://example.com/docs")).toBe(false)
  })

  test("process environ, memory, credentials and session DB are denied", () => {
    for (const [action, resource] of [
      ["read", "/proc/self/environ"],
      ["read", "/proc/1/environ"],
      ["shell", "cat /proc/self/environ"],
      ["read", "/proc/self/mem"],
      ["read", "/proc/1/maps"],
      ["shell", "dd if=/proc/1/mem bs=1 count=100"],
      ["read", "/home/jovyan/.local/share/opencode/auth.json"],
      ["edit", "/home/jovyan/.local/share/opencode/auth.json"],
      ["shell", "cat ~/.local/share/opencode/auth.json"],
      ["read", "/home/jovyan/.local/share/opencode/opencode.db"],
      ["shell", "sqlite3 /home/jovyan/.local/share/opencode/opencode.db-wal .dump"],
    ] as const)
      expect([resource, deny(action, resource)]).toEqual([resource, true])
    expect(deny("read", "/proc/self/status")).toBe(false)
    expect(deny("shell", "ls ~/.cache/opencode/bin")).toBe(false)
  })

  test("environment dump commands are denied", () => {
    for (const command of [
      "env",
      "printenv",
      "printenv JUPYTERHUB_API_TOKEN",
      "/usr/bin/env",
      "/usr/bin/printenv",
      "env -0",
      "export",
      "export -p",
      "declare",
      "declare -x",
      "typeset -p",
      "set",
      "Get-ChildItem Env:",
    ])
      expect([command, deny("shell", command)]).toEqual([command, true])
    for (const command of [
      "env FOO=1 npm run dev",
      "export FOO=1",
      "declare -a items",
      "set -e",
      "set -euo pipefail",
      "node -e 'console.log(1)'",
      "cat src/env/index.ts",
    ])
      expect([command, deny("shell", command)]).toEqual([command, false])
  })
})
