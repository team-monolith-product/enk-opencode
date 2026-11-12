import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { MemoryNote } from "../../src/enk/memory-note"
import type { MessageV2 } from "../../src/session/message-v2"

const MB = 1024 * 1024
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function fixture(input: {
  limitMb?: number
  usedMb: number
  procs: { pid: number; ppid: number; mb: number; cmd: string }[]
}) {
  const root = await mkdtemp(path.join(tmpdir(), "memory-note-"))
  dirs.push(root)
  const cgroup = path.join(root, "cgroup")
  const proc = path.join(root, "proc")
  await mkdir(cgroup, { recursive: true })
  await writeFile(path.join(cgroup, "memory.max"), input.limitMb ? `${input.limitMb * MB}\n` : "max\n")
  await writeFile(
    path.join(cgroup, "memory.stat"),
    [`anon ${input.usedMb * MB}`, `file ${500 * MB}`, "shmem 0", "kernel 0", "slab_reclaimable 0"].join("\n"),
  )
  for (const item of input.procs) {
    await mkdir(path.join(proc, String(item.pid)), { recursive: true })
    await writeFile(
      path.join(proc, String(item.pid), "status"),
      `Name:\t${item.cmd.split(" ")[0]}\nPPid:\t${item.ppid}\nRssAnon:\t${item.mb * 1024} kB\nRssShmem:\t0 kB\n`,
    )
    await writeFile(path.join(proc, String(item.pid), "cmdline"), item.cmd.split(" ").join("\0"))
  }
  return { cgroup, proc, root: 1 }
}

const procs = [
  { pid: 1, ppid: 0, mb: 400, cmd: "opencode serve" },
  { pid: 10, ppid: 1, mb: 1, cmd: "sh -c npm run dev" },
  { pid: 11, ppid: 10, mb: 120, cmd: "node next dev" },
  { pid: 20, ppid: 1, mb: 900, cmd: "chrome --headless" },
  { pid: 21, ppid: 20, mb: 200, cmd: "chrome --type=renderer" },
  { pid: 30, ppid: 1, mb: 30, cmd: "python3 app.py" },
]

const user = (id: string) => ({ info: { id, role: "user" } }) as unknown as MessageV2.WithParts

describe("MemoryNote.usage", () => {
  test("reads the cgroup and groups child processes by tree, largest first", async () => {
    const paths = await fixture({ limitMb: 2048, usedMb: 1700, procs })

    const usage = await MemoryNote.usage(paths)

    expect(usage).toMatchObject({ usedMb: 1700, limitMb: 2048, selfMb: 400 })
    expect(usage?.programs).toEqual([
      { cmd: "chrome --headless", mb: 1100, count: 2 },
      { cmd: "node next dev", mb: 121, count: 2 },
      { cmd: "python3 app.py", mb: 30, count: 1 },
    ])
  })

  test("returns nothing without a memory limit, as on a laptop", async () => {
    const paths = await fixture({ usedMb: 1700, procs })

    expect(await MemoryNote.usage(paths)).toBeUndefined()
  })
})

describe("MemoryNote.text", () => {
  test("stays quiet below three quarters of the limit", async () => {
    const paths = await fixture({ limitMb: 2048, usedMb: 1400, procs })

    expect(await MemoryNote.text(user("msg_low"), paths)).toBeUndefined()
  })

  test("names the largest programs and how to free memory", async () => {
    const paths = await fixture({ limitMb: 2048, usedMb: 1600, procs })

    const note = await MemoryNote.text(user("msg_high"), paths)

    expect(note).toContain("<system-reminder>")
    expect(note).toContain("1600 MB of 2048 MB")
    expect(note).toContain("OpenCode itself uses 400 MB")
    expect(note).toContain("- `chrome --headless` (1100 MB, 2 processes)")
    expect(note).toContain("NODE_OPTIONS=--max-old-space-size=512")
    expect(note).not.toContain("—")
  })

  test("keeps the same text within a request until memory climbs to the next level", async () => {
    const first = await fixture({ limitMb: 2048, usedMb: 1600, procs })
    const same = await fixture({ limitMb: 2048, usedMb: 1650, procs })
    const higher = await fixture({ limitMb: 2048, usedMb: 1800, procs })
    const lower = await fixture({ limitMb: 2048, usedMb: 1000, procs })
    const message = user("msg_steps")

    const a = await MemoryNote.text(message, first)
    expect(await MemoryNote.text(message, same)).toBe(a)
    const b = await MemoryNote.text(message, higher)
    expect(b).not.toBe(a)
    expect(b).toContain("1800 MB")
    expect(await MemoryNote.text(message, lower)).toBe(b)
  })
})
