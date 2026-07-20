import { chmod } from "fs/promises"
import { Filesystem } from "@/util/filesystem"

// 프로젝트 루트 .env 를 라인 단위로 다루는 유틸. 주석/빈 줄/무관 라인은 그대로 보존한다.
// 값은 절대 외부(HTTP/LLM)로 반환하지 않는 쓰기 전용 저장소로 쓰인다 — 이름만 노출.
export namespace EnvFile {
  export const KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/
  const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/
  // .env / .env.local 등은 시크릿. .env.example 은 예시라 제외.
  const SECRET_NAME_RE = /^\.env(\..+)?$/

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
    return parseNames(next.join("\n"))
  }

  export async function remove(file: string, name: string): Promise<string[]> {
    const content = await read(file)
    if (content === undefined) return []
    const next = content.split("\n").filter((line) => {
      const match = LINE_RE.exec(line)
      return !match || match[1] !== name
    })
    await write(file, next.join("\n"))
    return parseNames(next.join("\n"))
  }

  function serialize(value: string): string {
    if (/^[A-Za-z0-9_@./:+-]*$/.test(value)) return value
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  }

  async function read(file: string): Promise<string | undefined> {
    return Filesystem.readText(file).catch(() => undefined)
  }

  async function write(file: string, content: string): Promise<void> {
    await Filesystem.write(file, content, 0o600)
    // writeFile 의 mode 는 파일 생성 시에만 적용되므로 기존 파일도 항상 0600 으로 맞춘다
    await chmod(file, 0o600).catch(() => {})
  }
}
