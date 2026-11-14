import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cgroupUsage, parseProcStatus, pickVictim, record, subtrees } from "./memory-guard.mjs"

const MB = 1024 * 1024
const proc = (pid, ppid, mb, cmd = `p${pid}`) => ({ pid, ppid, anon: mb * MB, name: cmd, cmd })

let dir

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "memory-guard-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("memory-guard", () => {
  test("opencode(루트)와 감시자 자신은 후보에서 빠지고, 자식 트리 합계로 가장 큰 것을 고른다", () => {
    const list = [
      proc(1, 0, 1400, "opencode"),
      proc(10, 1, 40, "node memory-guard.mjs"),
      proc(20, 1, 520, "python app.py"),
      proc(30, 1, 10, "npm run dev"),
      proc(31, 30, 200, "node vite"),
      proc(32, 31, 200, "esbuild"),
      proc(33, 31, 210, "node worker"),
    ]
    const trees = subtrees(list, 1, [10])
    expect(trees.map((t) => t.pid)).toEqual([30, 20])
    expect(trees[0].anon).toBe(620 * MB)
    expect(trees[0].pids.sort()).toEqual([30, 31, 32, 33])
    expect(trees[0].cmd).toBe("node worker")
    expect(pickVictim(trees).pid).toBe(30)
  })

  test("가장 큰 트리도 최소 크기보다 작으면 아무것도 죽이지 않는다", () => {
    const trees = subtrees([proc(1, 0, 1800), proc(2, 1, 30)], 1)
    expect(pickVictim(trees, 64 * MB)).toBeUndefined()
    expect(pickVictim([], 64 * MB)).toBeUndefined()
  })

  test("/proc status 에서 익명·공유 메모리를 바이트로 읽는다", () => {
    const p = parseProcStatus("Name:\tnext-server\nPPid:\t7\nRssAnon:\t  2048 kB\nRssShmem:\t  1024 kB\n")
    expect(p).toEqual({ ppid: 7, name: "next-server", anon: 3 * 1024 * 1024 })
  })

  test("cgroup 사용량은 anon+shmem+회수 불가 커널 메모리, 한도가 없으면 끈다", async () => {
    await writeFile(join(dir, "memory.max"), "2147483648\n")
    await writeFile(
      join(dir, "memory.stat"),
      ["anon 1000", "file 900000", "shmem 200", "kernel 500", "slab_reclaimable 300", ""].join("\n"),
    )
    expect(cgroupUsage(dir)).toEqual({ used: 1400, limit: 2147483648 })
    await writeFile(join(dir, "memory.max"), "max\n")
    expect(cgroupUsage(dir)).toBeUndefined()
  })

  test("이벤트 파일이 커지면 최근 줄만 남긴다", async () => {
    const file = join(dir, "events.jsonl")
    await writeFile(
      file,
      Array.from({ length: 3000 }, (_, i) => JSON.stringify({ i, pad: "x".repeat(20) })).join("\n") + "\n",
    )
    record({ type: "kill", time: 1 }, file)
    const lines = (await readFile(file, "utf8")).trim().split("\n")
    expect(lines.length).toBe(21)
    expect(JSON.parse(lines.at(-1))).toEqual({ type: "kill", time: 1 })
  })
})
