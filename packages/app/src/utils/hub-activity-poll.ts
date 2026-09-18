import { Poll } from "@lumino/polling"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"

// 보고 있는 탭을 hub 활동으로 남기기 위한 조회다. 응답은 쓰지 않는다(세션 상태는 SSE 가 갱신).
// JupyterLab KernelManager 와 같은 설정: https://github.com/jupyterlab/jupyterlab/blob/v4.4.10/packages/services/src/kernel/manager.ts#L36-L46
export function createHubActivityPoll(client: () => OpencodeClient) {
  return new Poll({
    auto: false,
    factory: () => client().session.status(),
    frequency: { interval: 10 * 1000, backoff: true, max: 300 * 1000 },
    name: "HubActivity#running",
    standby: "when-hidden",
  })
}
