import { Database } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import path from "node:path"

// 협업 문서·투표·프롬프트 사이클 저장소(jitda.db).
// V1 은 opencode.db 안에 같은 테이블을 두고 V1 session 테이블에 FK 를 걸었다. V2 세션은 session_v2 에 생기므로
// 같은 파일에 두면 새 세션 행이 FK 에 걸린다. 그래서 파일을 분리하고, 첫 기동 때 V1 행을 한 번 가져온다.
// 테이블·컬럼 이름은 V1 그대로라 Rails 의 사이클 조회 쿼리는 파일 경로만 바꾸면 된다.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS doc (id TEXT PRIMARY KEY, kind TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS doc_update (id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES doc(id) ON DELETE CASCADE, data BLOB NOT NULL, time_created INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS doc_update_doc_idx ON doc_update (doc_id)`,
  `CREATE TABLE IF NOT EXISTS session_prompt_doc (session_id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES doc(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS session_actor (session_id TEXT NOT NULL, actor_id TEXT NOT NULL, user_id TEXT, name TEXT NOT NULL, color TEXT NOT NULL, time_created INTEGER NOT NULL, time_seen INTEGER NOT NULL, PRIMARY KEY (session_id, actor_id))`,
  `CREATE INDEX IF NOT EXISTS session_actor_session_idx ON session_actor (session_id)`,
  `CREATE TABLE IF NOT EXISTS doc_asset (id TEXT NOT NULL, doc_id TEXT NOT NULL REFERENCES doc(id) ON DELETE CASCADE, mime TEXT NOT NULL, data BLOB NOT NULL, size INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, PRIMARY KEY (doc_id, id))`,
  `CREATE INDEX IF NOT EXISTS doc_asset_doc_idx ON doc_asset (doc_id)`,
  `CREATE TABLE IF NOT EXISTS doc_submit (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, target_kind TEXT NOT NULL DEFAULT 'doc', target_id TEXT NOT NULL, doc_id TEXT REFERENCES doc(id) ON DELETE CASCADE, actor_id TEXT NOT NULL, status TEXT NOT NULL, prompt TEXT NOT NULL, timeout_ms INTEGER NOT NULL, expires_at INTEGER NOT NULL, cancelled_by TEXT, user_message_id TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS doc_submit_session_target_status_idx ON doc_submit (session_id, target_id, status)`,
  `CREATE INDEX IF NOT EXISTS doc_submit_expires_idx ON doc_submit (expires_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS doc_submit_pending_unique ON doc_submit (session_id, target_kind, target_id) WHERE status = 'pending'`,
  `CREATE TABLE IF NOT EXISTS doc_submit_actor (submit_id TEXT NOT NULL REFERENCES doc_submit(id) ON DELETE CASCADE, actor_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, time_responded INTEGER, PRIMARY KEY (submit_id, actor_id))`,
  `CREATE INDEX IF NOT EXISTS doc_submit_actor_actor_idx ON doc_submit_actor (actor_id)`,
  `CREATE TABLE IF NOT EXISTS prompt_cycle (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_message_id TEXT NOT NULL, path TEXT, time_created INTEGER NOT NULL, assistant_message_id TEXT NOT NULL, response TEXT, model_id TEXT, provider_id TEXT, time_output_start INTEGER, time_completed INTEGER, ttft_ms INTEGER, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost_total REAL, status TEXT NOT NULL DEFAULT 'running', aborted INTEGER NOT NULL DEFAULT 0, error TEXT)`,
  `CREATE INDEX IF NOT EXISTS prompt_cycle_session_idx ON prompt_cycle (session_id)`,
  `CREATE INDEX IF NOT EXISTS prompt_cycle_status_idx ON prompt_cycle (status)`,
  `CREATE INDEX IF NOT EXISTS prompt_cycle_created_idx ON prompt_cycle (time_created)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS prompt_cycle_user_message_unique ON prompt_cycle (user_message_id)`,
  `CREATE TABLE IF NOT EXISTS prompt_cycle_input (id TEXT NOT NULL, cycle_id TEXT NOT NULL REFERENCES prompt_cycle(id) ON DELETE CASCADE, session_id TEXT NOT NULL, doc_id TEXT, submit_id TEXT, actor_ids TEXT, initiator_actor_id TEXT, seq INTEGER NOT NULL DEFAULT 0, prompt TEXT NOT NULL, assets TEXT, actor_count INTEGER NOT NULL DEFAULT 1, user_message_id TEXT, time_created INTEGER NOT NULL, time_consented INTEGER, consent_ms INTEGER, PRIMARY KEY (cycle_id, id))`,
  `CREATE INDEX IF NOT EXISTS prompt_cycle_input_cycle_idx ON prompt_cycle_input (cycle_id)`,
  `CREATE INDEX IF NOT EXISTS prompt_cycle_input_session_idx ON prompt_cycle_input (session_id)`,
  `CREATE TABLE IF NOT EXISTS jitda_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
]

// 부모가 먼저 들어가야 FK 가 맞는다.
const TABLES = [
  "doc",
  "doc_update",
  "session_prompt_doc",
  "session_actor",
  "doc_asset",
  "doc_submit",
  "doc_submit_actor",
  "prompt_cycle",
  "prompt_cycle_input",
]

let current: Database | undefined

export function open(file: string, legacy?: string) {
  current?.close()
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file, { create: true })
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA busy_timeout = 5000")
  db.run("PRAGMA foreign_keys = ON")
  for (const statement of SCHEMA) db.run(statement)
  current = db
  if (legacy) importLegacy(db, legacy)
  return db
}

export function db() {
  if (!current) throw new Error("jitda doc store is not open")
  return current
}

export function ready() {
  return current !== undefined
}

export function close() {
  current?.close()
  current = undefined
}

function columns(db: Database, schema: string, table: string) {
  return db
    .query<{ name: string }, []>(`SELECT name FROM ${schema}.pragma_table_info('${table}')`)
    .all()
    .map((row) => row.name)
}

export function importLegacy(db: Database, legacy: string) {
  if (db.query("SELECT value FROM jitda_meta WHERE key = 'legacy_import'").get()) return 0
  let copied = 0
  if (legacy !== ":memory:" && existsSync(legacy)) {
    db.run("ATTACH DATABASE ? AS legacy", [legacy])
    try {
      const present = new Set(
        db
          .query<{ name: string }, []>("SELECT name FROM legacy.sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => row.name),
      )
      db.transaction(() => {
        for (const table of TABLES) {
          if (!present.has(table)) continue
          const source = new Set(columns(db, "legacy", table))
          const shared = columns(db, "main", table).filter((name) => source.has(name))
          if (shared.length === 0) continue
          const list = shared.map((name) => `"${name}"`).join(", ")
          db.run(`INSERT OR IGNORE INTO main.${table} (${list}) SELECT ${list} FROM legacy.${table}`)
          copied += db.query<{ value: number }, []>("SELECT changes() AS value").get()?.value ?? 0
        }
      })()
    } finally {
      db.run("DETACH DATABASE legacy")
    }
  }
  db.run("INSERT OR REPLACE INTO jitda_meta (key, value) VALUES ('legacy_import', ?)", [String(Date.now())])
  return copied
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
let lastTimestamp = 0
let counter = 0

// V1 Identifier.ascending 과 같은 모양(<prefix>_<12 hex 시간+카운터><14 base62>)이라 가져온 V1 ID 와 같은 순서로 정렬된다.
export function ascending(prefix: string) {
  const now = Date.now()
  if (now !== lastTimestamp) {
    lastTimestamp = now
    counter = 0
  }
  counter++
  const value = BigInt(now) * BigInt(0x1000) + BigInt(counter)
  const time = value.toString(16).padStart(12, "0").slice(-12)
  const bytes = randomBytes(14)
  let random = ""
  for (const byte of bytes) random += BASE62[byte % 62]
  return `${prefix}_${time}${random}`
}

export function valid(prefix: string, value: unknown): value is string {
  return typeof value === "string" && value.startsWith(prefix)
}

export * as Store from "./store"
