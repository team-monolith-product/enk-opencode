import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Log } from "@/util/log"
import { GitHub } from "./github"
import { GitHubSync } from "./github-sync"
import { History } from "./history"
import { Locale } from "./locale"

export namespace HistorySync {
  const log = Log.create({ service: "history-sync" })

  const LABEL: Record<Locale.Value, { revert: (subject: string) => string; backup: string }> = {
    ko: { revert: (subject) => `되돌리기: ${subject}`, backup: "되돌리기 전 자동 저장" },
    en: { revert: (subject) => `Roll back to: ${subject}`, backup: "Saved before rolling back" },
  }

  export const Event = {
    Restored: BusEvent.define(
      "history.restored",
      z.object({
        sessionID: SessionID.zod,
        sha: z.string(),
        target: z.string(),
        subject: z.string(),
        files: z.number(),
        deps: z.boolean(),
      }),
    ),
  }

  export function init() {
    const dir = Instance.directory
    Bus.subscribe(SessionStatus.Event.Idle, async (evt) => {
      const turn = await GitHubSync.current(evt.properties.sessionID).catch(() => undefined)
      if (!turn) return
      const saved = await History.commit(dir, {
        message: (changes) => GitHubSync.describe(turn, changes),
        trailers: { [History.Trailer.message]: turn.user.id },
      }).catch((err) => {
        log.warn("save failed", { error: err instanceof Error ? err.message : String(err) })
        return undefined
      })
      await GitHubSync.sync(dir, turn, saved?.message).catch(skip)
    })
  }

  function skip(err: unknown) {
    if (err instanceof GitHub.Failure) return log.info("github skipped", { code: err.code })
    log.warn("github failed", { error: err instanceof Error ? err.message : String(err) })
  }

  /** 투표를 열기 전과 되돌리기 직전에 같은 조건을 본다. 투표가 도는 사이 마감될 수 있다. */
  export async function check(input: { sessionID: SessionID; sha: string }) {
    const session = await Session.get(input.sessionID)
    if (!History.enabled(session.directory)) throw new History.Failure("disabled", 404)
    if (!(await History.open())) throw new History.Failure("closed", 403)
    const target = await History.entry(session.directory, input.sha)
    if (!target) throw new History.Failure("missing", 404)
    await SessionPrompt.assertNotBusy(input.sessionID)
    return { session, target }
  }

  export async function rollback(input: { sessionID: SessionID; sha: string }) {
    const { session } = await check(input)
    const turn = GitHubSync.latest(await Session.messages({ sessionID: input.sessionID }))
    const locale = turn?.user.locale ?? Locale.DEFAULT
    const label = LABEL[locale]
    const result = await History.restore(session.directory, {
      sha: input.sha,
      message: (target) => label.revert(target.subject),
      backup: label.backup,
    })
    await Bus.publish(Event.Restored, {
      sessionID: input.sessionID,
      sha: result.sha,
      target: result.target.sha,
      subject: result.target.subject,
      files: result.changes.length,
      deps: result.deps,
    })
    if (result.changes.length > 0) {
      void GitHubSync.publish(
        session.directory,
        GitHubSync.compose(label.revert(result.target.subject), result.changes, locale),
      ).catch(skip)
    }
    return result
  }
}
