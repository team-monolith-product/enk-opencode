import { existsSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"

/**
 * 프리뷰 서빙 타깃 — 디렉토리↔포트↔서브도메인 규약의 단일 진실.
 *
 * 팀 pod 하나가 두 앱(본행사/튜토리얼)을 서빙해야 하므로, 스폰 시점 선택(env) 대신
 * 고정 컨벤션으로 결정한다. CHP 가 `{opencodeId}.{domain}`→:3000,
 * `{opencodeId}-tutorial.{domain}`→:3001 로 포트만 갈아끼워 직결하는 것과 짝을 이룬다.
 * 본행사가 :3000 인 것은 기존에 떠 있는 서버/기록과의 호환을 위해 바꾸지 않는다.
 *
 * ENK_PROJECT_DIRECTORY(스포너가 owner 로부터 도출)는 `.../project-directory` 를
 * 가리키고, 튜토리얼은 그 형제 `tutorial-directory` 다 — rails mount_map
 * (mountable_team.rb)과 프론트(getServiceUrl.ts)가 공유하는 기존 규약이다.
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

  function projectDir(): string | undefined {
    const dir = process.env["ENK_PROJECT_DIRECTORY"]
    return dir ? resolve(dir) : undefined
  }

  function tutorialDir(): string | undefined {
    const project = projectDir()
    if (!project) return undefined
    return join(dirname(project), TUTORIAL_DIR_NAME)
  }

  /** 부팅 시 살릴 타깃 목록. 디렉토리가 실재하는 것만 포함한다. */
  export function all(): Target[] {
    const targets: Target[] = []
    const project = projectDir()
    if (project && existsSync(project)) targets.push({ kind: "project", dir: project, port: PORTS.project })
    const tutorial = tutorialDir()
    if (tutorial && existsSync(tutorial)) targets.push({ kind: "tutorial", dir: tutorial, port: PORTS.tutorial })
    return targets
  }

  function contains(parent: string, child: string): boolean {
    const rel = resolve(child)
    return rel === parent || rel.startsWith(parent + sep)
  }

  /**
   * cwd 가 속한 타깃 — 포트 강제·미리보기 호스트·record 위치의 공통 기준.
   * 판정은 디렉토리 실재와 무관하게 경로로만 한다(세션이 그 안에서 돌고 있으므로).
   * env 미주입(로컬 등) 환경에서는 이름 규약만으로 튜토리얼을 식별하고, 그 외에는
   * undefined 를 반환해 호출부가 기존 동작으로 폴백한다.
   */
  export function forCwd(cwd: string): Target | undefined {
    const tutorial = tutorialDir()
    if (tutorial && contains(tutorial, cwd)) return { kind: "tutorial", dir: tutorial, port: PORTS.tutorial }
    const project = projectDir()
    if (project && contains(project, cwd)) return { kind: "project", dir: project, port: PORTS.project }
    // env 밖 경로라도 이름 규약으로 튜토리얼을 식별한다(개인 서버 등 형제 규약 밖 케이스 방어).
    const parts = resolve(cwd).split(sep)
    const idx = parts.lastIndexOf(TUTORIAL_DIR_NAME)
    if (idx >= 0) return { kind: "tutorial", dir: parts.slice(0, idx + 1).join(sep), port: PORTS.tutorial }
    return undefined
  }
}
