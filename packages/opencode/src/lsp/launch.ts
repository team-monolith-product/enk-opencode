import type { ChildProcessWithoutNullStreams } from "child_process"
import { Process } from "../util/process"
import { ChildEnv } from "../util/child-env"

type Child = Process.Child & ChildProcessWithoutNullStreams

function explicit(env: NodeJS.ProcessEnv | null | undefined) {
  if (!env) return []
  return Object.keys(env).filter((name) => env[name] !== process.env[name])
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
  const env = cfg?.env === null ? null : { ...cfg?.env, ...ChildEnv.mask({ allow: explicit(cfg?.env) }) }
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
