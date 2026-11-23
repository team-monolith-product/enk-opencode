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
import { Question } from "@/question"
import type { QuestionID } from "@/question/schema"
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

  const MERGE: Record<
    Locale.Value,
    {
      backup: string
      marked: string
      merged: string
      prompt: (files: string[]) => string
      kept: (files: string[]) => string
    }
  > = {
    ko: {
      backup: "GitHub 변경 합치기 전 자동 저장",
      marked: "GitHub 변경을 가져와 겹친 곳 표시",
      merged: "GitHub에서 바뀐 내용 합치기",
      prompt: (files) =>
        [
          "GitHub 저장소에서 따로 바뀐 내용을 작업 폴더에 합쳤어요. 아래 파일은 같은 곳이 양쪽에서 바뀌어 충돌 표시가 남아 있어요.",
          files.map((file) => `- ${file}`).join("\n"),
          "충돌은 `<<<<<<<` 줄부터 `>>>>>>>` 줄까지예요. `=======` 위는 짓다에서 만든 내용이고, 아래는 GitHub에서 바뀐 내용이에요. 양쪽의 의도를 모두 살려 하나로 합치고, 충돌 표시 줄(`<<<<<<<`, `=======`, `>>>>>>>`)은 모두 지워 주세요. 목록에 없는 파일은 고치지 말고, 다 합친 뒤 무엇을 어떻게 합쳤는지 짧게 알려 주세요.",
        ].join("\n\n"),
      kept: (files) =>
        [
          "다음 파일은 자동으로 합칠 수 없어 한쪽 내용을 그대로 뒀어요. 고치지 않아도 돼요.",
          files.map((file) => `- ${file}`).join("\n"),
        ].join("\n"),
    },
    en: {
      backup: "Saved before merging GitHub changes",
      marked: "Brought in GitHub changes and marked the overlaps",
      merged: "Merge changes from GitHub",
      prompt: (files) =>
        [
          "Changes made separately in the GitHub repository were merged into the workspace. The files below were changed in the same places on both sides, so they still have conflict markers.",
          files.map((file) => `- ${file}`).join("\n"),
          "Each conflict runs from the `<<<<<<<` line to the `>>>>>>>` line. Above `=======` is what was made in Jitda, and below it is what changed on GitHub. Combine them so both sides' intent is kept, and remove every marker line (`<<<<<<<`, `=======`, `>>>>>>>`). Do not edit files outside this list. When you are done, briefly explain how you combined them.",
        ].join("\n\n"),
      kept: (files) =>
        [
          "These files could not be merged automatically, so one side was kept as is. They need no edits.",
          files.map((file) => `- ${file}`).join("\n"),
        ].join("\n"),
    },
  }

  /**
   * GitHub 과 겹친 변경을 AI 로 합친다. 세션을 붙잡은 채 GitHub 쪽 변경을 작업 폴더에 들이고(충돌 표시 포함), 충돌 표시를
   * 정리해 달라는 요청을 보낸다. 답변이 끝나면 평소처럼 기록되고 올라간다. 충돌 표시가 남은 파일이 없으면 바로 올린다.
   */
  export async function merge(input: { sessionID: SessionID; locale?: Locale.Value }) {
    const session = await Session.get(input.sessionID)
    await SessionPrompt.assertNotBusy(input.sessionID).catch(busy)
    const locale = input.locale ?? Locale.DEFAULT
    const label = MERGE[locale]
    const dir = session.directory
    if (!(await GitHub.conflictOf(dir))) throw new GitHub.Failure("clean", 409)
    if (merging.has(dir)) throw new EnkFailure("busy", 409)
    const finish: { done?: () => void } = {}
    merging.set(dir, new Promise<void>((done) => (finish.done = done)))
    const release = () => {
      merging.delete(dir)
      finish.done!()
    }
    const outcome: { result?: GitHub.Absorbed; error?: unknown } = {}
    await SessionPrompt.exclusive(input.sessionID, async () => {
      await GitHub.absorb(dir, { backup: label.backup, marked: label.marked }).then(
        (result) => (outcome.result = result),
        (error) => (outcome.error = error),
      )
    })
      .catch(busy)
      .catch((error) => {
        release()
        throw error
      })
    const clean = outcome.error instanceof GitHub.Failure && outcome.error.code === "clean"
    if (outcome.error && !clean) {
      release()
      throw outcome.error
    }
    if (clean || outcome.result!.files.length === 0) {
      await History.commit(dir, { message: label.merged })
        .then(() => GitHub.sync(dir, locale))
        .finally(release)
      return outcome.result
    }
    const result = outcome.result!
    const text = [label.prompt(result.files), ...(result.kept.length ? [label.kept(result.kept)] : [])].join("\n\n")
    await SessionPrompt.prompt({
      sessionID: input.sessionID,
      locale,
      noReply: true,
      parts: [{ type: "text", text }],
    }).catch((error) => {
      release()
      throw error
    })
    SessionPrompt.loop({ sessionID: input.sessionID })
      .catch((err) =>
        log.error("merge loop failed", {
          sessionID: input.sessionID,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      .finally(release)
    return result
  }

  const merging = new Map<string, Promise<void>>()

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
      const sessionID = evt.properties.sessionID
      await merging.get(dir)
      const turn = await TurnSummary.current(sessionID).catch(() => undefined)
      if (!turn) {
        const session = await Session.get(sessionID).catch(() => undefined)
        if (session && !session.parentID) await drain(dir, sessionID)
        return
      }
      const result = await serial(dir, async () => {
        await History.commit(dir, {
          message: (changes) => TurnSummary.describe(turn, changes),
          turn: turn.user.id,
        }).catch((err) => log.warn("save failed", { error: err instanceof Error ? err.message : String(err) }))
        return GitHub.sync(dir, turn.user.locale).catch((err) => {
          failed(err, sessionID)
          return undefined
        })
      })
      if (result?.conflict && !result.conflict.resolving && !result.conflict.queued) {
        void ask({ sessionID: evt.properties.sessionID, dir, conflict: result.conflict, locale: turn.user.locale })
      }
      await drain(dir, sessionID, turn.user.locale)
    })
    GitHub.onSettle((done) => void close(done))
    void drain(dir).catch((err) =>
      log.warn("queued choice skipped", { error: err instanceof Error ? err.message : String(err) }),
    )
  }

  const lanes = new Map<string, Promise<unknown>>()

  function serial<T>(dir: string, fn: () => Promise<T>) {
    const run = (lanes.get(dir) ?? Promise.resolve()).catch(() => undefined).then(fn)
    lanes.set(dir, run)
    return run
  }

  export type Chosen = { queued: boolean; pushed?: boolean; merged?: GitHub.Absorbed }

  export function choose(input: {
    dir: string
    choice: GitHub.Choose
    sessionID?: SessionID
    locale?: Locale.Value
  }): Promise<Chosen> {
    return serial(input.dir, async () => {
      if (!(await GitHub.conflictOf(input.dir))) throw new GitHub.Failure("clean", 409)
      if (await GitHub.working()) {
        await GitHub.queue(input.dir, input.choice, input.sessionID)
        return { queued: true }
      }
      return { queued: false, ...(await apply(input)) }
    })
  }

  async function apply(input: {
    dir: string
    choice: GitHub.Choose
    sessionID?: SessionID
    locale?: Locale.Value
  }): Promise<Omit<Chosen, "queued">> {
    if (input.choice === "ai") {
      if (!input.sessionID) throw new GitHub.Failure("busy", 409)
      return { merged: await merge({ sessionID: input.sessionID, locale: input.locale }) }
    }
    const result = await GitHub.resolve(input.dir, { prefer: input.choice, locale: input.locale })
    return { pushed: result.pushed }
  }

  const LATER = ["remote", "missing", "busy"]

  export async function drain(dir: string, sessionID?: SessionID, locale?: Locale.Value) {
    const conflict = await GitHub.conflictOf(dir)
    if (!conflict?.queued || (await GitHub.working())) return
    const target = await serial(dir, async () => {
      const now = await GitHub.conflictOf(dir)
      if (!now?.queued || (await GitHub.working())) return
      const owner = now.owner
        ? await Session.get(now.owner as SessionID).then(
            (session) => session.id,
            () => undefined,
          )
        : undefined
      const err =
        now.queued === "ai" && !owner
          ? new GitHub.Failure("unlinked", 409)
          : await apply({ dir, choice: now.queued, sessionID: owner, locale }).then(
              () => undefined,
              (error: unknown) => error,
            )
      if (!err) return
      log.warn("queued choice failed", { error: err instanceof Error ? err.message : String(err) })
      if (err instanceof EnkFailure && err.code === "clean") return
      if (err instanceof EnkFailure && LATER.includes(err.code)) return
      await GitHub.queue(dir)
      return owner ?? sessionID
    })
    if (!target) return
    const left = await GitHub.conflictOf(dir)
    if (left && !left.resolving) void ask({ sessionID: target, dir, conflict: left, locale, retry: true })
  }

  async function close(dir: string) {
    const id = asking.get(dir)
    if (!id) return
    const pending = (await Question.list()).find((item) => item.id === id)
    if (pending) await Question.reject(pending.id).catch(() => undefined)
  }

  const CHOICE: Record<
    Locale.Value,
    {
      header: string
      question: (files: string[], linking?: boolean) => string
      retry: string
      ai: GitHub.Choice
      theirs: GitHub.Choice
      ours: GitHub.Choice
    }
  > = {
    ko: {
      header: "GitHub 충돌",
      question: (files, linking) =>
        `${linking ? "연결한 GitHub 저장소에 있던 파일" : "GitHub에서 따로 바뀐 내용"}과 짓다에서 바뀐 내용이 같은 곳에서 겹쳐요. 어떻게 맞출까요? 고르기 전까지 짓다 내용은 따로 만든 브랜치에만 올라가 있어요.\n\n겹친 파일: ${files.join(", ")}`,
      retry: "앞서 고른 방식으로 맞추지 못했어요. 다시 골라 주세요.",
      ai: { label: "AI가 합치기", description: "양쪽 내용을 모두 살려 AI가 합친 뒤 올려요" },
      theirs: { label: "GitHub 기준", description: "겹친 곳은 GitHub 내용을 따르고, 나머지는 양쪽을 합쳐 올려요" },
      ours: { label: "짓다 기준", description: "겹친 곳은 짓다 내용을 따르고, 나머지는 양쪽을 합쳐 올려요" },
    },
    en: {
      header: "GitHub conflict",
      question: (files, linking) =>
        `${linking ? "Files already in the linked GitHub repository" : "Changes made separately on GitHub"} overlap with changes made in Jitda. How should they be lined up? Until you choose, Jitda's work is only on a separate branch.\n\nOverlapping files: ${files.join(", ")}`,
      retry: "The previous choice could not be applied. Please choose again.",
      ai: { label: "Let the AI merge", description: "The AI combines both sides, then it is pushed" },
      theirs: {
        label: "GitHub's side",
        description: "Overlaps follow GitHub; everything else from both sides is kept",
      },
      ours: { label: "Jitda's side", description: "Overlaps follow Jitda; everything else from both sides is kept" },
    },
  }

  const asking = new Map<string, QuestionID | undefined>()

  /**
   * 대화가 끝나 올리다 GitHub 와 겹치면 바로 대화창에 고를 거리를 띄운다. 질문 창이 떠 있는 동안 다음 대화는 시작되지
   * 않는다. 같은 폴더에 이미 떠 있으면 다시 띄우지 않는다.
   */
  export async function ask(input: {
    sessionID: SessionID
    dir: string
    conflict: GitHub.Conflict
    locale?: Locale.Value
    retry?: boolean
  }) {
    if (asking.has(input.dir)) return
    asking.set(input.dir, undefined)
    const locale = input.locale ?? Locale.DEFAULT
    const text = CHOICE[locale]
    const options = [text.ai, text.theirs, text.ours]
    const unsub = Bus.subscribe(Question.Event.Asked, (evt) => {
      if (evt.properties.sessionID === input.sessionID && evt.properties.questions[0]?.header === text.header) {
        const id = evt.properties.id
        asking.set(input.dir, id)
        void GitHub.conflictOf(input.dir)
          .then((left) => (left ? undefined : Question.reject(id)))
          .catch(() => undefined)
      }
    })
    const answers = await Question.ask({
      sessionID: input.sessionID,
      questions: [
        {
          header: text.header,
          question:
            (input.retry ? `${text.retry}\n\n` : "") + text.question(input.conflict.files, input.conflict.linking),
          options,
          custom: false,
        },
      ],
    })
      .catch(() => undefined)
      .finally(() => {
        unsub()
        asking.delete(input.dir)
      })
    const picked = answers?.[0]?.[0]
    const choice: GitHub.Choose | undefined =
      picked === text.ai.label
        ? "ai"
        : picked === text.theirs.label
          ? "theirs"
          : picked === text.ours.label
            ? "ours"
            : undefined
    if (!choice) return
    await choose({ dir: input.dir, choice, sessionID: input.sessionID, locale }).catch(async (err) => {
      failed(err, input.sessionID)
      if (err instanceof GitHub.Failure && err.code === "clean") return
      const conflict = await GitHub.conflictOf(input.dir)
      if (conflict && !conflict.resolving) await ask({ ...input, conflict, retry: true })
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
    const messages = await TurnSummary.recent(input.sessionID)
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
