import { Database, and, desc, eq, gt, inArray, sql } from "@/storage/db"
import { Log } from "@/util/log"
import { MessageTable, RunLinkTable } from "./session.sql"
import type { MessageID, SessionID } from "./schema"

/**
 * Which AI run each user message belongs to.
 *
 * A run starts from one user message (its anchor) and can read more while it goes: a steer, a
 * consented send that lands mid-run, or a message the run made itself (auto-compaction, a subtask
 * summary). Usage is recorded once per run, so those messages are linked to the anchor here, by the
 * run loop, at the moment it reads them — before any answer to them exists.
 *
 * Ordering is by SQLite rowid, which follows insertion order, never by timestamp: message times come
 * from different paths (and from a wall clock that can be stepped back), so they cannot be trusted to
 * say what was stored first. Rowids are handed out as max + 1, and nothing older than a running
 * run's anchor is deleted while it runs.
 */
export namespace RunLink {
  const log = Log.create({ service: "session.run-link" })

  // An anchor chain longer than this means corrupt links — stop rather than loop.
  const MAX_DEPTH = 16
  // How far back (in a session's newest rows) a run's start looks for the last answer.
  const START_WINDOW = 500

  type Role = { role?: string; parentID?: string }

  /**
   * The session's newest message rowid. "Stored after this point" is then a rowid comparison. Scoped to
   * the session on purpose: SQLite hands out max + 1, so once the table's newest rows are deleted (another
   * session removed) a new row can get a rowid at or below a table-wide mark taken earlier. The session's
   * own newest row is not deleted while it runs, so every message stored later in it is above this mark.
   */
  export function lastRow(sessionID: SessionID) {
    return (
      Database.use((db) =>
        db
          .select({ row: sql<number | null>`max(rowid)` })
          .from(MessageTable)
          .where(eq(MessageTable.session_id, sessionID))
          .get(),
      )?.row ?? 0
    )
  }

  /**
   * Where a run read up to: the session's newest message, by rowid and by id. The id is what makes the
   * mark safe to keep between runs — if that message is deleted (a revert truncates history), SQLite can
   * hand its rowid to a later message, and a bare rowid would then call new prompts already read.
   */
  export type Mark = { row: number; id?: MessageID }

  export function mark(sessionID: SessionID): Mark {
    const newest = Database.use((db) =>
      db
        .select({ id: MessageTable.id, row: sql<number>`rowid` })
        .from(MessageTable)
        .where(eq(MessageTable.session_id, sessionID))
        .orderBy(desc(sql`rowid`))
        .limit(1)
        .get(),
    )
    return newest ? { row: newest.row, id: newest.id } : { row: 0 }
  }

  export function rowOf(db: Database.TxOrDb, messageID: string) {
    return db
      .select({ row: sql<number>`rowid` })
      .from(MessageTable)
      .where(eq(MessageTable.id, messageID as MessageID))
      .get()?.row
  }

  /**
   * The message that started the run `messageID` belongs to (itself when it started one). Links are
   * stored already resolved, so this is normally one step; it still follows a chain — and stops on a
   * cycle or an absurd depth — so a link written by some future path cannot split a run silently.
   */
  export function anchorOf(db: Database.TxOrDb, messageID: string) {
    let current = messageID
    const seen = new Set([current])
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const next = db
        .select({ anchor: RunLinkTable.anchor_user_message_id })
        .from(RunLinkTable)
        .where(eq(RunLinkTable.user_message_id, current as MessageID))
        .get()?.anchor
      if (!next) return current
      if (seen.has(next)) {
        log.warn("run link cycle", { messageID, at: next })
        return current
      }
      seen.add(next)
      current = next
    }
    log.warn("run link chain too deep", { messageID })
    return current
  }

  /** The messages linked into the run anchored at `anchorID`, with their replay marker. */
  export function members(db: Database.TxOrDb, anchorID: string) {
    return db
      .select({ id: RunLinkTable.user_message_id, replay: RunLinkTable.replay })
      .from(RunLinkTable)
      .where(eq(RunLinkTable.anchor_user_message_id, anchorID as MessageID))
      .all()
  }

  /**
   * Record that the run anchored at `anchorID` read `messageID`. The anchor is resolved first, so a
   * run that restarts for a message which already joined an earlier run keeps feeding that run. The
   * first run to read a message owns it, and a message that already anchors other messages is never
   * linked: re-pointing it would leave its members behind in a run of their own.
   */
  export function link(input: { sessionID: SessionID; messageID: MessageID; anchorID: MessageID; replay?: boolean }) {
    Database.use((db) => {
      const anchor = anchorOf(db, input.anchorID)
      if (anchor === input.messageID) return
      const leads = db
        .select({ id: RunLinkTable.user_message_id })
        .from(RunLinkTable)
        .where(eq(RunLinkTable.anchor_user_message_id, input.messageID))
        .get()
      if (leads) {
        log.warn("refused to link a run's anchor into another run", { messageID: input.messageID, anchor })
        return
      }
      db.insert(RunLinkTable)
        .values({
          user_message_id: input.messageID,
          anchor_user_message_id: anchor as MessageID,
          replay: input.replay ?? false,
          session_id: input.sessionID,
          time_created: Date.now(),
        })
        .onConflictDoNothing()
        .run()
    })
  }

  /**
   * A forked session clones messages under new ids. Carry over the run a cloned user message belonged
   * to (and its replay marker), remapped to the clone's ids. The anchor is older than the message, so
   * a fork that includes the message has already cloned the anchor; if not, the clone anchors itself.
   */
  export function clone(input: {
    sessionID: SessionID
    fromMessageID: string
    toMessageID: MessageID
    idMap: ReadonlyMap<string, string>
  }) {
    Database.use((db) => {
      const row = db
        .select()
        .from(RunLinkTable)
        .where(eq(RunLinkTable.user_message_id, input.fromMessageID as MessageID))
        .get()
      if (!row) return
      const anchor = input.idMap.get(row.anchor_user_message_id)
      if (!anchor) return
      db.insert(RunLinkTable)
        .values({
          user_message_id: input.toMessageID,
          anchor_user_message_id: anchor as MessageID,
          replay: row.replay,
          session_id: input.sessionID,
          time_created: Date.now(),
        })
        .onConflictDoNothing()
        .run()
    })
  }

  /**
   * Where a run that is starting now begins: the oldest user message stored after the session's last
   * answer (the first run read takes in every prompt that was waiting, and only the newest gets an
   * answer — anchoring on the newest would drop the others from the record). Falls back to
   * `fallback`, the message the loop is about to answer.
   *
   * `read` is where the session's previous run last read. A prompt stored up to there was already read
   * by that run, and if it has no answer it is because that run was stopped or failed before answering
   * — not a prompt waiting for this run. Starting from it would date this run (its start time and TTFT)
   * from that old prompt. With that mark the waiting prompts are exactly the ones stored after it that no
   * run took in (no link) and nothing answered — looked for past the last answer too: a prompt stored
   * while the previous run's last read was in flight sits before that run's final answer, and stopping
   * at the answer would leave it in no run at all. The search still stops at a prompt that was answered
   * after the mark (a shell command): that one settled itself and everything before it. A mark whose
   * message is gone (history truncated since) says nothing about what is stored now, so it is ignored,
   * and the last answer bounds the search instead.
   */
  export function start(sessionID: SessionID, fallback: MessageID, read?: Mark) {
    return Database.use((db) => {
      const after = read && (!read.id || rowOf(db, read.id) === read.row) ? read.row : undefined
      const recent = db
        .select({ id: MessageTable.id, data: MessageTable.data, row: sql<number>`rowid` })
        .from(MessageTable)
        .where(eq(MessageTable.session_id, sessionID))
        .orderBy(desc(sql`rowid`))
        .limit(START_WINDOW)
        .all()
      let first: { id: MessageID; row: number } | undefined
      if (after === undefined) {
        for (const item of recent) {
          if ((item.data as Role).role === "assistant") break
          if ((item.data as Role).role === "user") first = { id: item.id, row: item.row }
        }
      } else {
        // Newest first. A prompt that got its own answer after the mark (a shell command) was settled on its
        // own, and so was everything stored before it — the search stops there, as the path without a mark
        // stops at the last answer; otherwise this run would take that prompt in and swallow its record.
        const answered = new Set<string>()
        const users: typeof recent = []
        for (const item of recent) {
          if (item.row <= after) break
          const data = item.data as Role
          if (data.role === "assistant") {
            if (data.parentID) answered.add(data.parentID)
            continue
          }
          if (data.role !== "user") continue
          if (answered.has(item.id)) break
          users.push(item)
        }
        const linked = new Set<string>(
          users.length === 0
            ? []
            : db
                .select({ id: RunLinkTable.user_message_id })
                .from(RunLinkTable)
                .where(inArray(RunLinkTable.user_message_id, users.map((item) => item.id)))
                .all()
                .map((item) => item.id),
        )
        for (const item of users) if (!linked.has(item.id)) first = { id: item.id, row: item.row }
      }
      if (first) return first
      return { id: fallback, row: rowOf(db, fallback) ?? lastRow(sessionID) }
    })
  }

  /**
   * User messages of the session stored after `afterRow`, in the order they were stored, and the newest
   * rowid looked at (`last`) — pass it back as `afterRow` next time so a long run never re-reads the rows
   * it has already been through.
   *
   * `read`: the step's read — the mark taken just before it (`row`) and the messages it returned (`ids`).
   * The table can gain a prompt while the read is in flight; one stored past the mark that the read did
   * not return is not part of what the run read, so the scan stops in front of it (and `last` stays
   * before it) — the next step that reads it links it, and if no step does, it starts a run of its own.
   * Rows up to the mark are always taken: one missing from the read was hidden by compaction, not unread.
   */
  export function arrivals(
    sessionID: SessionID,
    afterRow: number,
    read?: { row: number; ids: ReadonlySet<string> },
  ) {
    const rows = Database.use((db) =>
      db
        .select({ id: MessageTable.id, data: MessageTable.data, row: sql<number>`rowid` })
        .from(MessageTable)
        .where(and(gt(sql`rowid`, afterRow), eq(MessageTable.session_id, sessionID)))
        .orderBy(sql`rowid`)
        .all(),
    )
    const ids: MessageID[] = []
    let last = afterRow
    for (const item of rows) {
      if ((item.data as Role).role === "user") {
        if (read && item.row > read.row && !read.ids.has(item.id)) break
        ids.push(item.id)
      }
      last = item.row
    }
    return { ids, last }
  }

  /**
   * Whether a user message someone asked to have answered is still unread: stored after the run's
   * last read (`readAt`) and no later than the latest loop() call (`wantedAt` — a noReply prompt
   * stored after it asked for no answer), with no answer since. A failed answer counts as an answer,
   * so a failed prompt is not retried by itself.
   */
  export function unread(sessionID: SessionID, readAt: number, wantedAt: number) {
    if (!Number.isFinite(readAt) || wantedAt <= readAt) return false
    const rows = Database.use((db) =>
      db
        .select({ id: MessageTable.id, data: MessageTable.data, row: sql<number>`rowid` })
        .from(MessageTable)
        .where(and(gt(sql`rowid`, readAt), eq(MessageTable.session_id, sessionID)))
        .all(),
    )
    const answered = new Set(rows.flatMap((row) => ((row.data as Role).role === "assistant" ? [(row.data as Role).parentID] : [])))
    return rows.some((row) => (row.data as Role).role === "user" && row.row <= wantedAt && !answered.has(row.id))
  }
}
