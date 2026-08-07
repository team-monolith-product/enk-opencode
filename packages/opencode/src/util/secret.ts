import { EnvFile } from "./env-file"

/**
 * 프로젝트 `.env` 값이 도구 출력에 실려 모델로 돌아가는 걸 막는다.
 *
 * ChildEnv 는 에이전트 셸에서 값을 지우지만, 앱(dev 서버)은 그 값으로 동작해야 하므로 값을 받는다.
 * 그런데 그 앱 코드를 쓰는 게 에이전트다 — `process.env` 를 뱉는 라우트를 만들고 `curl` 이나
 * webfetch 로 되읽으면 필터를 우회한다. 값을 아는 쪽은 우리이므로, 도구 출력에서 그 값을 지우는
 * 마지막 관문을 둔다. 앱 로그나 스택트레이스에 키가 찍혀 나오는 흔한 사고도 같이 막힌다.
 *
 * 한계: 값을 변형해서 내보내면(base64, 한 글자씩 쪼개기) 문자열 매칭으로는 못 잡는다. 이건 값을
 * 가진 프로세스와 그 출력을 읽는 주체가 같은 신뢰 경계에 있는 한 남는 구멍이고, 근본 해결은
 * 격리다. 여기서 막는 건 "실수로 새는 것"과 "한 번에 통째로 가져가는 것"이다.
 */
export namespace Secret {
  const TTL = 1000
  let cache: { dir: string; stamp: number; values: string[] } | undefined

  /**
   * 마스킹할 가치가 있는 값인지. 짧거나 사전 단어 같은 값(`postgres`, `development`, `3000`)까지
   * 지우면 멀쩡한 출력이 망가진다. 토큰처럼 보이는 것만 고른다.
   */
  function secret(value: string) {
    if (value.length >= 16) return true
    return value.length >= 8 && /[^A-Za-z]/.test(value)
  }

  export async function values(dir: string) {
    if (cache && cache.dir === dir && Date.now() - cache.stamp < TTL) return cache.values
    const loaded = await EnvFile.load(dir)
    const values = Object.entries(loaded)
      .filter(([, value]) => secret(value))
      // 긴 값을 먼저 지워야 짧은 값이 긴 값의 일부를 먼저 갉아먹지 않는다
      .sort((a, b) => b[1].length - a[1].length)
      .map(([, value]) => value)
    cache = { dir, stamp: Date.now(), values }
    return values
  }

  export function reset() {
    cache = undefined
  }

  export function apply(text: string, values: string[]) {
    let out = text
    for (const value of values) {
      if (!out.includes(value)) continue
      out = out.replaceAll(value, "[redacted]")
    }
    return out
  }

  /** 도구 출력에서 프로젝트 .env 값을 지운다. dir 이 없으면(인스턴스 밖) 그대로 둔다. */
  export async function redact(text: string, dir: string | undefined) {
    if (!text || !dir) return text
    return apply(text, await values(dir))
  }
}
