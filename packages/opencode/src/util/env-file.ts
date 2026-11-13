import { chmod, readdir, stat } from "fs/promises"
import { readdirSync, readFileSync } from "fs"
import path from "path"
import { Filesystem } from "@/util/filesystem"

// 프로젝트 루트 .env 를 라인 단위로 다루는 유틸. 주석/빈 줄/무관 라인은 그대로 보존한다.
// 값은 LLM 에게는 절대 가지 않는다(Permission.ENV_FILE_GUARD 가 도구 계층에서 .env 접근을 deny).
// 사람이 opencode UI 에서 확인하는 경로만 value() 로 원문을 읽는다.
export namespace EnvFile {
  export const KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/
  const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/
  const ENTRY_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/
  // .env / .env.local 등은 시크릿. .env.example 은 예시라 제외.
  const SECRET_NAME_RE = /^\.env(\..+)?$/
  const META = ".opencode/env-meta.json"

  /** empty 는 "이름은 있는데 값이 비어 있음" — UI 가 「값 필요」줄로 구분해 보여준다. */
  export type Entry = { name: string; updated_at?: number; empty?: boolean }

  // 파일명(basename)이 시크릿 env 파일인지. UI 파일트리/검색/뷰어에서 값 노출을 막는 판정에 쓴다.
  export function isSecretFile(name: string): boolean {
    const base = name.replaceAll("\\", "/").split("/").pop() ?? name
    return SECRET_NAME_RE.test(base) && base !== ".env.example"
  }

  // 키 이름은 유지하고 값만 마스킹한다(주석/빈 줄/무관 라인 보존). 뷰어에서 열려도 값이 새지 않게.
  export function mask(content: string): string {
    return content
      .split("\n")
      .map((line) => {
        const match = LINE_RE.exec(line)
        if (!match) return line
        return `${match[1]}=••••••••`
      })
      .join("\n")
  }

  /** 이름 -> 값. 중복 키는 value() 와 같게 첫 줄을 따른다. */
  export function parseValues(content: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const line of content.split("\n")) {
      const match = ENTRY_RE.exec(line)
      if (match && !(match[1] in out)) out[match[1]] = deserialize(match[2])
    }
    return out
  }

  /** 디렉토리 안의 시크릿 env 파일 경로. `.env` 를 먼저 두고 나머지는 이름순. */
  export async function files(dir: string): Promise<string[]> {
    const entries = await readdir(dir).catch(() => [] as string[])
    return entries
      .filter(isSecretFile)
      .sort((a, b) => (a === ".env" ? -1 : b === ".env" ? 1 : a.localeCompare(b)))
      .map((entry) => path.join(dir, entry))
  }

  /**
   * 디렉토리의 시크릿 env 파일을 모두 읽어 합친 이름 -> 값. 뒤에 오는 파일이 앞을 덮는다
   * (`.env` 를 `.env.local` 이 덮는 통상 규칙).
   */
  export async function load(dir: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const file of await files(dir)) {
      const content = await read(file)
      if (content === undefined) continue
      Object.assign(out, parseValues(content))
    }
    return out
  }

  /**
   * 디렉토리의 시크릿 env 파일에 정의된 키 이름 전부. 값은 읽지 않는다.
   * 동기인 이유는 ChildEnv.maskForAgent 하나뿐이다 — LSP 런처의 spawn 이 동기라 await 을 못 건다.
   */
  export function keysSync(dir: string): string[] {
    const out: string[] = []
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return out
    }
    for (const entry of entries.filter(isSecretFile)) {
      let content: string
      try {
        content = readFileSync(path.join(dir, entry), "utf8")
      } catch {
        continue
      }
      for (const name of parseNames(content)) if (!out.includes(name)) out.push(name)
    }
    return out
  }

  export function parseNames(content: string): string[] {
    const names: string[] = []
    for (const line of content.split("\n")) {
      const match = LINE_RE.exec(line)
      if (match && !names.includes(match[1])) names.push(match[1])
    }
    return names
  }

  export async function names(file: string): Promise<string[]> {
    const content = await read(file)
    if (content === undefined) return []
    return parseNames(content)
  }

  /** 키 이름 + 등록/수정 시각(ms) + 값이 비었는지. 값 자체는 담지 않는다. */
  export async function entries(file: string): Promise<Entry[]> {
    const content = (await read(file)) ?? ""
    const keys = parseNames(content)
    // 중복 키는 value() 와 같게 첫 줄을 따른다.
    const empty = new Set<string>()
    const seen = new Set<string>()
    for (const line of content.split("\n")) {
      const match = ENTRY_RE.exec(line)
      if (!match || seen.has(match[1])) continue
      seen.add(match[1])
      if (deserialize(match[2]) === "") empty.add(match[1])
    }
    const stamp = await loadMeta(file)
    const fallback = await fileMtime(file)
    return keys.map((name) => ({
      name,
      updated_at: stamp[name] ?? fallback,
      ...(empty.has(name) ? { empty: true } : {}),
    }))
  }

  /**
   * 저장된 값 원문. 사람이 opencode UI 에서 확인할 때만 쓴다.
   * 중복 키가 있으면 set() 이 교체하는 줄과 같은 첫 줄을 따른다.
   */
  export async function value(file: string, name: string): Promise<string | undefined> {
    const content = await read(file)
    if (content === undefined) return undefined
    for (const line of content.split("\n")) {
      const match = ENTRY_RE.exec(line)
      if (match && match[1] === name) return deserialize(match[2])
    }
    return undefined
  }

  // 저장 후 전체 키 이름 목록을 반환한다. 기존 키는 제자리에서 교체, 새 키는 끝에 추가.
  export async function set(file: string, values: Record<string, string>): Promise<string[]> {
    const content = (await read(file)) ?? ""
    const lines = content.length ? content.split("\n") : []
    const remaining = new Map(Object.entries(values))
    const next = lines.map((line) => {
      const match = LINE_RE.exec(line)
      if (!match) return line
      const value = remaining.get(match[1])
      if (value === undefined) return line
      remaining.delete(match[1])
      return `${match[1]}=${serialize(value)}`
    })
    while (next.length && next[next.length - 1] === "") next.pop()
    for (const [key, value] of remaining) next.push(`${key}=${serialize(value)}`)
    await write(file, next.join("\n") + "\n")
    const keys = parseNames(next.join("\n"))
    await touchMeta(file, Object.keys(values), keys)
    return keys
  }

  export async function remove(file: string, name: string): Promise<string[]> {
    const content = await read(file)
    if (content === undefined) return []
    const next = content.split("\n").filter((line) => {
      const match = LINE_RE.exec(line)
      return !match || match[1] !== name
    })
    await write(file, next.join("\n"))
    const keys = parseNames(next.join("\n"))
    await touchMeta(file, [], keys)
    return keys
  }

  function serialize(value: string): string {
    if (/^[A-Za-z0-9_@./:+-]*$/.test(value)) return value
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  }

  // serialize 의 역함수. 이스케이프는 한 번에 훑어 되돌린다 — \\ 와 \" 를 순차 치환하면
  // `a\"b` 처럼 둘이 붙은 값이 깨진다. 손으로 쓴 홑따옴표 표기도 받아준다.
  function deserialize(raw: string): string {
    const value = raw.trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      return value.slice(1, -1).replace(/\\(.)/g, "$1")
    }
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      return value.slice(1, -1)
    }
    return value
  }

  async function read(file: string): Promise<string | undefined> {
    return Filesystem.readText(file).catch(() => undefined)
  }

  async function write(file: string, content: string): Promise<void> {
    await Filesystem.write(file, content, 0o600)
    // writeFile 의 mode 는 파일 생성 시에만 적용되므로 기존 파일도 항상 0600 으로 맞춘다
    await chmod(file, 0o600).catch(() => {})
  }

  function metaFile(file: string) {
    return path.join(path.dirname(file), META)
  }

  async function loadMeta(file: string): Promise<Record<string, number>> {
    const raw = await Filesystem.readJson<Record<string, number>>(metaFile(file)).catch(() => undefined)
    if (!raw || typeof raw !== "object") return {}
    const out: Record<string, number> = {}
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "number" && Number.isFinite(value)) out[key] = value
    }
    return out
  }

  async function touchMeta(file: string, touched: string[], keys: string[]) {
    const keep = new Set(keys)
    const stamp = await loadMeta(file)
    const now = Date.now()
    for (const key of touched) {
      if (keep.has(key)) stamp[key] = now
    }
    for (const key of Object.keys(stamp)) {
      if (!keep.has(key)) delete stamp[key]
    }
    await Filesystem.writeJson(metaFile(file), stamp, 0o600).catch(() => {})
  }

  async function fileMtime(file: string): Promise<number | undefined> {
    const info = await stat(file).catch(() => undefined)
    return info?.mtimeMs
  }
}
