// .env 는 UI 로 넣은 시크릿 저장소(쓰기 전용)라 모델 도구가 읽으면 안 된다. 프로세스 환경·메모리, opencode 자격 증명·DB,
// 환경을 통째로 덤프하는 커맨드도 막는다. 설정이 무엇을 허용하든 마지막에 이 규칙이 이긴다(V1 ENV_FILE_GUARD).

export type Rule = { action: string; pattern: string; effect: "allow" | "deny" }

export const RULES: readonly Rule[] = [
  { action: "read", pattern: "*.env", effect: "deny" },
  { action: "read", pattern: "*.env.*", effect: "deny" },
  { action: "read", pattern: "*.env.example", effect: "allow" },
  { action: "edit", pattern: "*.env", effect: "deny" },
  { action: "edit", pattern: "*.env.*", effect: "deny" },
  { action: "edit", pattern: "*.env.example", effect: "allow" },
  { action: "shell", pattern: "* .env *", effect: "deny" },
  { action: "shell", pattern: "* .env.*", effect: "deny" },
  { action: "shell", pattern: "*/.env *", effect: "deny" },
  { action: "shell", pattern: "*/.env.*", effect: "deny" },
  // 값 조회 RPC 도 막는다. 파일만 막으면 서버를 거쳐 읽는 길이 열린다.
  { action: "shell", pattern: "*jitda.env-file*", effect: "deny" },
  { action: "webfetch", pattern: "*jitda.env-file*", effect: "deny" },
  { action: "read", pattern: "*/proc/*/environ", effect: "deny" },
  { action: "shell", pattern: "*/proc/*/environ*", effect: "deny" },
  { action: "read", pattern: "*/proc/*/mem", effect: "deny" },
  { action: "read", pattern: "*/proc/*/maps", effect: "deny" },
  { action: "shell", pattern: "*/proc/*/mem*", effect: "deny" },
  { action: "shell", pattern: "*/proc/*/maps*", effect: "deny" },
  { action: "read", pattern: "*/opencode/auth.json", effect: "deny" },
  { action: "edit", pattern: "*/opencode/auth.json", effect: "deny" },
  { action: "shell", pattern: "*/opencode/auth.json*", effect: "deny" },
  { action: "read", pattern: "*/opencode/opencode.db*", effect: "deny" },
  { action: "shell", pattern: "*/opencode/opencode.db*", effect: "deny" },
  // 셸 도구는 파이프라인의 커맨드마다 리소스를 만들므로 `env | grep TOKEN` 도 "env" 로 걸린다.
  { action: "shell", pattern: "env", effect: "deny" },
  { action: "shell", pattern: "env -*", effect: "deny" },
  { action: "shell", pattern: "*/bin/env", effect: "deny" },
  { action: "shell", pattern: "*/bin/env -*", effect: "deny" },
  { action: "shell", pattern: "printenv*", effect: "deny" },
  { action: "shell", pattern: "*/bin/printenv*", effect: "deny" },
  { action: "shell", pattern: "export", effect: "deny" },
  { action: "shell", pattern: "export -p*", effect: "deny" },
  { action: "shell", pattern: "declare", effect: "deny" },
  { action: "shell", pattern: "declare -p*", effect: "deny" },
  { action: "shell", pattern: "declare -x*", effect: "deny" },
  { action: "shell", pattern: "typeset", effect: "deny" },
  { action: "shell", pattern: "typeset -p*", effect: "deny" },
  { action: "shell", pattern: "typeset -x*", effect: "deny" },
  { action: "shell", pattern: "set", effect: "deny" },
  { action: "shell", pattern: "Get-ChildItem Env:*", effect: "deny" },
  { action: "shell", pattern: "gci Env:*", effect: "deny" },
  { action: "shell", pattern: "ls Env:*", effect: "deny" },
  { action: "shell", pattern: "dir Env:*", effect: "deny" },
]

export function match(value: string, pattern: string, platform = process.platform) {
  const input = value.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  return new RegExp("^" + escaped + "$", platform === "win32" ? "si" : "s").test(input)
}

// 규칙 안에서는 마지막에 맞은 것이 이긴다(.env.example 허용이 .env.* 거부를 덮는다).
export function decide(action: string, resource: string) {
  let effect: Rule["effect"] | undefined
  for (const rule of RULES) if (rule.action === action && match(resource, rule.pattern)) effect = rule.effect
  return effect
}

export function denied(action: string, resources: ReadonlyArray<string>) {
  return resources.some((resource) => decide(action, resource) === "deny")
}

export * as Guard from "./guard"
