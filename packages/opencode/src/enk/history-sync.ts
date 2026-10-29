import path from "path"
import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Log } from "@/util/log"
import { EnkFailure } from "./failure"
import { GitHub } from "./github"
import { History } from "./history"
import { Locale } from "./locale"
import { ServeTargets } from "./serve-targets"
import { TurnSummary } from "./turn"

/** 대화가 끝날 때마다 버전을 남기고 GitHub 에 올리며, 합의된 되돌리기를 실행한다. */
export namespace HistorySync {
  const log = Log.create({ service: "history-sync" })

  const REVERT = { ko: "되돌리기: ", en: "Roll back to: " } as const

  // 되돌리기 커밋으로 다시 되돌릴 때 제목이 "되돌리기: 되돌리기: …" 로 겹치지 않게 앞의 접두어를 걷어 낸다.
  function plain(subject: string) {
    for (;;) {
      const prefix = Object.values(REVERT).find((item) => subject.startsWith(item))
      if (!prefix) return subject
      subject = subject.slice(prefix.length)
    }
  }

  const LABEL: Record<Locale.Value, { revert: (subject: string) => string; backup: string }> = {
    ko: { revert: (subject) => `${REVERT.ko}${plain(subject)}`, backup: "되돌리기 전 자동 저장" },
    en: { revert: (subject) => `${REVERT.en}${plain(subject)}`, backup: "Saved before rolling back" },
  }

  const MANIFESTS = new Set([
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "requirements.txt",
    "pyproject.toml",
    "uv.lock",
  ])

  // 되돌리기를 막는 사유. 버전 기록 창의 거절 안내와 같은 이름이고, 그 밖의 실패는 "failed" 로 묶는다.
  const REFUSALS = ["missing", "busy"] as const

  function reason(err: unknown) {
    if (err instanceof Session.BusyError) return "busy"
    if (!(err instanceof EnkFailure)) return "failed"
    return REFUSALS.find((code) => code === err.code) ?? "failed"
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
    // 합의가 서고 나서 되돌리지 못했을 때. 사유는 버전 기록 창의 거절 사유와 같은 이름을 쓴다.
    Failed: BusEvent.define(
      "history.failed",
      z.object({ sessionID: SessionID.zod, code: z.enum([...REFUSALS, "same", "failed"]) }),
    ),
  }

  export function init() {
    const dir = Instance.directory
    Bus.subscribe(SessionStatus.Event.Idle, async (evt) => {
      const turn = await TurnSummary.current(evt.properties.sessionID).catch(() => undefined)
      if (!turn) return
      await History.commit(dir, {
        message: (changes) => TurnSummary.describe(turn, changes),
        turn: turn.user.id,
      }).catch((err) => log.warn("save failed", { error: err instanceof Error ? err.message : String(err) }))
      await GitHub.sync(dir, turn.user.locale).catch((err) => failed(err, evt.properties.sessionID))
    })
  }

  export function failed(err: unknown, sessionID: SessionID) {
    if (err instanceof GitHub.Failure && !GitHub.notify.includes(err.code)) {
      return log.info("skipped", { sessionID, code: err.code, reason: err.message })
    }
    GitHub.alert("sync failed", err, { sessionID })
  }

  /** 투표를 열기 전과 되돌리기 직전에 같은 조건을 본다. 기록에 있는 버전인지는 git 저장소만 보고 판단한다. */
  async function verify(input: { sessionID: SessionID; sha: string }) {
    const session = await Session.get(input.sessionID)
    if (!ServeTargets.isProject(session.directory)) throw new History.Failure("disabled", 404)
    const target = await History.entry(session.directory, input.sha)
    if (!target) throw new History.Failure("missing", 404)
    return { session, target }
  }

  function busy(err: unknown): never {
    if (err instanceof Session.BusyError) throw new EnkFailure("busy", 409, err.message)
    throw err
  }

  /** 투표를 열어도 되는지. AI 가 답하는 중이면 busy 로 거절한다. */
  export async function check(input: { sessionID: SessionID; sha: string }) {
    const found = await verify(input)
    await SessionPrompt.assertNotBusy(input.sessionID).catch(busy)
    return found
  }

  /**
   * 합의된 되돌리기. 세션을 셸 명령처럼 붙잡고 돌려, 되돌리는 동안 새 답변이 파일을 함께 고치지 못하게 한다(그 사이
   * 보낸 요청은 끝난 뒤 이어서 돈다). 실패하면 참가자 모두에게 사유를 알린다.
   */
  export async function rollback(input: { sessionID: SessionID; sha: string }) {
    await SessionPrompt.exclusive(input.sessionID, () => restore(input)).catch(async (err) => {
      const code = reason(err)
      log.warn("rollback failed", { code, error: err instanceof Error ? err.message : String(err) })
      await Bus.publish(Event.Failed, { sessionID: input.sessionID, code })
    })
  }

  async function restore(input: { sessionID: SessionID; sha: string }) {
    const { session } = await verify(input)
    const messages = await Session.messages({ sessionID: input.sessionID })
    const locale = TurnSummary.latest(messages)?.user.locale ?? Locale.DEFAULT
    const label = LABEL[locale]
    const result = await History.restore(session.directory, {
      sha: input.sha,
      message: (target) => label.revert(target.subject),
      backup: label.backup,
      after: messages.at(-1)?.info.id,
    })
    if (result.changes.length === 0) {
      await Bus.publish(Event.Failed, { sessionID: input.sessionID, code: "same" })
      return
    }
    await Bus.publish(Event.Restored, {
      sessionID: input.sessionID,
      sha: result.sha,
      target: result.target.sha,
      subject: result.target.subject,
      files: result.changes.length,
      deps: result.changes.some((change) => MANIFESTS.has(path.posix.basename(change.file))),
    })
    void GitHub.sync(session.directory, locale).catch((err) => failed(err, input.sessionID))
  }
}
