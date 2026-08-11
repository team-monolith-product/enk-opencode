import { dirname, join, resolve, sep } from "node:path"

/**
 * 프리뷰 서빙 타깃 — 디렉토리↔포트↔서브도메인 규약의 단일 진실.
 *
 * 팀 pod 하나가 두 앱(본행사/튜토리얼)을 서빙하므로, 스폰 시점 선택(env) 대신 고정
 * 컨벤션으로 결정한다. CHP 가 `{opencodeId}.{domain}`→:3000,
 * `{opencodeId}-tutorial.{domain}`→:3001 로 포트만 갈아끼워 직결하는 것과 짝을 이룬다.
 * 본행사가 :3000 인 것은 기존에 떠 있는 서버/기록과의 호환을 위해 바꾸지 않는다.
 *
 * ENK_PROJECT_DIRECTORY(스포너가 owner 로부터 도출)는 `.../project-directory` 를 가리키고,
 * 튜토리얼은 그 형제 `tutorial-directory` 다 — rails mount_map(mountable_team.rb)과
 * 프론트(getServiceUrl.ts)가 공유하는 기존 규약이다.
 */
export namespace ServeTargets {
  export type Kind = "project" | "tutorial"

  export type Target = {
    kind: Kind
    dir: string
    port: number
  }

  export const PORTS: Record<Kind, number> = {
    project: 3000,
    tutorial: 3001,
  }

  /** 튜토리얼 프리뷰 서브도메인 접미사 — CHP targetForServeReq 의 파싱 규약과 일치해야 한다. */
  export const TUTORIAL_HOST_SUFFIX = "-tutorial"

  const TUTORIAL_DIR_NAME = "tutorial-directory"

  /** 본행사 타깃. 스포너가 env 를 주입하지 않는 환경(로컬 등)에서는 undefined. */
  export function project(): Target | undefined {
    const dir = process.env["ENK_PROJECT_DIRECTORY"]
    return dir ? { kind: "project", dir: resolve(dir), port: PORTS.project } : undefined
  }

  /** 튜토리얼 타깃. 본행사 디렉토리의 형제로 도출한다. */
  export function tutorial(): Target | undefined {
    const base = project()
    if (!base) return undefined
    return { kind: "tutorial", dir: join(dirname(base.dir), TUTORIAL_DIR_NAME), port: PORTS.tutorial }
  }

  /**
   * 타깃의 미리보기 호스트. CHP 가 `{user}` 를 :3000, `{user}-tutorial` 을 :3001 로 라우팅한다.
   * 스포너 env 가 없는 환경(로컬 등)에서는 undefined.
   *
   * 이 조립 규칙은 여기 한 곳에만 둔다 — CSP frame-src 와 학생 안내 URL 이 어긋나면
   * 미리보기 iframe 이 통째로 차단된다.
   */
  export function previewHost(kind: Kind): string | undefined {
    const user = process.env["JUPYTERHUB_USER"]
    const domain = process.env["OPENCODE_SERVE_DOMAIN"]
    if (!user || !domain) return undefined

    return `https://${user}${kind === "tutorial" ? TUTORIAL_HOST_SUFFIX : ""}.${domain}`
  }

  function contains(parent: string, child: string): boolean {
    const path = resolve(child)
    return path === parent || path.startsWith(parent + sep)
  }

  /**
   * cwd 가 속한 타깃 — 포트 강제·미리보기 호스트·record 위치의 공통 기준.
   * 판정은 디렉토리 실재와 무관하게 경로로만 한다(세션이 그 안에서 돌고 있으므로).
   * env 미주입 환경에서는 이름 규약만으로 튜토리얼을 식별하고, 그 외에는 undefined 를
   * 반환해 호출부가 기존 동작으로 폴백한다.
   */
  export function forCwd(cwd: string): Target | undefined {
    const tut = tutorial()
    if (tut && contains(tut.dir, cwd)) return tut
    const base = project()
    if (base && contains(base.dir, cwd)) return base

    const parts = resolve(cwd).split(sep)
    const index = parts.lastIndexOf(TUTORIAL_DIR_NAME)
    if (index >= 0) {
      return { kind: "tutorial", dir: parts.slice(0, index + 1).join(sep), port: PORTS.tutorial }
    }
    return undefined
  }
}
