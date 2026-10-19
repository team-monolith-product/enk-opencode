import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

// 자식 프로세스 환경은 통과시킬 것만 고르는 allowlist 다. 운영 시크릿(JUPYTERHUB_*, ENK_*, OPENCODE_* 등)은 막고,
// 툴체인이 필요로 하는 변수는 넉넉히 연다. OPENCODE_CHILD_ENV_ALLOW 로 이름이나 `FOO_*` 접두사를 더 열 수 있다.

const ALLOW_NAMES = new Set(
  [
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
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "FTP_PROXY",
    "NO_PROXY",
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
const ALLOW_PREFIXES = ["LC_", "XDG_", "NPM_CONFIG_", "PLAYWRIGHT_"]
const DENY_RE = /(^|_)(TOKEN|KEY|APIKEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|AUTH|PRIVATE)(_|$)/i
const DENY_PREFIXES = ["OPENCODE_", "ENK_", "JUPYTERHUB_", "JPY_"]

function extra(env: NodeJS.ProcessEnv) {
  const names = new Set<string>()
  const prefixes: string[] = []
  for (const item of (env.OPENCODE_CHILD_ENV_ALLOW ?? "").split(",")) {
    const token = item.trim().toUpperCase()
    if (!token) continue
    if (token.endsWith("*")) prefixes.push(token.slice(0, -1))
    else names.add(token)
  }
  return { names, prefixes }
}

export function allowed(name: string, allow?: ReadonlySet<string>, env: NodeJS.ProcessEnv = process.env) {
  const upper = name.toUpperCase()
  if (DENY_PREFIXES.some((prefix) => upper.startsWith(prefix))) return false
  if (allow?.has(upper)) return true
  if (DENY_RE.test(upper)) return false
  if (ALLOW_NAMES.has(upper)) return true
  if (ALLOW_PREFIXES.some((prefix) => upper.startsWith(prefix))) return true
  const custom = extra(env)
  return custom.names.has(upper) || custom.prefixes.some((prefix) => upper.startsWith(prefix))
}

export function sanitize(
  options: { allow?: Iterable<string>; extend?: NodeJS.ProcessEnv; base?: NodeJS.ProcessEnv } = {},
) {
  const base = options.base ?? process.env
  const allow = options.allow ? new Set([...options.allow].map((name) => name.toUpperCase())) : undefined
  const out: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || !allowed(name, allow)) continue
    out[name] = value
  }
  return { ...out, ...options.extend }
}

// 막힌 이름을 undefined 로 매핑한다. `{ ...process.env, ...mask() }` 로 합치는 호출부용.
export function mask(options: { allow?: Iterable<string>; base?: NodeJS.ProcessEnv } = {}) {
  const base = options.base ?? process.env
  const allow = options.allow ? new Set([...options.allow].map((name) => name.toUpperCase())) : undefined
  const out: Record<string, undefined> = {}
  for (const name of Object.keys(base)) if (!allowed(name, allow)) out[name] = undefined
  return out
}

const ENTRY_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/
const SECRET_NAME_RE = /^\.env(\..+)?$/

export function isSecretFile(name: string) {
  const base = name.replaceAll("\\", "/").split("/").pop() ?? name
  return SECRET_NAME_RE.test(base) && base !== ".env.example"
}

function deserialize(raw: string) {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
    return value.slice(1, -1).replace(/\\(.)/g, "$1")
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  return value
}

export function parseValues(content: string) {
  const out: Record<string, string> = {}
  for (const line of content.split("\n")) {
    const match = ENTRY_RE.exec(line)
    if (match && !(match[1] in out)) out[match[1]] = deserialize(match[2])
  }
  return out
}

// 디렉터리의 시크릿 env 파일(.env 먼저, 나머지 이름순)을 합친 이름 -> 값. 뒤 파일이 앞을 덮는다.
export async function load(dir: string) {
  const entries = await readdir(dir).catch(() => [] as string[])
  const files = entries.filter(isSecretFile).sort((a, b) => (a === ".env" ? -1 : b === ".env" ? 1 : a.localeCompare(b)))
  const out: Record<string, string> = {}
  for (const file of files) {
    const content = await readFile(path.join(dir, file), "utf8").catch(() => undefined)
    if (content !== undefined) Object.assign(out, parseValues(content))
  }
  return out
}

// .env 계열 파일에 정의된 키 이름. 셸에서는 지우고 앱을 띄울 때는 통과시킨다(방향만 반대).
export async function envFileKeys(dir: string) {
  return new Set(Object.keys(await load(dir)))
}

export * as Env from "./env"
