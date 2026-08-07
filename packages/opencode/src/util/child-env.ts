import path from "path"
import { readdir } from "fs/promises"
import { EnvFile } from "./env-file"

/**
 * 자식 프로세스에 넘길 환경 변수를 allowlist 로 걸러낸다.
 *
 * opencode 프로세스의 환경에는 배포가 주입한 운영 시크릿(JUPYTERHUB_API_TOKEN, ENK_AI_USAGE_TOKEN,
 * OPENCODE_SERVER_PASSWORD ...)과 opencode 가 런타임에 써넣는 토큰(OPENCODE_CONSOLE_TOKEN,
 * AWS_BEARER_TOKEN_BEDROCK, wellknown auth 토큰)이 들어 있다. 이걸 그대로 상속시키면 에이전트가
 * bash 로 `env` 한 줄만 실행해도 전부 읽힌다.
 *
 * 그래서 "지울 것을 고르는" blocklist 가 아니라 "통과시킬 것만 고르는" allowlist 다. 새 시크릿이
 * 추가돼도 기본값이 차단이라 목록을 갱신하는 걸 잊어도 새지 않는다. 대신 툴체인이 실제로 필요로 하는
 * 변수는 넉넉히 열어 둔다 — 여기서 막히면 학생 환경의 빌드가 조용히 깨진다.
 *
 * 한계: 이 필터는 자식 프로세스의 환경만 바꾼다. 리눅스의 `/proc/<pid>/environ` 은 exec 시점 값이라
 * 여기서 지워도 남는다. 그 경로는 Permission.ENV_FILE_GUARD 가 별도로 막고, 근본 차단은 컨테이너
 * entrypoint 에서 environ 자체를 비우는 몫이다.
 */
export namespace ChildEnv {
  /** 이름이 정확히 일치할 때 통과. 비교는 대문자로 정규화한다(윈도우 대소문자 무시). */
  const ALLOW_NAMES = new Set(
    [
      // POSIX 기본
      "PATH",
      "HOME",
      "USER",
      "USERNAME",
      "LOGNAME",
      "SHELL",
      "PWD",
      "OLDPWD",
      "TMPDIR",
      "TMP",
      "TEMP",
      "TERM",
      "TERM_PROGRAM",
      "COLORTERM",
      "TZ",
      "LANG",
      "LANGUAGE",
      "HOSTNAME",
      "DISPLAY",
      "EDITOR",
      "VISUAL",
      "PAGER",
      "CI",
      // 윈도우 기본
      "SYSTEMROOT",
      "SYSTEMDRIVE",
      "WINDIR",
      "COMSPEC",
      "PATHEXT",
      "PROGRAMFILES",
      "PROGRAMFILES(X86)",
      "PROGRAMW6432",
      "PROGRAMDATA",
      "APPDATA",
      "LOCALAPPDATA",
      "USERPROFILE",
      "HOMEDRIVE",
      "HOMEPATH",
      "COMPUTERNAME",
      "NUMBER_OF_PROCESSORS",
      "PROCESSOR_ARCHITECTURE",
      "PROCESSOR_IDENTIFIER",
      "OS",
      // 프록시
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "FTP_PROXY",
      "NO_PROXY",
      // 런타임 / 툴체인 루트
      "NODE_ENV",
      "NODE_PATH",
      "NODE_OPTIONS",
      "NODE_VERSION",
      "NVM_DIR",
      "NVM_BIN",
      "NVM_INC",
      "BUN_INSTALL",
      "DENO_DIR",
      "DENO_INSTALL",
      "PNPM_HOME",
      "COREPACK_HOME",
      "YARN_VERSION",
      "YARN_CACHE_FOLDER",
      "VOLTA_HOME",
      "JAVA_HOME",
      "MAVEN_HOME",
      "M2_HOME",
      "GRADLE_USER_HOME",
      "SDKMAN_DIR",
      "GOPATH",
      "GOROOT",
      "GOBIN",
      "GOMODCACHE",
      "GOCACHE",
      "CARGO_HOME",
      "RUSTUP_HOME",
      "PYENV_ROOT",
      "PYTHONPATH",
      "PYTHONHOME",
      "PYTHONUNBUFFERED",
      "VIRTUAL_ENV",
      "CONDA_PREFIX",
      "CONDA_DEFAULT_ENV",
      "UV_CACHE_DIR",
      "RBENV_ROOT",
      "GEM_HOME",
      "GEM_PATH",
      "BUNDLE_PATH",
      "DOTNET_ROOT",
      "ANDROID_HOME",
      "ANDROID_SDK_ROOT",
      "ASDF_DIR",
      "ASDF_DATA_DIR",
      "MISE_DATA_DIR",
    ].map((name) => name.toUpperCase()),
  )

  /** 접두사로 통과. 개별 이름을 다 적기 어려운 계열만 둔다. */
  const ALLOW_PREFIXES = ["LC_", "XDG_", "NPM_CONFIG_", "PLAYWRIGHT_"]

  /**
   * allowlist 를 통과했더라도 이 패턴에 걸리면 지운다. allowlist 가 이미 기본 차단이라 대개는
   * 중복이지만, 접두사 통과(NPM_CONFIG_//registry/:_authToken 같은 것)와 escape hatch 로 열어 준
   * 이름까지 한 번 더 훑는 안전망이다.
   */
  const DENY_RE = /(^|_)(TOKEN|KEY|APIKEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|AUTH|PRIVATE)(_|$)/i

  /** 배포/운영 네임스페이스. escape hatch 로도 못 여는 하드 차단. */
  const DENY_PREFIXES = ["OPENCODE_", "ENK_", "JUPYTERHUB_", "JPY_"]

  /**
   * 통과 목록을 넓혀야 할 때 쓰는 탈출구. 쉼표로 구분한 이름 또는 `FOO_*` 형태의 접두사.
   * 이 변수 자체는 OPENCODE_ 접두사라 자식에게 상속되지 않는다. 값이 바뀌는 걸 테스트에서 보려면
   * 모듈 로드 시점이 아니라 호출 시점에 읽어야 하므로 상수로 캐시하지 않는다.
   */
  function extra() {
    const raw = process.env["OPENCODE_CHILD_ENV_ALLOW"]
    if (!raw) return { names: new Set<string>(), prefixes: [] as string[] }
    const names = new Set<string>()
    const prefixes: string[] = []
    for (const item of raw.split(",")) {
      const token = item.trim().toUpperCase()
      if (!token) continue
      if (token.endsWith("*")) prefixes.push(token.slice(0, -1))
      else names.add(token)
    }
    return { names, prefixes }
  }

  export function allowed(name: string, allow?: ReadonlySet<string>) {
    const upper = name.toUpperCase()
    if (DENY_PREFIXES.some((prefix) => upper.startsWith(prefix))) return false
    if (allow?.has(upper)) return true
    if (DENY_RE.test(upper)) return false
    if (ALLOW_NAMES.has(upper)) return true
    if (ALLOW_PREFIXES.some((prefix) => upper.startsWith(prefix))) return true
    const custom = extra()
    if (custom.names.has(upper)) return true
    return custom.prefixes.some((prefix) => upper.startsWith(prefix))
  }

  export type Options = {
    /** 이 실행에 한해 추가로 통과시킬 이름. 프로젝트 .env 키를 앱에 넘길 때 쓴다. */
    allow?: Iterable<string>
    /** 필터를 거친 뒤 덮어쓸 값. */
    extend?: NodeJS.ProcessEnv
    /** 기본값은 process.env. 테스트에서 갈아끼운다. */
    base?: NodeJS.ProcessEnv
  }

  function allowSet(allow?: Iterable<string>) {
    if (!allow) return undefined
    const out = new Set<string>()
    for (const name of allow) out.add(name.toUpperCase())
    return out
  }

  /** 필터를 통과한 변수만 담은 새 환경 객체. spawn 의 env 로 그대로 넘긴다. */
  export function sanitize(opts: Options = {}): NodeJS.ProcessEnv {
    const base = opts.base ?? process.env
    const allow = allowSet(opts.allow)
    const out: NodeJS.ProcessEnv = {}
    for (const [name, value] of Object.entries(base)) {
      if (value === undefined) continue
      if (!allowed(name, allow)) continue
      out[name] = value
    }
    return { ...out, ...opts.extend }
  }

  /**
   * 차단 대상 이름을 `undefined` 로 매핑한 객체. `{ ...process.env, ...mask() }` 로 합치는 호출부용.
   * node 의 spawn 은 값이 undefined 인 항목을 환경에서 빼므로 sanitize 와 같은 결과가 된다.
   */
  export function mask(opts: Pick<Options, "allow" | "base"> = {}): Record<string, undefined> {
    const base = opts.base ?? process.env
    const allow = allowSet(opts.allow)
    const out: Record<string, undefined> = {}
    for (const name of Object.keys(base)) {
      if (allowed(name, allow)) continue
      out[name] = undefined
    }
    return out
  }

  /**
   * 디렉토리의 `.env` 계열 파일에 정의된 키 이름들. 값은 읽지 않는다.
   *
   * bash 에서는 이 키들을 지우고(에이전트가 UI 로 저장한 시크릿을 못 보게), 앱을 띄울 때는
   * 반대로 통과시킨다(앱은 그 값으로 동작해야 하므로) — 방향이 반대라 목록만 여기서 공유한다.
   */
  export async function envFileKeys(dir: string) {
    const keys = new Set<string>()
    try {
      const entries = await readdir(dir)
      for (const entry of entries) {
        if (!EnvFile.isSecretFile(entry)) continue
        for (const name of await EnvFile.names(path.join(dir, entry))) keys.add(name)
      }
    } catch {}
    return keys
  }
}
