import fs from "node:fs"
import { open, rm } from "node:fs/promises"
import path from "node:path"

// 업로드 폴더(__assets__). 사용자가 올린 파일을 그대로 두고 프롬프트에는 싣지 않는다(첨부는 매 스텝 입력으로 과금된다).
// 클라이언트가 준 경로는 적대적이라고 보고, resolve 가 폴더 안으로 가두는 것이 경계다.

export const DIR = "__assets__"
export const MAX_FILE_BYTES = 100 * 1024 * 1024
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
export const MAX_FILE_COUNT = 1000
export const MAX_DEPTH = 8
const MAX_SEGMENT_LENGTH = 100
const MAX_EXTENSION_LENGTH = 16
const USAGE_TTL_MS = 2_000
const ILLEGAL = /[\x00-\x1f\x7f/\\:*?"<>|]/g
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

export type Entry = { path: string; size: number; modified: number }
export type Usage = { count: number; bytes: number }

export class UploadError extends Error {
  readonly status = 400
}

export function root(dir: string) {
  return path.join(dir, DIR)
}

const contains = (parent: string, child: string) => {
  const relative = path.relative(parent, child)
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

export function segment(input: string) {
  let out = input.normalize("NFC").replace(ILLEGAL, "_")
  out = out.replace(/^\.+/, "")
  out = out.replace(/[. ]+$/, "").trim()
  if (!out) return undefined
  if (RESERVED.test(out)) out = "_" + out
  if (out.length <= MAX_SEGMENT_LENGTH) return out
  const ext = path.extname(out).slice(0, MAX_EXTENSION_LENGTH)
  const stem = out.slice(0, out.length - path.extname(out).length)
  return stem.slice(0, Math.max(1, MAX_SEGMENT_LENGTH - ext.length)) + ext
}

export function relative(input: string) {
  const parts: string[] = []
  for (const raw of input.split(/[/\\]/)) {
    if (raw === "" || raw === ".") continue
    if (raw === "..") return undefined
    const part = segment(raw)
    if (!part) return undefined
    parts.push(part)
  }
  if (parts.length === 0 || parts.length > MAX_DEPTH) return undefined
  return parts.join("/")
}

export function resolve(dir: string, input: string) {
  const rel = relative(input)
  if (!rel) return undefined
  const base = root(dir)
  const target = path.resolve(base, rel)
  return contains(base, target) ? target : undefined
}

export function list(dir: string): Entry[] {
  const base = root(dir)
  const out: Entry[] = []
  const walk = (current: string, depth: number) => {
    if (depth > MAX_DEPTH) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(absolute, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const stat = fs.statSync(absolute, { throwIfNoEntry: false })
      if (!stat) continue
      out.push({
        path: path.relative(base, absolute).split(path.sep).join("/"),
        size: Number(stat.size),
        modified: stat.mtime.getTime(),
      })
    }
  }
  walk(base, 0)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

const total = (entries: Entry[]): Usage =>
  entries.reduce<Usage>((acc, entry) => ({ count: acc.count + 1, bytes: acc.bytes + entry.size }), {
    count: 0,
    bytes: 0,
  })

type Ledger = { walked?: Usage; at: number; pending: Usage }
const ledgers = new Map<string, Ledger>()
const ledger = (dir: string) => {
  const existing = ledgers.get(dir)
  if (existing) return existing
  const created: Ledger = { at: 0, pending: { count: 0, bytes: 0 } }
  ledgers.set(dir, created)
  return created
}

export function snapshot(dir: string) {
  const files = list(dir)
  const walked = total(files)
  const state = ledger(dir)
  state.walked = { ...walked }
  state.at = Date.now()
  return { files, usage: walked, limits: { file: MAX_FILE_BYTES, total: MAX_TOTAL_BYTES, count: MAX_FILE_COUNT } }
}

function projected(dir: string) {
  const state = ledger(dir)
  if (!state.walked || Date.now() - state.at > USAGE_TTL_MS) {
    state.walked = total(list(dir))
    state.at = Date.now()
  }
  return { count: state.walked.count + state.pending.count, bytes: state.walked.bytes + state.pending.bytes }
}

// 쓰기 전에 자리를 잡는다. 클라이언트가 동시에 여러 개 올리므로 읽기만 하는 검사로는 한도가 지켜지지 않는다.
export function claim(dir: string, bytes: number): { bytes: number } | "count" | "total" {
  const state = ledger(dir)
  const now = projected(dir)
  if (now.count + 1 > MAX_FILE_COUNT) return "count"
  if (now.bytes + bytes > MAX_TOTAL_BYTES) return "total"
  state.pending.count += 1
  state.pending.bytes += bytes
  return { bytes }
}

function settle(dir: string, held: { bytes: number }, written?: number) {
  const state = ledger(dir)
  state.pending.count -= 1
  state.pending.bytes -= held.bytes
  if (written === undefined || !state.walked) return
  state.walked.count += 1
  state.walked.bytes += written
}

export function invalidate(dir: string) {
  const state = ledger(dir)
  state.walked = undefined
  state.at = 0
}

export function unique(target: string) {
  if (!fs.existsSync(target)) return target
  const dir = path.dirname(target)
  const ext = path.extname(target)
  const stem = path.basename(target, ext)
  for (let i = 2; i < 1000; i++) {
    const candidate = path.join(dir, `${stem} (${i})${ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }
  return path.join(dir, `${stem} (${Date.now()})${ext}`)
}

// 경로 문자열이 아니라 실제 디렉터리가 폴더 안인지 확인한다. 이미 있던 심볼릭 링크로 쓰기가 빠져나가지 않게.
function prepare(dir: string, target: string) {
  const base = root(dir)
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const real = fs.realpathSync(path.dirname(target))
    const realBase = fs.realpathSync(base)
    return real === realBase || contains(realBase, real)
  } catch {
    return false
  }
}

export function gitCommonDir(worktree: string) {
  const dot = path.join(worktree, ".git")
  const stat = fs.statSync(dot, { throwIfNoEntry: false })
  if (!stat) return undefined
  if (stat.isDirectory()) return dot
  try {
    const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dot, "utf8"))
    if (!pointer?.[1]) return undefined
    const gitdir = path.resolve(worktree, pointer[1].trim())
    const commondir = path.join(gitdir, "commondir")
    if (!fs.existsSync(commondir)) return gitdir
    return path.resolve(gitdir, fs.readFileSync(commondir, "utf8").trim())
  } catch {
    return undefined
  }
}

// 프로젝트 .gitignore 가 아니라 info/exclude 에 넣는다. 업로드가 git status 나 PR diff 에 보이지 않게 하되 추적 파일은
// 건드리지 않는다. 앞 슬래시가 없어 어느 깊이의 업로드 폴더에도 걸린다.
export function exclude(dir: string) {
  const gitdir = gitCommonDir(dir)
  if (!gitdir) return
  const file = path.join(gitdir, "info", "exclude")
  const line = DIR + "/"
  try {
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
    if (existing.split(/\r?\n/).some((entry) => entry.trim() === line)) return
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, (existing && !existing.endsWith("\n") ? "\n" : "") + line + "\n")
  } catch {}
}

export async function upload(dir: string, input: string, declared: number, body: AsyncIterable<Uint8Array>) {
  const target = resolve(dir, input)
  if (!target) throw new UploadError("Invalid upload path")
  if (declared > MAX_FILE_BYTES) throw new UploadError("File is too large")
  const held = claim(dir, declared)
  if (held === "count") throw new UploadError(`Upload folder holds at most ${MAX_FILE_COUNT} files`)
  if (held === "total") throw new UploadError("Upload folder is full")
  let stored: number | undefined
  try {
    if (!prepare(dir, target)) throw new UploadError("Invalid upload path")
    exclude(dir)
    let destination = unique(target)
    let handle = await open(destination, "wx", 0o644).catch(() => undefined)
    for (let attempt = 0; !handle && attempt < 5; attempt++) {
      destination = unique(target)
      handle = await open(destination, "wx", 0o644).catch(() => undefined)
    }
    if (!handle) throw new UploadError("Could not create file")
    let written = 0
    try {
      for await (const chunk of body) {
        written += chunk.byteLength
        if (written > MAX_FILE_BYTES) throw new UploadError("File is too large")
        const state = ledger(dir)
        if ((state.walked?.bytes ?? 0) + state.pending.bytes - held.bytes + written > MAX_TOTAL_BYTES)
          throw new UploadError("Upload folder is full")
        await handle.write(chunk)
      }
    } catch (error) {
      await handle.close().catch(() => {})
      await rm(destination, { force: true }).catch(() => {})
      throw error
    }
    await handle.close()
    stored = written
    return {
      path: path.relative(root(dir), destination).split(path.sep).join("/"),
      size: written,
      modified: Date.now(),
    }
  } finally {
    settle(dir, held, stored)
  }
}

export async function remove(dir: string, input?: string) {
  if (!input) {
    await rm(root(dir), { recursive: true, force: true })
    invalidate(dir)
    return true
  }
  const target = resolve(dir, input)
  if (!target) throw new UploadError("Invalid path")
  await rm(target, { recursive: true, force: true })
  invalidate(dir)
  return true
}

const UPLOAD_LIST_LIMIT = 100

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
}

// 시스템 프롬프트에 붙이는 업로드 안내. 올린 게 없으면 빈 문자열이라 기능을 안 쓰는 프로젝트는 비용이 없다.
export function prompt(dir: string) {
  const files = list(dir)
  if (files.length === 0) return ""
  const shown = files.slice(0, UPLOAD_LIST_LIMIT)
  return [
    `<uploads>`,
    `  The user uploaded these files directly. They were stored as-is and you have not seen their contents.`,
    `  Directory: ${root(dir)}`,
    `  This directory is excluded from git, so glob/grep skip it unless you pass this path explicitly.`,
    `  Reading them in place is fine. Two rules apply:`,
    `  1. These are the user's originals and nothing backs them up: do not modify, delete or rename them.`,
    `  2. Nothing that ships may point here. Because the directory is not committed, code that reads a`,
    `     path under it works in preview and breaks the moment the project is committed or deployed.`,
    `     If the project needs one of these files at runtime, move it into the project's normal location`,
    `     for that kind of file (public/, assets/, fixtures/, ...) and reference it there instead.`,
    ...shown.map((file) => `  ${file.path} (${size(file.size)})`),
    ...(files.length > shown.length ? [`  [${files.length - shown.length} more]`] : []),
    `</uploads>`,
  ].join("\n")
}

export * as Assets from "./assets"
