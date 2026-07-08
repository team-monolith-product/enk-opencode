import { Log } from "@/util/log"
import { ServeTargets } from "./serve-targets"
import { probePort } from "./dev-server-launch"
import { DevServerAgent } from "./dev-server-agent"

/**
 * 부팅 시 서빙 타깃(본행사 :3000/튜토리얼 :3001)별로 dev 서버를 살린다 — 갤러리
 * 미리보기가 방문자 트리거 스폰(클라이언트 접속 없음)에서도 동작하기 위한 단일 진입점.
 *
 * 타깃마다 포트가 비어 있으면 숨김 AI 세션(DevServerAgent)에게 "서버 띄워줘"를 시킨다.
 * 커맨드를 저장/재실행하지 않는다 — pod 는 EFS 작업 디렉토리를 그대로 물고 재스폰되므로,
 * 부팅 때 AI 가 매번 판단해 띄우면 된다(같은 pod 가 살아있는 동안엔 이미 떠 있어 skip).
 * 타깃별 실패는 격리한다 — 한 타깃이 죽어도 나머지는 살아야 한다.
 */
export namespace DevServerBoot {
  const log = Log.create({ service: "enk.dev-server-boot" })

  export async function boot() {
    for (const target of ServeTargets.all()) {
      try {
        if (await probePort(target.port)) {
          log.info("dev server already listening, skipping", { port: target.port })
          continue
        }
        await DevServerAgent.ensure(target)
      } catch (err) {
        log.warn("dev server boot failed", { dir: target.dir, err: String(err) })
      }
    }
  }
}
