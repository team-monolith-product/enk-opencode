#!/usr/bin/env bun
/**
 * Runs the test suite one directory group at a time, each in its own `bun test` process.
 *
 * `bun test` puts every file of a package in a single process, and this suite does not survive that:
 * run whole, a test somewhere in test/agent/ blows past the 30s timeout on CI — a different one each
 * run, never the same twice, and never when that directory runs on its own (37 tests, 2.3s). Split by
 * directory, all 41 groups pass, and the wall clock is unchanged (~350s either way) because the work
 * is the same; only the process boundaries moved.
 *
 * So this is isolation, not a diagnosis. Whatever the accumulation is, it does not cross a process
 * boundary, and grouping keeps one bad interaction from taking the suite down with it. The per-group
 * wall-clock guard is here for the same reason: a hung group gets killed and reported instead of
 * sitting there until the CI runner gives up (which it did once, after 48 minutes).
 *
 * Extra args are forwarded to every group, so `bun run test -t "some name"` still works.
 */
import { Glob } from "bun"
import path from "path"

const root = path.resolve(import.meta.dirname, "..")
// Seconds. Killed in-process rather than via the `timeout` binary, which macOS does not ship.
const TIMEOUT = Number(process.env.OPENCODE_TEST_GROUP_TIMEOUT ?? 600)
const args = process.argv.slice(2)

const groups = new Map<string, string[]>()
for await (const file of new Glob("{src,test}/**/*.test.ts").scan(root)) {
  const [top, next] = file.split(path.sep)
  // Files sitting directly in test/ have no second segment; keep them together as one group.
  const key = file.split(path.sep).length > 2 ? `${top}/${next}` : `${top}/(root)`
  groups.set(key, [...(groups.get(key) ?? []), file])
}

const names = [...groups.keys()].sort()
const files = names.reduce((sum, name) => sum + groups.get(name)!.length, 0)
console.log(`running ${files} test files in ${names.length} groups`)

const failed: string[] = []
const started = Date.now()

for (const name of names) {
  const proc = Bun.spawn(["bun", "test", "--timeout", "30000", ...args, ...groups.get(name)!], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  })
  let hung = false
  const timer = setTimeout(() => {
    hung = true
    proc.kill("SIGKILL")
  }, TIMEOUT * 1000)
  const code = await proc.exited
  clearTimeout(timer)
  if (hung) {
    console.log(`\n::error::group ${name} hung and was killed after ${TIMEOUT}s\n`)
    failed.push(name)
    continue
  }
  if (code !== 0) failed.push(name)
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1)
if (failed.length) {
  console.log(`\n${failed.length}/${names.length} groups failed in ${elapsed}s:`)
  for (const name of failed) console.log(`  ${name}`)
  process.exit(1)
}
console.log(`\nall ${names.length} groups passed in ${elapsed}s`)
