import { Log } from "@/util/log"
import { Flag } from "@/flag/flag"
import { ServeTargets } from "./serve-targets"
import { DevServerReplay, probePort } from "./dev-server-replay"
import { DevServerAgent } from "./dev-server-agent"

/**
 * 부팅 시 서빙 타깃(본행사 :3000/튜토리얼 :3001)별로 dev 서버를 살린다 — 갤러리
 * 미리보기가 방문자 트리거 스폰(클라이언트 접속 없음)에서도 동작하기 위한 단일 진입점.
 *
 * 타깃마다: 유효한 기록(DevServerReplay.loadRecord)이 있으면 그대로 재실행하고,
 * 없으면 숨김 AI 세션 폴백(DevServerAgent)으로 재구축한다. 폴백이 성공하면
 * ensure_dev_server 가 기록을 남겨 다음 부팅부터는 재실행 경로로 복귀한다.
 */
export namespace DevServerBoot {
  const log = Log.create({ service: "enk.dev-server-boot" })

  export async function boot() {
    // 1단계: 값싼 재실행(ms 단위)을 모든 타깃에 먼저 적용한다. 기록이 없는 타깃은
    // 모아 두었다가 2단계에서 처리해, 분 단위 AI 폴백이 다른 타깃의 재실행을 막지
    // 않게 한다. 타깃별 실패는 격리한다 — 한 타깃이 죽어도 나머지는 살아야 한다.
    const fallbacks: ServeTargets.Target[] = []
    for (const target of ServeTargets.all()) {
      try {
        const record = await DevServerReplay.loadRecord(target)
        if (!record) {
          fallbacks.push(target)
          continue
        }
        if (await probePort(record.port)) {
          log.info("dev server already listening, skipping replay", { port: record.port })
          continue
        }
        const child = DevServerReplay.launch(record.cmd, record.cwd)
        log.info("replayed dev server", { pid: child.pid, port: record.port, cwd: record.cwd })
      } catch (err) {
        log.warn("dev server replay failed", { dir: target.dir, err: String(err) })
      }
    }

    // 2단계: AI 폴백은 무거우므로(LLM 실행) 타깃당 직렬로 돌아 pod 를 압박하지 않는다.
    // LLM 턴·의존성 설치가 부팅 직후 첫 IDE 로드와 CPU 를 경합해 API 504 를 유발할 수
    // 있어 opt-in(ENK_DEV_SERVER_AGENT) — 꺼져 있으면 기록 없는 타깃은 그대로 둔다.
    if (!Flag.ENK_DEV_SERVER_AGENT) {
      if (fallbacks.length > 0) {
        log.info("dev-server agent disabled, leaving targets without records", {
          dirs: fallbacks.map((t) => t.dir),
        })
      }
      return
    }
    for (const target of fallbacks) {
      try {
        await DevServerAgent.fallback(target)
      } catch (err) {
        log.warn("dev server agent fallback failed", { dir: target.dir, err: String(err) })
      }
    }
  }
}
