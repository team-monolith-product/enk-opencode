import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Session } from "@/session"
import { SessionID } from "@/session/schema"
import { SessionPrompt } from "@/session/prompt"
import type { Permission } from "@/permission"
import { probePort } from "./dev-server-replay"
import { ServeTargets } from "./serve-targets"
import { AiUsage } from "./ai-usage"

/**
 * 재실행 가능한 기록이 없는 타깃의 폴백 — 숨김 AI 세션을 만들어 ensure_dev_server 로
 * dev 서버를 띄우게 한다. 호출 여부는 부팅 오케스트레이션(DevServerBoot)이 결정한다.
 *
 * 기록은 이 기능 배포 이후 ensure_dev_server 가 실행될 때만 남으므로, 그 이전에 마지막으로
 * 작업된 프로젝트는 갤러리 깨우기(스폰 대행)로 pod 가 살아나도 타깃 포트가 영영 뜨지 않는다.
 * AI 가 성공하면 ensure_dev_server 의 record 경로가 기록 파일을 남겨 스스로 백필되고,
 * 다음 부팅부터는 기계적 재실행으로 복귀한다 — 즉 타깃당 최대 1회의 LLM 실행이다.
 *
 * 사용자에게 보이지 않아야 한다:
 * - 세션 목록은 parent_id IS NULL 만 노출하고(session/index.ts list) 자동 복원도
 *   루트 세션만 집으므로(directory-layout.tsx), 실존하지 않는 parentID 를 달아 숨긴다.
 *   parent_id 에는 FK 가 없어 안전하다(session.sql.ts).
 * - 완료 후 Session.remove 로 흔적을 지운다.
 * - 토큰 사용량 집계(AiUsage)는 참가자 결산을 오염시키지 않도록 세션 단위로 제외한다.
 * - 모델은 config 가 ENK_AI_MODEL 을 기본값으로 강제하므로 별도 지정하지 않는다.
 */
export namespace DevServerAgent {
  const log = Log.create({ service: "enk.dev-server-agent" })

  const MARKER_FILE = ".opencode/dev-server-agent.json"
  const ATTEMPT_COOLDOWN_MS = 10 * 60 * 1000
  const PROMPT_TIMEOUT_MS = 4 * 60 * 1000

  // findLast 매칭이라 뒤의 allow 가 앞의 전면 deny 를 덮는다(permission/evaluate.ts).
  // 매칭 없음의 기본값이 "ask"(응답 대기 hang)이므로 전면 deny 로 반드시 전부 커버한다.
  // deny 는 도구를 모델에 아예 노출하지 않으므로(llm.ts resolveTools) 코드 수정이 불가능하다.
  const PERMISSION: Permission.Ruleset = [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "glob", pattern: "*", action: "allow" },
    { permission: "grep", pattern: "*", action: "allow" },
    { permission: "list", pattern: "*", action: "allow" },
    { permission: "ensure_dev_server", pattern: "*", action: "allow" },
  ]

  function buildPrompt(port: number): string {
    return [
      `이 프로젝트의 dev 서버를 ${port} 포트로 실행해 주세요.`,
      "- 반드시 ensure_dev_server 도구로 실행하세요. 코드/파일은 절대 수정하지 마세요.",
      "- package.json 의 scripts 를 확인해 적절한 명령을 정하세요.",
      `- 외부 접근이 가능해야 하므로 host 0.0.0.0 으로 바인딩하세요 (예: 'npm run dev -- --host 0.0.0.0 --port ${port} --strictPort').`,
      "- cmd 에 의존성 설치(npm install 등)를 절대 포함하지 마세요. node_modules 가 없으면 시도하지 말고 그대로 마치세요.",
      "- 서버를 띄우는 것 외의 작업은 하지 마세요.",
    ].join("\n")
  }

  type Marker = { attemptedAt: number }

  /**
   * 폴백을 시도해야 하는지 판정한다. 포트가 이미 살아 있으면 할 일이 없고,
   * package.json 이 없으면(빈/비 node 프로젝트) AI 를 돌릴 근거가 없다.
   * 최근 시도 마커는 스폰-실패 반복 루프를 쿨다운으로 막는다.
   */
  export async function shouldAttempt(dir: string, port: number): Promise<boolean> {
    if (!existsSync(resolve(dir, "package.json"))) return false
    if (await probePort(port)) return false
    try {
      const marker = (await Bun.file(resolve(dir, MARKER_FILE)).json()) as Marker
      if (Date.now() - marker.attemptedAt < ATTEMPT_COOLDOWN_MS) return false
    } catch {
      // 마커 없음/파싱 불가 — 시도 가능.
    }
    return true
  }

  async function writeMarker(dir: string) {
    try {
      await Bun.write(resolve(dir, MARKER_FILE), JSON.stringify({ attemptedAt: Date.now() } satisfies Marker) + "\n")
    } catch (err) {
      log.warn("failed to write attempt marker", { err: String(err) })
    }
  }

  /** 타깃 하나에 대한 AI 폴백. 게이트(shouldAttempt) 통과 시에만 숨김 세션을 돌린다. */
  export async function fallback(target: ServeTargets.Target) {
    const { dir, port } = target
    if (!(await shouldAttempt(dir, port))) return

    await writeMarker(dir)
    log.info("starting hidden dev-server agent session", { dir, port, kind: target.kind })

    await Instance.provide({
      directory: dir,
      init: InstanceBootstrap,
      fn: async () => {
        const session = await Session.create({
          parentID: SessionID.descending(),
          title: "enk: dev server autostart (internal)",
          permission: PERMISSION,
        })
        AiUsage.exclude(session.id)
        try {
          let timer: ReturnType<typeof setTimeout> | undefined
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              // cancel 완료 후 reject 해, finally 의 Session.remove 가 진행 중인
              // 프롬프트 루프와 경합하지 않게 한다.
              void SessionPrompt.cancel(session.id)
                .catch(() => {})
                .finally(() => reject(new Error("dev-server agent timed out")))
            }, PROMPT_TIMEOUT_MS)
          })
          await Promise.race([
            SessionPrompt.prompt({
              sessionID: session.id,
              parts: [{ type: "text", text: buildPrompt(port) }],
            }),
            timeout,
          ]).finally(() => clearTimeout(timer))
        } finally {
          await Session.remove(session.id).catch((err) => {
            log.warn("failed to remove hidden session", { sessionID: session.id, err: String(err) })
          })
        }

        if (await probePort(port)) {
          log.info("dev server started by agent", { dir, port })
        } else {
          log.warn("agent finished but dev server not listening", { dir, port })
        }
      },
    })
  }
}
