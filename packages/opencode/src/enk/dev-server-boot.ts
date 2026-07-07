import { Log } from "@/util/log"
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
    for (const target of ServeTargets.all()) {
      const record = await DevServerReplay.loadRecord(target)
      if (!record) {
        await DevServerAgent.fallback(target)
        continue
      }
      if (await probePort(record.port)) {
        log.info("dev server already listening, skipping replay", { port: record.port })
        continue
      }
      const child = DevServerReplay.launch(record.cmd, record.cwd)
      log.info("replayed dev server", { pid: child.pid, port: record.port, cwd: record.cwd })
    }
  }
}
