import { Env } from "./env"

// 프로젝트 .env 값이 도구 출력에 실려 모델로 돌아가는 걸 막는 마지막 관문. 앱 코드가 process.env 를 뱉는 라우트를
// 만들고 되읽는 우회나, 로그·스택트레이스에 키가 찍히는 사고를 막는다. 값을 변형해 내보내는 경우는 못 잡는다.

const TTL = 1000
let cache: { dir: string; stamp: number; values: string[] } | undefined

// 짧거나 사전 단어 같은 값까지 지우면 멀쩡한 출력이 망가지므로 토큰처럼 보이는 값만 고른다.
function secret(value: string) {
  if (value.length >= 16) return true
  return value.length >= 8 && /[^A-Za-z]/.test(value)
}

export async function values(dir: string) {
  if (cache && cache.dir === dir && Date.now() - cache.stamp < TTL) return cache.values
  const loaded = await Env.load(dir)
  const list = Object.values(loaded)
    .filter(secret)
    .sort((a, b) => b.length - a.length)
  cache = { dir, stamp: Date.now(), values: list }
  return list
}

export function reset() {
  cache = undefined
}

export function apply(text: string, list: string[]) {
  let out = text
  for (const value of list) if (out.includes(value)) out = out.replaceAll(value, "[redacted]")
  return out
}

export async function redact(text: string, dir: string | undefined) {
  if (!text || !dir) return text
  return apply(text, await values(dir))
}

export * as Secret from "./secret"
