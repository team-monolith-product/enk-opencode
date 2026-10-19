import { readFileSync, unlinkSync } from "node:fs"

// docker/entrypoint.sh 가 /proc/<pid>/environ 에 남지 않게 옮겨 둔 시크릿을 복원한다. 모듈 로드 시점에
// process.env 를 읽는 코드보다 먼저 돌아야 하므로 src/index.ts 의 첫 import 로 둔다.
export const VAR = "OPENCODE_BOOT_ENV"

export function parse(text: string) {
  const out: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const i = line.indexOf(" ")
    if (i <= 0) continue
    out[line.slice(0, i)] = Buffer.from(line.slice(i + 1), "base64").toString("utf8")
  }
  return out
}

export function load(file: string, env: NodeJS.ProcessEnv = process.env) {
  let text = ""
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return []
  }
  try {
    unlinkSync(file)
  } catch {}
  const values = parse(text)
  for (const [name, value] of Object.entries(values)) env[name] = value
  return Object.keys(values)
}

const file = process.env[VAR]
if (file) {
  load(file)
  delete process.env[VAR]
}

export * as BootEnv from "./boot-env"
