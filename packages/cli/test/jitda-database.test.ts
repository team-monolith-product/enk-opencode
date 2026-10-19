import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { JitdaDatabase } from "../src/services/jitda-database"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jitda-db-"))
  dirs.push(dir)
  return dir
}

test("copies the V1 database including uncheckpointed WAL pages and leaves the source intact", () => {
  const data = tmp()
  const source = path.join(data, "opencode.db")
  const writer = new Database(source, { create: true })
  writer.run("PRAGMA journal_mode = WAL")
  writer.run("PRAGMA wal_autocheckpoint = 0")
  writer.run("CREATE TABLE session (id TEXT PRIMARY KEY)")
  writer.run("INSERT INTO session VALUES ('ses_1'), ('ses_2')")
  const target = path.join(data, "opencode-v2.db")

  expect(JitdaDatabase.prepare(target, data, "opencode.db")).toBe(true)
  writer.close()

  const copy = new Database(target, { readonly: true })
  expect(copy.query("SELECT id FROM session ORDER BY id").all()).toEqual([{ id: "ses_1" }, { id: "ses_2" }])
  copy.close()
  expect(existsSync(`${target}.copying`)).toBe(false)
  expect(new Database(source).query("SELECT COUNT(*) AS n FROM session").get()).toEqual({ n: 2 })
})

test("does nothing when the target exists, the source is missing, or no source is configured", () => {
  const data = tmp()
  const target = path.join(data, "opencode-v2.db")
  expect(JitdaDatabase.prepare(target, data, "opencode.db")).toBe(false)
  expect(existsSync(target)).toBe(false)
  expect(JitdaDatabase.prepare(target, data, undefined)).toBe(false)

  new Database(path.join(data, "opencode.db"), { create: true }).run("CREATE TABLE a (x)")
  new Database(target, { create: true }).run("CREATE TABLE b (y)")
  expect(JitdaDatabase.prepare(target, data, "opencode.db")).toBe(false)
  expect(new Database(target).query("SELECT name FROM sqlite_master").all()).toEqual([{ name: "b" }])
  expect(JitdaDatabase.prepare(":memory:", data, "opencode.db")).toBe(false)
})
