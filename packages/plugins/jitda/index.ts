import { Plugin } from "@opencode/plugin"
import { AiUsage } from "./src/ai-usage"
import { Image } from "./src/image"

export default Plugin.define({
  id: "jitda",
  async setup(ctx) {
    const usage = AiUsage.reporter()
    const cleanups = [AiUsage.start(ctx, usage), await Image.start(ctx, usage)]

    return async () => {
      for (const cleanup of cleanups) await cleanup()
    }
  },
})
