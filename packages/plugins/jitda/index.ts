import { Plugin } from "@opencode/plugin"
import { AiUsage } from "./src/ai-usage"

export default Plugin.define({
  id: "jitda",
  setup(ctx) {
    const cleanups = [AiUsage.start(ctx)]

    return () => {
      for (const cleanup of cleanups) cleanup()
    }
  },
})
