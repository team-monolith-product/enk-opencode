import { Database } from "bun:sqlite"
import { existsSync, renameSync, rmSync } from "node:fs"
import path from "node:path"

// V2 pod 는 V1 opencode.db 를 그대로 열지 않고 사본(OPENCODE_DB)을 만들어 연다. V2 는 여는 파일을 제자리에서 변환하므로
// 원본을 남겨 두면 이미지를 V1 으로 되돌렸을 때 V1 이 그 파일을 그대로 다시 쓴다.
// VACUUM INTO 는 WAL 까지 접은 일관된 사본을 만든다. 임시 파일에 쓰고 rename 해서 중간에 죽어도 반쪽 파일이 남지 않는다.
export function prepare(target: string, data: string, source = process.env.OPENCODE_DB_COPY_FROM) {
  if (!source || target === ":memory:" || existsSync(target)) return false
  const from = path.resolve(data, source)
  if (from === target || !existsSync(from)) return false
  const temp = `${target}.copying`
  rmSync(temp, { force: true })
  // readonly 연결은 -shm 을 새로 만들어야 하고(macOS 는 아예 실패한다), EXCLUSIVE 면 EFS 에 -shm 없이 읽는다.
  const db = new Database(from, { readwrite: true, create: false })
  try {
    if (process.env.OPENCODE_DB_EXCLUSIVE_LOCK) db.run("PRAGMA locking_mode = EXCLUSIVE")
    db.run("VACUUM INTO ?", [temp])
  } finally {
    db.close()
  }
  renameSync(temp, target)
  return true
}

export * as JitdaDatabase from "./jitda-database"
