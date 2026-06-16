import { Log } from "@/util/log"
import type { Provider } from "@/provider/provider"
import type { MessageV2 } from "./message-v2"

export namespace AiUsageReporter {
  const log = Log.create({ service: "ai-usage-reporter" })

  type Input = {
    model: Provider.Model
    tokens: MessageV2.Assistant["tokens"]
    cost: number
  }

  const config = () => {
    const baseUrl = process.env.ENK_HACKATHON_RAILS_URL
    const token = process.env.ENK_AI_USAGE_TOKEN
    const ownerType = process.env.ENK_AI_USAGE_OWNER_TYPE
    const ownerId = process.env.ENK_AI_USAGE_OWNER_ID

    if (!baseUrl || !token || !ownerType || !ownerId) return

    return { baseUrl: baseUrl.replace(/\/+$/, ""), token, ownerType, ownerId }
  }

  export async function report(input: Input) {
    const cfg = config()
    if (!cfg) return

    const tokens =
      input.tokens.total ??
      input.tokens.input +
        input.tokens.output +
        input.tokens.reasoning +
        input.tokens.cache.read +
        input.tokens.cache.write

    if (tokens <= 0) return

    try {
      const response = await fetch(`${cfg.baseUrl}/api/v1/ai_usages`, {
        method: "POST",
        headers: {
          "Authorization": `token ${cfg.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          data: {
            type: "ai-usages",
            attributes: {
              owner_type: cfg.ownerType,
              owner_id: cfg.ownerId,
              model_id: `${input.model.providerID}/${input.model.id}`,
              tokens,
              cost: input.cost,
              activitied_at: new Date().toISOString(),
            },
          },
        }),
      })

      if (!response.ok) {
        log.warn("failed to report ai usage", { status: response.status })
      }
    } catch (error) {
      log.warn("failed to report ai usage", { error })
    }
  }
}
