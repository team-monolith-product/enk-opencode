import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { writeFile } from "fs/promises"
import { MemoryNote } from "../../src/enk/memory-note"
import type { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../fixture/fixture"

afterEach(() => {
  delete process.env["ENK_MEMORY_GUARD_FILE"]
})

const kill = (time: number, cmd = "next build") => ({
  type: "kill" as const,
  time,
  usedMb: 1850,
  limitMb: 1907,
  cmd,
  mb: 900,
})
const warn = (time: number) => ({
  type: "warn" as const,
  time,
  usedMb: 1500,
  limitMb: 1907,
  top: [{ cmd: "python app.py", mb: 400 }],
})

function user(id: string, created: number) {
  return { info: { id, role: "user", time: { created } }, parts: [] } as unknown as MessageV2.WithParts
}

describe("MemoryNote", () => {
  test("사용자 메시지 이후에 종료된 프로세스만 알린다", () => {
    expect(MemoryNote.compose([kill(100)], 200)).toBeUndefined()
    const note = MemoryNote.compose([kill(100, "stale-job"), kill(300)], 200, 400)!
    expect(note).toContain("`next build` (900 MB)")
    expect(note).not.toContain("stale-job")
    expect(note).toContain("1850 MB of 1907 MB")
  })

  test("종료가 없으면 최근 경고만 보여 주고, 오래된 경고는 무시한다", () => {
    expect(MemoryNote.compose([warn(300)], 200, 300 + 60_000)).toContain("`python app.py` (400 MB)")
    expect(MemoryNote.compose([warn(300)], 200, 300 + 10 * 60_000)).toBeUndefined()
    expect(MemoryNote.compose([warn(300), kill(310)], 200, 320)).not.toContain("python app.py")
  })

  test("파일이 없거나 깨진 줄이 있어도 읽을 수 있는 이벤트만 쓴다", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "events.jsonl")
    process.env["ENK_MEMORY_GUARD_FILE"] = file
    expect(await MemoryNote.text(user("m0", 0))).toBeUndefined()
    await writeFile(file, ["{broken", JSON.stringify(kill(Date.now())), ""].join("\n"))
    expect(await MemoryNote.text(user("m1", Date.now() - 1000))).toContain("next build")
  })

  test("같은 메시지에서는 새 종료가 없으면 경고가 사라져도 같은 문구를 유지한다", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "events.jsonl")
    process.env["ENK_MEMORY_GUARD_FILE"] = file
    const start = Date.now() - 1000
    await writeFile(file, JSON.stringify(warn(Date.now())) + "\n")
    const first = await MemoryNote.text(user("m2", start))
    await writeFile(file, JSON.stringify(warn(start - 10 * 60_000)) + "\n")
    expect(await MemoryNote.text(user("m2", start))).toBe(first)
    await writeFile(file, [JSON.stringify(warn(Date.now())), JSON.stringify(kill(Date.now()))].join("\n") + "\n")
    expect(await MemoryNote.text(user("m2", start))).toContain("force-stopped these processes")
  })
})
