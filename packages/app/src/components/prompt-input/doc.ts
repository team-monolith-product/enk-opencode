import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import type { OpencodeClient, SessionActor } from "@opencode-ai/sdk/v2/client"
import { createPage, type DocActor } from "@/components/blocksuite/blocksuite-doc"
import type { FileNodeType } from "@/components/blocksuite/file-reference-block"
import type { LineRefInput } from "@/components/blocksuite/line-reference-url"
import type { DocSyncOpts } from "@/components/blocksuite/opencode-doc-source"
import { label } from "@/components/blocksuite/actor"
import { clearActor, loadActor, saveActor } from "./doc-actor"
import { MAX_ATTACHMENT_BYTES } from "@/constants/file-picker"

type DocHandle = Awaited<ReturnType<typeof createPage>>

export type PromptDocConfig = {
  sessionID: string | undefined
  url: string
  directory: string
  submitKey?: string
  user?: { id: string; name: string; color?: string }
  // A `?readonly=true` viewer is a pure observer: the editor mounts read-only and we never register a
  // server actor, broadcast awareness, or open the submit socket — so this client is excluded from the
  // collaborative roster (동시편집 presence) and consensus targets (동시전송) entirely.
  readonly?: boolean
}

export type PromptDocInput = {
  config: PromptDocConfig
  client: OpencodeClient
  onSubmit: () => void
}

// Bootstrap requests (actor registration + prompt doc lookup) run before the sync layer exists, so a
// server that is unavailable at page load would otherwise leave the editor permanently uninitialized
// — the mounting effect only re-runs on session change, not when the server comes back. Retry with
// exponential backoff until it succeeds or `alive()` reports the attempt has been superseded.
async function withRetry<T>(alive: (() => boolean) | undefined, task: () => Promise<T>): Promise<T> {
  let delay = 500
  for (;;) {
    try {
      return await task()
    } catch (err) {
      if (alive && !alive()) throw err
      await new Promise<void>((r) => setTimeout(r, delay))
      if (alive && !alive()) throw err
      delay = Math.min(delay * 2, 8000)
    }
  }
}

async function register(input: PromptDocInput, sessionID: string, alive?: () => boolean) {
  const user = input.config.user
  // With a ?user= param the identity is keyed by that user id (stable per user, distinct across
  // users); without it, per tab. We never force a tab/browser-stored actorID onto a user-scoped
  // identity — that would merge two different users into one. The server also de-dupes by user id.
  const stored = loadActor(sessionID, user?.id)
  const actor = await withRetry(alive, async () => {
    const res = await input.client.session.actor.upsert({
      sessionID,
      directory: input.config.directory,
      ...(stored ? { actorID: stored } : {}),
      ...(user ? { userID: user.id, name: user.name } : {}),
      ...(user?.color ? { color: user.color } : {}),
    })
    const value = res.data as SessionActor | undefined
    if (!value) throw new Error("actor registration failed")
    return value
  })
  saveActor(sessionID, actor.actorID, user?.id)
  return actor
}

async function promptDoc(input: PromptDocInput, sessionID: string, alive?: () => boolean) {
  return withRetry(alive, async () => {
    const res = await input.client.session.promptDoc({ sessionID, directory: input.config.directory })
    if (!res.data?.docID) throw new Error("prompt doc lookup failed")
    return res.data
  })
}

export function createPromptDoc(input: PromptDocInput) {
  const clientID = crypto.randomUUID()
  // Stable local-only identity for a readonly viewer. Never sent to the server (no actor.upsert) and
  // never broadcast. It fills the local sync object's actorID and is used to open the observer-only
  // submit socket, whose route validates ActorID.zod (`startsWith("act")`) — hence the `act` prefix.
  const viewerActorID = `act${clientID.replace(/-/g, "")}`
  let handle: DocHandle | undefined
  let theme: "light" | "dark" | undefined
  let sync: DocSyncOpts | undefined
  let init = true
  let historySub: { dispose: () => void } | undefined
  let mounted: HTMLElement | undefined
  let session: string | undefined
  let live: string | undefined

  // Every operation that builds or replaces the editor handle runs through one serialized lane, so
  // they never interleave. Each call gets a generation token; after each await it checks `alive()`
  // and bails if a newer intent has superseded it. This single mechanism replaces the scattered
  // seq/mark/pending and `mounted !== el` race guards.
  let lane: Promise<unknown> = Promise.resolve()
  let generation = 0

  const serialize = <T>(task: (alive: () => boolean) => Promise<T>): Promise<T> => {
    const token = ++generation
    const run = lane.then(() => task(() => token === generation))
    lane = run.catch(() => {})
    return run
  }

  const [ready, setReady] = createSignal(false)
  const [filled, setFilled] = createSignal(false)
  const [length, setLength] = createSignal(0)
  const [docID, setDocID] = createSignal<string | undefined>()
  const [actor, setActor] = createSignal<SessionActor | undefined>()
  const [activeSync, setActiveSync] = createSignal<DocSyncOpts | undefined>()
  const [history, setHistory] = createStore({ undo: false, redo: false })

  const syncHistory = () => {
    if (!handle) return
    const undo = handle.canUndo()
    const redo = handle.canRedo()
    if (history.undo === undo && history.redo === redo) return
    setHistory({ undo, redo })
  }

  // Derive both "has content" and the character count from a single plain-text extraction. plain()
  // is already trimmed, so its code-point length is what the user perceives as the character count;
  // [...text] counts by code point so emoji/surrogate pairs count as one, not two.
  const syncContent = () => {
    const text = handle ? handle.plain() : ""
    const count = text ? [...text].length : 0
    setFilled(count > 0)
    setLength(count)
  }

  const bindHistory = () => {
    historySub?.dispose()
    if (!handle) return
    historySub = handle.doc.slots.historyUpdated.on(() => {
      handle?.onHistory()
      syncHistory()
      syncContent()
    })
  }

  const drop = async () => {
    historySub?.dispose()
    historySub = undefined
    const current = handle
    handle = undefined
    setReady(false)
    setFilled(false)
    setLength(0)
    await current?.dispose()
  }

  const ensure = async (sessionID: string, alive?: () => boolean) => {
    const actor: SessionActor = input.config.readonly
      ? {
          actorID: viewerActorID,
          sessionID,
          name: input.config.user?.name ?? "Viewer",
          color: input.config.user?.color ?? "#888888",
        }
      : await register(input, sessionID, alive)
    setActor(actor)
    // If an editor handle is already live for this session (re-ensure without a remount), push the
    // freshly resolved identity into its awareness so a corrected name/color self-heals live for
    // peers instead of waiting for a remount or a peer refresh.
    handle?.setActorIdentity(label(actor.actorID, actor.name), actor.color)
    const doc = await promptDoc(input, sessionID, alive)
    setDocID(doc.docID)
    sync = {
      docID: doc.docID,
      baseUrl: input.config.url,
      directory: input.config.directory,
      client: input.client,
      actorID: actor.actorID,
      name: label(actor.actorID, actor.name),
      color: actor.color,
    }
    setActiveSync(sync)
    init = true
    session = sessionID
  }

  const remount = async (
    alive: () => boolean,
    opts?: {
      sync?: DocSyncOpts
      init?: boolean
      sessionID?: string
      docID?: string
      keep?: boolean
    },
  ) => {
    const el = mounted
    const scheme = theme
    const next = opts?.sync ?? sync
    if (!el || !scheme || !next) return
    if (!opts?.keep) await drop()
    const current = handle
    const fresh = await createPage({
      theme: scheme,
      sync: next,
      init: opts?.init ?? init,
      readonly: input.config.readonly,
      onSubmit: input.onSubmit,
      submitKey: input.config.submitKey,
      onDraftChange: () => {
        syncContent()
        syncHistory()
      },
    })
    if (!alive()) {
      await fresh.dispose()
      return
    }
    const id = opts?.docID ?? next.docID
    handle = fresh
    // Subscribe before attach so history events fired while attaching are not missed.
    bindHistory()
    sync = next
    setActiveSync(next)
    init = opts?.init ?? init
    if (opts?.sessionID) session = opts.sessionID
    await fresh.attach(el)
    if (opts?.keep) await current?.dispose()
    live = id
    setDocID(id)
    setReady(true)
    syncHistory()
    syncContent()
  }

  const pivot = (sessionID: string, next: string, opts?: { init?: boolean; force?: boolean }) => {
    if (!opts?.force && live === next && handle?.collection.id === next && sync?.docID === next)
      return Promise.resolve()
    setDocID(next)
    const should = opts?.init ?? true

    return serialize(async (alive) => {
      // Already on the target doc (a duplicate pivot that queued behind the real one) — no-op.
      if (!opts?.force && handle?.collection.id === next && session === sessionID && sync?.docID === next) return

      if (session !== sessionID || !sync) await ensure(sessionID, alive)
      if (!alive() || !sync) return
      await remount(alive, {
        sync: { ...sync, docID: next },
        init: should,
        sessionID,
        docID: next,
      })
    })
  }

  const refresh = async (sessionID: string, opts?: { init?: boolean }) => {
    // Stop retrying if the user navigates to a different session while the server is still down.
    const doc = await promptDoc(input, sessionID, () => input.config.sessionID === sessionID)
    setDocID(doc.docID)
    if (live !== doc.docID || handle?.collection.id !== doc.docID || sync?.docID !== doc.docID) {
      await pivot(sessionID, doc.docID, opts)
      return doc.docID
    }
    setDocID(doc.docID)
    return doc.docID
  }

  const mount = (opts: { el: HTMLElement; theme: "light" | "dark" }) => {
    mounted = opts.el
    theme = opts.theme

    const sessionID = input.config.sessionID
    if (!sessionID) return Promise.resolve()

    return serialize(async (alive) => {
      const remote = await promptDoc(input, sessionID, alive)
      if (!alive()) return
      setDocID(remote.docID)
      if (session !== sessionID || !sync || sync.docID !== remote.docID) {
        await drop()
        if (!alive()) return
        await ensure(sessionID, alive)
        if (!alive()) return
      }

      if (handle?.collection.id === remote.docID) {
        await handle.attach(opts.el)
        setReady(true)
        syncHistory()
        syncContent()
        return
      }

      await remount(alive)
    })
  }

  const detach = () => {
    mounted = undefined
    theme = undefined
    // Keep the handle (sync connection + own-edit undo history) alive across panel unmounts, so
    // leaving and re-entering doc mode does not rebuild the editor and wipe undo history. The DOM
    // is detached only; mount() reuses the handle for the same doc. serialize() bumps the
    // generation (cancelling any in-flight build) so this can never race a concurrent mount/pivot.
    void serialize(async () => {
      handle?.detach()
      setReady(false)
    })
  }

  const dispose = () => {
    mounted = undefined
    theme = undefined
    // Full teardown (unlike detach): releases the editor and sync connection without clearing the
    // stored actor identity the way reset() does.
    void serialize(async () => {
      await drop()
    })
  }

  const reset = () => {
    const sessionID = session
    sync = undefined
    setActiveSync(undefined)
    init = true
    session = undefined
    live = undefined
    setActor(undefined)
    setDocID(undefined)
    if (sessionID) clearActor(sessionID, input.config.user?.id)
    setHistory({ undo: false, redo: false })
    setFilled(false)
    setLength(0)
    void serialize(async () => {
      await drop()
    })
  }

  const guard = () => handle?.guard()
  const refocus = (target?: Element) => {
    if (handle) {
      handle.refocus(target)
      return
    }
    requestAnimationFrame(() => handle?.refocus(target))
  }

  const undo = () => {
    handle?.undo()
    syncHistory()
  }

  const redo = () => {
    handle?.redo()
    syncHistory()
  }

  const commitMarkdown = () => handle?.markdown()

  const empty = () => (handle ? handle.empty() : true)

  const addFiles = async (files: File[]) => {
    // Pre-filter on file.size (synchronous, no read) so an oversized file never
    // reaches blobSync. tooLarge lets callers show the size-specific toast.
    const tooLarge = files.some((file) => file.size > MAX_ATTACHMENT_BYTES)
    const eligible = files.filter((file) => file.size <= MAX_ATTACHMENT_BYTES)
    const result = await Promise.all(eligible.map((file) => handle?.addFile(file) ?? false))
    return { added: result.some(Boolean), tooLarge }
  }

  const addReference = (path: string, nodeType?: FileNodeType) => handle?.addReference(path, nodeType) ?? false

  const addLineReference = (ref: LineRefInput) => handle?.addLineReference(ref) ?? false

  const actors = () => {
    const list: DocActor[] = handle?.actors() ?? []
    const own = actor()
    if (!own) return list
    if (list.some((item) => item.actorID === own.actorID)) return list
    return [...list, { actorID: own.actorID, name: label(own.actorID, own.name) }]
  }

  const advance = async (id?: string) => {
    const sessionID = id ?? input.config.sessionID
    if (!sessionID) return
    const res = await input.client.session.promptDoc2.advance({
      sessionID,
      directory: input.config.directory,
      clientID,
    })
    const next = res.data
    if (!next?.docID) throw new Error("prompt doc advance failed")
    await pivot(sessionID, next.docID, { init: true })
    const ready = await input.client.session.promptDoc2.ready({
      sessionID,
      directory: input.config.directory,
      docID: next.docID,
      clientID,
    })
    if (!ready.data?.docID) throw new Error("prompt doc ready failed")
    syncContent()
    return next.docID
  }

  return {
    ready,
    filled,
    length,
    docID,
    sync: activeSync,
    actorID: () => actor()?.actorID,
    actorName: () => actor()?.name,
    actors,
    history,
    mount,
    detach,
    dispose,
    reset,
    refresh,
    pivot,
    clientID,
    guard,
    refocus,
    commitMarkdown,
    addFiles,
    addReference,
    addLineReference,
    empty,
    advance,
    undo,
    redo,
    setTheme: (scheme: "light" | "dark") => {
      theme = scheme
      handle?.setTheme(scheme)
    },
  }
}
