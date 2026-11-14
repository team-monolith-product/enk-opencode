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
  stat?: string[]
}) {
  const root = await mkdtemp(path.join(tmpdir(), "memory-note-"))
  dirs.push(root)
  const cgroup = path.join(root, "cgroup")
  const proc = path.join(root, "proc")
  await mkdir(cgroup, { recursive: true })
  await writeFile(path.join(cgroup, "memory.max"), input.limitMb ? `${input.limitMb * MB}\n` : "max\n")
  await writeFile(
    path.join(cgroup, "memory.stat"),
    (input.stat ?? [`anon ${input.usedMb * MB}`, `file ${500 * MB}`, "shmem 0", "kernel 0", "slab_reclaimable 0"]).join(
      "\n",
    ),
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
      { cmd: "chrome", mb: 1100, count: 2 },
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

  test("shows usage, the largest programs and what to do", async () => {
    const paths = await fixture({ limitMb: 2048, usedMb: 1600, procs })

    const note = await MemoryNote.text(user("msg_high"), paths)

    expect(note).toBe(
      [
        "<system-reminder>",
        "Workspace memory: 1600 MB of 2048 MB (78%). OpenCode: 400 MB.",
        "- `chrome`: 1100 MB (2 processes)",
        "- `node next dev`: 121 MB (2 processes)",
        "- `python3 app.py`: 30 MB",
        "If the limit is reached, the whole workspace restarts. Before continuing, stop the programs above that are no longer needed (such as a browser you finished checking) and keep the preview dev server running. Then tell the user briefly what you stopped and, for each large program you left running, its memory use and what it does in plain words, so they can decide about those. For a program you did not start, first read the start of its script in this turn (for example `head -30 <file>`) and describe it only from what you read, not from its name. If you cannot read it, say you do not know what it does.",
        "</system-reminder>",
      ].join("\n"),
    )
  })

  test("keeps the same text within a request until the level changes", async () => {
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
    expect(await MemoryNote.text(message, lower)).toBeUndefined()
  })

  test("follows a limit that changes while the workspace runs", async () => {
    const small = await fixture({ limitMb: 2048, usedMb: 1800, procs })
    const raised = await fixture({ limitMb: 3072, usedMb: 1800, procs })
    const busy = await fixture({ limitMb: 3072, usedMb: 2400, procs })
    const message = user("msg_resize")

    expect(await MemoryNote.text(message, small)).toContain("1800 MB of 2048 MB")
    expect(await MemoryNote.text(message, raised)).toBeUndefined()
    expect(await MemoryNote.text(message, busy)).toContain("2400 MB of 3072 MB")
  })
})

describe("MemoryNote details", () => {
  test("skips reading processes below three quarters of the limit", async () => {
    const paths = await fixture({ limitMb: 2048, usedMb: 1400, procs })

    expect(await MemoryNote.usage(paths)).toEqual({ usedMb: 1400, limitMb: 2048, selfMb: 0, programs: [] })
  })

  test("counts kernel memory from its parts on kernels without a kernel total", async () => {
    const paths = await fixture({
      limitMb: 2048,
      usedMb: 0,
      procs,
      stat: [`anon ${1500 * MB}`, "shmem 0", `kernel_stack ${50 * MB}`, `pagetables ${60 * MB}`, `sock ${10 * MB}`],
    })

    expect((await MemoryNote.usage(paths))?.usedMb).toBe(1620)
  })

  test("keeps the script path, drops long flags and hides secrets", () => {
    expect(
      MemoryNote.label([
        "node",
        "--max-old-space-size=4096",
        "--api-key",
        "sk-live-123",
        "/home/jovyan/project/server.js",
        "abcdefghijklmnopqrstuvwxyz0123456789",
        "</system-reminder>`",
      ]),
    ).toBe("node /home/jovyan/project/server.js *** /system-reminder")
  })

  test("says OpenCode itself is using the memory when no other program is large", async () => {
    const paths = await fixture({
      limitMb: 2048,
      usedMb: 1700,
      procs: [{ pid: 1, ppid: 0, mb: 1600, cmd: "opencode" }],
    })

    const note = await MemoryNote.text(user("msg_alone"), paths)

    expect(note).toContain("most of it is OpenCode itself")
    expect(note).not.toContain("programs above")
  })

  test("keeps the note of an earlier request so later turns send the same history", async () => {
    const paths = await fixture({ limitMb: 2048, usedMb: 1600, procs })

    const note = await MemoryNote.text(user("msg_earlier"), paths)

    expect(MemoryNote.earlier("msg_earlier")).toBe(note)
    expect(MemoryNote.earlier("msg_unknown")).toBeUndefined()
  })
})
