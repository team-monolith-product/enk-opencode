import type { Plugin } from "@opencode/plugin"
import path from "node:path"
import { EnkFailure, refusal } from "./failure"
import { GitHub } from "./github"
import { History } from "./history"
import { HistoryNote } from "./history-note"
import type { Locale } from "./locale"
import * as Definitions from "./rpc"
import { ServeTargets } from "./serve-targets"
import { SessionActivity } from "./session-activity"
import { TurnSummary } from "./turn"

// 대화가 끝날 때마다 버전을 남기고 GitHub 에 올리며, 합의된 되돌리기를 실행한다.

type Context = Plugin.Context
type Event = { type: string; location?: { directory?: string }; data?: { sessionID?: string } }
type Rollback = { sessionID: string; sha: string }
type Session = { parentID?: string; revert?: unknown }

const REVERT = { ko: "되돌리기: ", en: "Roll back to: " } as const

// 되돌리기 커밋으로 다시 되돌릴 때 제목이 "되돌리기: 되돌리기: …" 로 겹치지 않게 앞의 접두어를 걷어 낸다.
function plain(subject: string) {
  for (;;) {
    const prefix = Object.values(REVERT).find((item) => subject.startsWith(item))
    if (!prefix) return subject
    subject = subject.slice(prefix.length)
  }
}

const LABEL = {
  ko: { revert: (subject: string) => `${REVERT.ko}${plain(subject)}`, backup: "되돌리기 전 자동 저장" },
  en: { revert: (subject: string) => `${REVERT.en}${plain(subject)}`, backup: "Saved before rolling back" },
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
// staged 는 메시지 되돌리기가 걸려 있을 때다. 그 취소(redo)가 되돌린 파일을 다시 덮어쓰므로 먼저 끝내게 한다.
export const REFUSALS = ["missing", "busy", "staged"] as const

function reason(error: unknown) {
  if (!(error instanceof EnkFailure)) return "failed"
  return REFUSALS.find((code) => code === error.code) ?? "failed"
}

// 되돌리는 동안 새 답변이 파일을 함께 고치지 못하게 모델 호출을 세워 둔다(그 사이 보낸 요청은 끝난 뒤 이어서 돈다).
export function createGate() {
  let gate: Promise<void> = Promise.resolve()
  return {
    hold: async <T>(work: () => Promise<T>) => {
      const previous = gate
      let release!: () => void
      gate = new Promise((resolve) => (release = resolve))
      await previous
      return work().finally(release)
    },
    pass: async () => {
      for (let seen: Promise<void> | undefined; seen !== gate; ) {
        seen = gate
        await seen
      }
    },
  }
}

export function create(
  ctx: Context,
  emit: (name: "restored" | "failed", data: Record<string, unknown>) => Promise<unknown>,
) {
  const directory = ctx.location.directory
  const gate = createGate()
  const sessions = new Set<string>()

  // 투표를 열기 전과 되돌리기 직전에 같은 조건을 본다. 기록에 있는 버전인지는 git 저장소만 보고 판단한다.
  const verify = async (input: Rollback) => {
    const session = (await ctx.session.get({ sessionID: input.sessionID })) as unknown as Session
    if (!ServeTargets.isProject(directory)) throw new History.Failure("disabled", 404)
    const target = await History.entry(directory, input.sha)
    if (!target) throw new History.Failure("missing", 404)
    if (session.revert) throw new EnkFailure("staged", 409)
    if (SessionActivity.has(directory, input.sessionID)) throw new EnkFailure("busy", 409)
    return target
  }

  const restore = async (input: Rollback) => {
    await verify(input)
    const messages = (await ctx.session.context({ sessionID: input.sessionID })) as unknown as TurnSummary.Message[]
    const locale: Locale.Locale = TurnSummary.latest(messages)?.locale ?? "ko"
    const label = LABEL[locale === "ko" ? "ko" : "en"]
    const result = await History.restore(directory, {
      sha: input.sha,
      message: (target) => label.revert(target.subject),
      backup: label.backup,
      after: messages.at(-1)?.id,
    })
    if (result.changes.length === 0) {
      await emit("failed", { sessionID: input.sessionID, code: "same" })
      return
    }
    await emit("restored", {
      sessionID: input.sessionID,
      sha: result.sha,
      target: result.target.sha,
      subject: result.target.subject,
      files: result.changes.length,
      deps: result.changes.some((change) => MANIFESTS.has(path.posix.basename(change.file))),
    })
    void GitHub.sync(directory, locale).catch((error) => GitHub.failed(error, input.sessionID))
  }

  // 합의된 되돌리기. 실패하면 참가자 모두에게 사유를 알린다.
  const rollback = (input: Rollback) =>
    gate
      .hold(() => restore(input))
      .catch(async (error) => {
        const code = reason(error)
        console.warn("[jitda.history] rollback failed", { code, error: String(error) })
        await emit("failed", { sessionID: input.sessionID, code })
      })

  const finished = async (sessionID: string) => {
    const turn = await TurnSummary.current(ctx, sessionID).catch(() => undefined)
    if (!turn) return
    await History.commit(directory, {
      message: (changes) => TurnSummary.describe(ctx, turn, changes),
      turn: turn.id,
    }).catch((error) => console.warn("[jitda.history] save failed", String(error)))
    await GitHub.sync(directory, turn.locale).catch((error) => GitHub.failed(error, sessionID))
  }

  const observe = (event: Event) => {
    const sessionID = event.data?.sessionID
    if (!sessionID) return
    if (event.location) {
      if (event.location.directory !== directory) return
      sessions.add(sessionID)
    } else if (!sessions.has(sessionID) && !SessionActivity.has(directory, sessionID)) return
    switch (event.type) {
      case "session.execution.started":
        SessionActivity.start(directory, sessionID)
        return
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        SessionActivity.finish(directory, sessionID)
        void finished(sessionID).catch((error) => GitHub.failed(error, sessionID))
        return
    }
  }

  const note = async (sessionID: string) => {
    const revert = await History.lastRevert(directory)
    if (!revert?.after) return
    return HistoryNote.text(revert, (await ctx.session.context({ sessionID })) as unknown as HistoryNote.Message[])
  }

  return { gate, verify, rollback, observe, note, finished }
}

export const Rpc = Definitions.History

const reject = (error: unknown) => {
  if (!(error instanceof EnkFailure)) throw error
  if (error.status === 500) GitHub.alert("history request failed", error)
  return refusal(error)
}

export async function start(ctx: Context) {
  const directory = ctx.location.directory
  const emit = async (name: "restored" | "failed", data: Record<string, unknown>) => {
    await registration.events.emit(name, data)
  }
  const sync = create(ctx, emit)
  const registration = await ctx.rpc.register(Rpc, {
    list: async () => {
      if (!ServeTargets.isProject(directory)) return { enabled: false, entries: [] }
      return JSON.parse(JSON.stringify({ enabled: true, entries: await History.list(directory) }))
    },
    changes: async (input) => {
      const { sha } = input as { sha: string }
      return History.changes(directory, sha)
        .then((changes) => ({ changes }))
        .catch(reject)
    },
    check: async (input) => {
      const target = await sync.verify(input as Rollback).catch(reject)
      if ("error" in target) return target
      return { target: { subject: target.subject, time: target.time } }
    },
    rollback: async (input) => {
      await sync.rollback(input as Rollback)
      return {}
    },
  })

  const hook = await ctx.session.hook("context", async (event) => {
    await sync.gate.pass()
    SessionActivity.start(directory, event.sessionID)
    const text = await sync.note(event.sessionID).catch(() => undefined)
    if (text) event.system.push({ type: "text", text })
  })

  const controller = new AbortController()
  void (async () => {
    while (!controller.signal.aborted) {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) sync.observe(event as Event)
      } catch {
        if (controller.signal.aborted) return
      }
      SessionActivity.reset(directory)
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  })()

  return async () => {
    controller.abort()
    await hook.dispose()
    await registration.dispose()
  }
}

export * as HistorySync from "./history-sync"
