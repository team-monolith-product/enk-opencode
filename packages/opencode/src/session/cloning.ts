/**
 * Sessions whose messages are being copied in from another session (fork).
 *
 * A fork writes each copied message through the normal message-updated event, so the projector
 * cannot tell a copy from a turn that just finished. A copied turn spent nothing: recording it as
 * a prompt cycle double-counts the original's tokens/cost, and reporting it sends rails a second
 * "answer ended" marker for a turn that never ran. The projector skips both while a session is
 * listed here. In-process only: fork and the projector run in the same server process.
 */
export namespace Cloning {
  const active = new Set<string>()

  export function begin(sessionID: string) {
    active.add(sessionID)
  }

  export function end(sessionID: string) {
    active.delete(sessionID)
  }

  export function has(sessionID: string) {
    return active.has(sessionID)
  }
}
