import type { ChildProcessWithoutNullStreams } from "child_process"
import { Process } from "../util/process"
import { ChildEnv } from "../util/child-env"
import { Instance } from "../project/instance"

type Child = Process.Child & ChildProcessWithoutNullStreams

function explicit(env: NodeJS.ProcessEnv | null | undefined) {
  if (!env) return []
  return Object.keys(env).filter((name) => env[name] !== process.env[name])
}

/** 인스턴스 밖에서 부르는 호출부(런처 단독 테스트)도 있어 없으면 .env 제거만 건너뛴다. */
function projectDir() {
  try {
    return Instance.directory
  } catch {
    return undefined
  }
}

export function spawn(cmd: string, args: string[], opts?: Process.Options): Child
export function spawn(cmd: string, opts?: Process.Options): Child
export function spawn(cmd: string, argsOrOpts?: string[] | Process.Options, opts?: Process.Options) {
  const args = Array.isArray(argsOrOpts) ? [...argsOrOpts] : []
  const cfg = Array.isArray(argsOrOpts) ? opts : argsOrOpts
  // Process.spawn 은 env 를 process.env 위에 얹으므로 통째로 교체할 수 없다. 차단 대상을
  // undefined 로 덮어 같은 결과를 낸다 — node 의 spawn 은 값이 undefined 인 항목을 환경에서 뺀다.
  // 호출부가 "일부러 지정한" 이름(process.env 와 값이 다른 것)만 필터에서 빼 준다. 대부분의 호출부가
  // `{ ...process.env, BUN_BE_BUN: "1" }` 꼴로 넘기는데, 키 목록을 그대로 믿으면 필터가 무력화된다.
  // 언어 서버는 프로젝트 코드를 로드하므로(eslint 설정, tsserver 플러그인 ...) 에이전트가 쓴 코드가
  // 이 프로세스 안에서 돈다. bash/PTY/MCP 와 같은 기준으로 프로젝트 .env 키까지 지운다.
  const dir = projectDir()
  const allow = explicit(cfg?.env)
  const masked = dir ? ChildEnv.maskForAgent(dir, { allow }) : ChildEnv.mask({ allow })
  const env = cfg?.env === null ? null : { ...cfg?.env, ...masked }
  const proc = Process.spawn([cmd, ...args], {
    ...(cfg ?? {}),
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }) as Child

  if (!proc.stdin || !proc.stdout || !proc.stderr) throw new Error("Process output not available")

  return proc
}
