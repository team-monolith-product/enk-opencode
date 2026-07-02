import { Server } from "../../server/server"
import * as Room from "../../doc/room"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import { Workspace } from "../../control-plane/workspace"
import { Project } from "../../project/project"
import { Installation } from "../../installation"

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  handler: async (args) => {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = await resolveNetworkOptions(args)
    const server = Server.listen(opts)
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    // Graceful shutdown (cull/manual pod stop sends SIGTERM): tell every doc client the session is
    // over so it stops reconnecting, instead of letting sockets die without a close code.
    process.once("SIGTERM", async () => {
      Room.closeAll(Room.CLOSE_SESSION_ENDED, "session ended")
      await server.stop(true)
      process.exit(0)
    })

    await new Promise(() => {})
    await server.stop()
  },
})
