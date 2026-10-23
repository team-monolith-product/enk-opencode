import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { isSecretFile } from "./env"

// 프로젝트 루트 .env 를 줄 단위로 다룬다. 주석·빈 줄·무관한 줄은 그대로 둔다. 값은 모델에게 가지 않고(가드가 막는다)
// 사람이 UI 에서 확인할 때만 value() 로 읽는다.

export const KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/
const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/
const ENTRY_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/
const META = ".opencode/env-meta.json"

export { isSecretFile }

export type Entry = { name: string; updated_at?: number; empty?: boolean }

export function mask(content: string) {
  return content
    .split("\n")
    .map((line) => {
      const match = LINE_RE.exec(line)
      return match ? `${match[1]}=••••••••` : line
    })
    .join("\n")
}

function serialize(value: string) {
  if (/^[A-Za-z0-9_@./:+-]*$/.test(value)) return value
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function deserialize(raw: string) {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
    return value.slice(1, -1).replace(/\\(.)/g, "$1")
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  return value
}

const read = (file: string) => readFile(file, "utf8").catch(() => undefined)

async function write(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content, { mode: 0o600 })
  await chmod(file, 0o600).catch(() => {})
}

export function parseNames(content: string) {
  const names: string[] = []
  for (const line of content.split("\n")) {
    const match = LINE_RE.exec(line)
    if (match && !names.includes(match[1])) names.push(match[1])
  }
  return names
}

export async function names(file: string) {
  const content = await read(file)
  return content === undefined ? [] : parseNames(content)
}

const metaFile = (file: string) => path.join(path.dirname(file), META)

async function loadMeta(file: string) {
  const raw = await read(metaFile(file))
  const parsed = raw === undefined ? undefined : (JSON.parse(raw) as unknown)
  if (!parsed || typeof parsed !== "object") return {} as Record<string, number>
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(parsed))
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value
  return out
}

async function touchMeta(file: string, touched: string[], keys: string[]) {
  const keep = new Set(keys)
  const stamp = await loadMeta(file).catch(() => ({}) as Record<string, number>)
  const now = Date.now()
  for (const key of touched) if (keep.has(key)) stamp[key] = now
  for (const key of Object.keys(stamp)) if (!keep.has(key)) delete stamp[key]
  await write(metaFile(file), JSON.stringify(stamp)).catch(() => {})
}

// 이름 + 등록·수정 시각(ms) + 값이 비었는지. 값 자체는 담지 않는다.
export async function entries(file: string): Promise<Entry[]> {
  const content = (await read(file)) ?? ""
  const keys = parseNames(content)
  const empty = new Set<string>()
  const seen = new Set<string>()
  for (const line of content.split("\n")) {
    const match = ENTRY_RE.exec(line)
    if (!match || seen.has(match[1])) continue
    seen.add(match[1])
    if (deserialize(match[2]) === "") empty.add(match[1])
  }
  const stamp = await loadMeta(file).catch(() => ({}) as Record<string, number>)
  const fallback = await stat(file).then(
    (info) => info.mtimeMs,
    () => undefined,
  )
  return keys.map((name) => ({
    name,
    updated_at: stamp[name] ?? fallback,
    ...(empty.has(name) ? { empty: true } : {}),
  }))
}

export async function value(file: string, name: string) {
  const content = await read(file)
  if (content === undefined) return undefined
  for (const line of content.split("\n")) {
    const match = ENTRY_RE.exec(line)
    if (match && match[1] === name) return deserialize(match[2])
  }
  return undefined
}

// 기존 키는 제자리에서 바꾸고 새 키는 끝에 붙인다. 저장 뒤 전체 키 이름을 돌려준다.
export async function set(file: string, values: Record<string, string>) {
  const content = (await read(file)) ?? ""
  const lines = content.length ? content.split("\n") : []
  const remaining = new Map(Object.entries(values))
  const next = lines.map((line) => {
    const match = LINE_RE.exec(line)
    if (!match) return line
    const replacement = remaining.get(match[1])
    if (replacement === undefined) return line
    remaining.delete(match[1])
    return `${match[1]}=${serialize(replacement)}`
  })
  while (next.length && next[next.length - 1] === "") next.pop()
  for (const [key, replacement] of remaining) next.push(`${key}=${serialize(replacement)}`)
  await write(file, next.join("\n") + "\n")
  const keys = parseNames(next.join("\n"))
  await touchMeta(file, Object.keys(values), keys)
  return keys
}

export async function remove(file: string, name: string) {
  const content = await read(file)
  if (content === undefined) return []
  const next = content.split("\n").filter((line) => LINE_RE.exec(line)?.[1] !== name)
  await write(file, next.join("\n"))
  const keys = parseNames(next.join("\n"))
  await touchMeta(file, [], keys)
  return keys
}

export async function payload(file: string) {
  const list = await entries(file)
  const updated_at: Record<string, number> = {}
  for (const entry of list) if (entry.updated_at !== undefined) updated_at[entry.name] = entry.updated_at
  return {
    keys: list.map((entry) => entry.name),
    updated_at,
    empty: list.filter((entry) => entry.empty).map((entry) => entry.name),
  }
}

export * as EnvFile from "./env-file"
