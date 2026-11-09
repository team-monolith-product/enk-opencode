import { writeFile } from "fs/promises"
import path from "path"
import { Log } from "../util/log"
import { EnkFailure } from "./failure"
import { ServeTargets } from "./serve-targets"
import { WorkspaceRepo } from "./workspace-repo"

/**
 * 팀 작업 폴더의 버전 기록. 되돌리기는 기록을 지우지 않는다. 고른 시점의 트리로 작업 폴더를 맞춘 뒤 그 트리를
 * 새 커밋으로 앞에 쌓으므로, 되돌린 것도 다시 되돌릴 수 있다.
 */
export namespace History {
  const log = Log.create({ service: "history" })
  const who = {
    GIT_AUTHOR_NAME: "Jitda",
    GIT_AUTHOR_EMAIL: "jitda@localhost",
    GIT_COMMITTER_NAME: "Jitda",
    GIT_COMMITTER_EMAIL: "jitda@localhost",
  }
  const Trailer = {
    message: "Jitda-Message",
    revert: "Jitda-Revert-Of",
    after: "Jitda-After",
    skipped: "Jitda-Skipped",
  } as const
  const SKIPPED_MAX = 50

  export type Change = WorkspaceRepo.Change
  /** 기록에 담지 못한 큰 파일은 지워진 것처럼 보이므로 "L" 로 따로 알린다. */
  export type Listed = { status: Change["status"] | "L"; file: string }
  export type Entry = { sha: string; time: number; subject: string; revert?: string }
  export type Saved = { sha: string; message: string; changes: Change[]; skipped: string[] }
  export type Restored = { sha: string; target: Entry; changes: Change[] }
  export type Revert = { subject: string; after?: string }
  export type Code = "disabled" | "missing"

  export class Failure extends EnkFailure<Code> {}

  function trailers(values: Record<string, string | undefined>) {
    const lines = Object.entries(values).flatMap(([key, value]) => (value ? [`${key}: ${value}`] : []))
    return lines.length ? `\n\n${lines.join("\n")}` : ""
  }

  /** 인덱스에 올라 있는 그대로 커밋한다. */
  async function commitIndex(repo: WorkspaceRepo.Repo, message: string) {
    await repo.must(["commit", "--quiet", "--no-verify", "--no-gpg-sign", "-m", message], { env: who })
    return (await WorkspaceRepo.rev(repo, WorkspaceRepo.HEAD))!
  }

  async function recorded(repo: WorkspaceRepo.Repo, turn: string) {
    if (!(await WorkspaceRepo.rev(repo, WorkspaceRepo.HEAD))) return false
    const out = await repo.must([
      "log",
      "-n50",
      `--format=%(trailers:key=${Trailer.message},valueonly,separator=)`,
      WorkspaceRepo.HEAD,
    ])
    return out.split("\n").some((line) => line.trim() === turn)
  }

  async function save(
    repo: WorkspaceRepo.Repo,
    input: { message: string | ((changes: Change[]) => Promise<string>); turn?: string },
  ): Promise<Saved | undefined> {
    if (input.turn && (await recorded(repo, input.turn))) return
    const staged = await WorkspaceRepo.stage(repo)
    const parent = await WorkspaceRepo.rev(repo, WorkspaceRepo.HEAD)
    if (!parent && staged.empty) return
    if (parent && staged.tree === (await WorkspaceRepo.rev(repo, `${parent}^{tree}`))) return
    const changes = await WorkspaceRepo.diff(repo, parent ? `${parent}^{tree}` : undefined, staged.tree)
    const message = typeof input.message === "string" ? input.message : await input.message(changes)
    const skipped = staged.skipped.length ? JSON.stringify(staged.skipped.slice(0, SKIPPED_MAX)) : undefined
    const sha = await commitIndex(
      repo,
      message + trailers({ [Trailer.message]: input.turn, [Trailer.skipped]: skipped }),
    )
    return { sha, message, changes, skipped: staged.skipped }
  }

  /** 대화 한 턴이 끝난 작업 폴더를 남긴다. 바뀐 게 없거나 그 턴을 이미 남겼으면 아무것도 하지 않는다. */
  export async function commit(
    dir: string,
    input: { message: string | ((changes: Change[]) => Promise<string>); turn?: string },
  ) {
    if (!ServeTargets.isProject(dir)) return
    const repo = WorkspaceRepo.open(dir)
    const saved = await repo.lock(() => save(repo, input))
    if (saved) log.info("saved", { sha: saved.sha, files: saved.changes.length })
    return saved
  }

  type Logged = Entry & { after?: string }

  async function read(repo: WorkspaceRepo.Repo, args: string[]): Promise<Logged[]> {
    const field = (key: string) => `%(trailers:key=${key},valueonly,separator=)`
    const format = `%H%x1f%ct%x1f%s%x1f${field(Trailer.revert)}%x1f${field(Trailer.after)}%x1e`
    const out = await repo.must(["log", `--format=${format}`, ...args])
    return out
      .split("\x1e")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [sha, time, subject, revert, after] = line.split("\x1f")
        return {
          sha: sha!,
          time: Number(time) * 1000,
          subject: subject ?? "",
          revert: revert?.trim() || undefined,
          after: after?.trim() || undefined,
        }
      })
  }

  export async function list(dir: string, max = 200): Promise<Entry[]> {
    if (!ServeTargets.isProject(dir)) return []
    const repo = WorkspaceRepo.open(dir)
    if (!(await WorkspaceRepo.rev(repo, WorkspaceRepo.HEAD))) return []
    return (await read(repo, [`-n${max}`, WorkspaceRepo.HEAD])).map(({ after: _, ...entry }) => entry)
  }

  async function reachable(repo: WorkspaceRepo.Repo, sha: string) {
    if (!/^[0-9a-f]{40}$/.test(sha)) return false
    if ((await repo.run(["cat-file", "-e", `${sha}^{commit}`])).exitCode !== 0) return false
    return (await repo.run(["merge-base", "--is-ancestor", sha, WorkspaceRepo.HEAD])).exitCode === 0
  }

  /** 기록에 있는 시점이면 그 시점을, 아니면 undefined. */
  export async function entry(dir: string, sha: string): Promise<Entry | undefined> {
    if (!ServeTargets.isProject(dir)) return
    const repo = WorkspaceRepo.open(dir)
    if (!(await reachable(repo, sha))) return
    const [found] = await read(repo, ["-1", sha])
    return found && { sha: found.sha, time: found.time, subject: found.subject, revert: found.revert }
  }

  /** 그 시점에 무엇이 바뀌었는지(직전 기록과 비교). */
  function skippedFiles(raw: string): string[] {
    try {
      const list: unknown = raw.trim() ? JSON.parse(raw.trim()) : []
      return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []
    } catch {
      return []
    }
  }

  export async function changes(dir: string, sha: string) {
    if (!ServeTargets.isProject(dir)) throw new Failure("disabled", 404)
    const repo = WorkspaceRepo.open(dir)
    if (!(await reachable(repo, sha))) throw new Failure("missing", 404)
    const parent = await WorkspaceRepo.rev(repo, `${sha}^`)
    const changes = await WorkspaceRepo.diff(repo, parent && `${parent}^{tree}`, `${sha}^{tree}`)
    const raw = await repo.must(["log", "-1", `--format=%(trailers:key=${Trailer.skipped},valueonly,separator=)`, sha])
    const skipped = new Set<string>(skippedFiles(raw))
    return changes.map(
      (change): Listed => (change.status === "D" && skipped.has(change.file) ? { ...change, status: "L" } : change),
    )
  }

  const reverts = new Map<string, Revert | null>()

  /** 가장 최근 되돌리기. 매 스텝 묻는 값이라 프로세스 안에 들고 있고, 처음 한 번만 기록을 읽는다. */
  export async function lastRevert(dir: string): Promise<Revert | undefined> {
    if (!ServeTargets.isProject(dir)) return
    const repo = WorkspaceRepo.open(dir)
    if (!reverts.has(repo.root)) {
      const head = await WorkspaceRepo.rev(repo, WorkspaceRepo.HEAD)
      const found = head ? (await read(repo, ["-n50", head])).find((item) => item.revert) : undefined
      reverts.set(repo.root, found ? { subject: found.subject, after: found.after } : null)
    }
    return reverts.get(repo.root) ?? undefined
  }

  /**
   * 작업 폴더를 `sha` 시점으로 되돌린다. `git restore --source` 로 그 시점의 파일로 한 번에 맞추고(없는 파일은
   * 지운다) `git commit` 하나로 남기므로, 몇 턴 전이든 걸리는 시간이 같고 기록은 앞으로만 쌓인다. 마지막 기록 뒤에 바뀐 파일(업로드·직접
   * 편집)이 있으면 먼저 기록해 두고, 기록에서 빠진 파일(.env·node_modules·큰 파일)은 건드리지 않는다. `after` 는
   * 되돌린 시점의 마지막 메시지로, 그 뒤 첫 답변에만 되돌렸다는 안내를 붙이는 기준이 된다.
   */
  export async function restore(
    dir: string,
    input: { sha: string; message: (target: Entry) => string; backup: string; after?: string },
  ): Promise<Restored> {
    if (!ServeTargets.isProject(dir)) throw new Failure("disabled", 404)
    const repo = WorkspaceRepo.open(dir)
    return repo.lock(async () => {
      if (!(await reachable(repo, input.sha))) throw new Failure("missing", 404)
      await save(repo, { message: input.backup })
      const parent = (await WorkspaceRepo.rev(repo, WorkspaceRepo.HEAD))!
      const goal = (await WorkspaceRepo.rev(repo, `${input.sha}^{tree}`))!
      let changes = await WorkspaceRepo.diff(repo, `${parent}^{tree}`, goal)
      const [found] = await read(repo, ["-1", input.sha])
      const target: Entry = { sha: input.sha, time: found!.time, subject: found!.subject }
      if (changes.length === 0) return { sha: parent, target, changes }
      const added = changes.filter((change) => change.status === "A").map((change) => change.file)
      const kept = await WorkspaceRepo.unrecorded(repo, added)
      const spec = path.join(repo.root, "restore-pathspec")
      await writeFile(spec, [".", ...kept.map((file) => `:(exclude,literal)${file}`)].join("\0"))
      await repo.must([
        "restore",
        `--source=${input.sha}`,
        "--staged",
        "--worktree",
        `--pathspec-from-file=${spec}`,
        "--pathspec-file-nul",
      ])
      if (kept.length > 0) {
        changes = await WorkspaceRepo.diff(repo, `${parent}^{tree}`, (await repo.must(["write-tree"])).trim())
        if (changes.length === 0) return { sha: parent, target, changes }
      }
      const message = input.message(target)
      const sha = await commitIndex(
        repo,
        message + trailers({ [Trailer.revert]: input.sha, [Trailer.after]: input.after }),
      )
      reverts.set(repo.root, { subject: message, after: input.after })
      log.info("restored", { sha, target: input.sha, files: changes.length })
      return { sha, target, changes }
    })
  }
}
