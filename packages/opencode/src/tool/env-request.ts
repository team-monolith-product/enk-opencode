import path from "path"
import { EnvRequest } from "../env-request"
import { Instance } from "../project/instance"
import { EnvFile } from "../util/env-file"
import { Tool } from "./tool"
import DESCRIPTION from "./env-request.txt"

// 값은 이 툴을 통과하지 않는다 — 파라미터에도 결과에도 없다. 자세한 배경은 EnvRequest 네임스페이스 주석 참고.
export const EnvRequestTool = Tool.define("env_request", {
  description: DESCRIPTION,
  parameters: EnvRequest.Info,
  async execute(params, ctx) {
    const file = path.join(Instance.directory, ".env")

    // 이미 값이 있어도 항상 입력창을 연다. 저장된 이름은 교체 UI 안내만 켠다.
    const existing = await EnvFile.names(file)
    const replace = !!params.replace || existing.includes(params.name)

    const result = await EnvRequest.ask({
      sessionID: ctx.sessionID,
      info: { ...params, replace: replace || undefined },
      tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
    })

    // 참가자가 이름을 고쳤을 수 있으므로 확정된 이름으로 안내한다 — 안 그러면 AI 가 없는 이름을 읽는 코드를 짠다.
    const name = result.name
    const output = {
      saved: `The user stored a value for ${name}. Continue with the work. The value stays hidden from you — write code that reads ${name} from the environment.`,
      skipped: `The user chose to continue without ${name}. Use sample or placeholder data and say clearly in your reply that the data is temporary.`,
      canceled: `The user dismissed the request for ${name}. Do not re-open it unless they bring it up.`,
    }[result.status]

    return {
      title: params.label,
      output,
      metadata: { name, status: result.status },
    }
  },
})
