import { Plugin } from "@opencode/plugin"
import { AiUsage } from "./src/ai-usage"
import { DevServerTool } from "./src/dev-server-tool"
import { EnvRequest } from "./src/env-request"
import { Image } from "./src/image"
import { Protect } from "./src/protect"

export default Plugin.define({
  id: "jitda",
  async setup(ctx) {
    const usage = AiUsage.reporter()
    const cleanups = [
      AiUsage.start(ctx, usage),
      await Image.start(ctx, usage),
      await DevServerTool.start(ctx),
      await EnvRequest.start(ctx),
      await Protect.start(ctx),
    ]

    return async () => {
      for (const cleanup of cleanups) await cleanup()
    }
  },
})
