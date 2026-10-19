import { dirname, join, resolve, sep } from "node:path"

// 프리뷰 서빙 타깃. 팀 pod 하나가 본행사(:3000)와 튜토리얼(:3001) 두 앱을 서빙한다. CHP 가 `{opencodeId}.{domain}` 을
// :3000, `{opencodeId}-tutorial.{domain}` 을 :3001 로 직결하는 규약, rails mountable_team.rb 의 디렉터리 규약과 짝이다.

export type Kind = "project" | "tutorial"

export type Target = { kind: Kind; dir: string; port: number }

export const PORTS: Record<Kind, number> = { project: 3000, tutorial: 3001 }

const TUTORIAL_HOST_SUFFIX = "-tutorial"
const TUTORIAL_DIR_NAME = "tutorial-directory"

export function project(env: NodeJS.ProcessEnv = process.env): Target | undefined {
  const dir = env.ENK_PROJECT_DIRECTORY
  return dir ? { kind: "project", dir: resolve(dir), port: PORTS.project } : undefined
}

export function tutorial(env: NodeJS.ProcessEnv = process.env): Target | undefined {
  const base = project(env)
  if (!base) return undefined
  return { kind: "tutorial", dir: join(dirname(base.dir), TUTORIAL_DIR_NAME), port: PORTS.tutorial }
}

export function previewHost(kind: Kind, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const user = env.JUPYTERHUB_USER
  const domain = env.OPENCODE_SERVE_DOMAIN
  if (!user || !domain) return undefined
  return `https://${user}${kind === "tutorial" ? TUTORIAL_HOST_SUFFIX : ""}.${domain}`
}

function contains(parent: string, child: string) {
  const path = resolve(child)
  return path === parent || path.startsWith(parent + sep)
}

// cwd 가 속한 타깃. 경로로만 판정하고, env 가 없으면 이름 규약으로 튜토리얼만 식별한다.
export function forCwd(cwd: string, env: NodeJS.ProcessEnv = process.env): Target | undefined {
  const tut = tutorial(env)
  if (tut && contains(tut.dir, cwd)) return tut
  const base = project(env)
  if (base && contains(base.dir, cwd)) return base
  const parts = resolve(cwd).split(sep)
  const index = parts.lastIndexOf(TUTORIAL_DIR_NAME)
  if (index >= 0) return { kind: "tutorial", dir: parts.slice(0, index + 1).join(sep), port: PORTS.tutorial }
  return undefined
}

export * as ServeTargets from "./serve-targets"
