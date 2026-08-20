import { AffineSchemas } from "@blocksuite/blocks/schemas"
import { DocCollection, Schema, type BlockModel, type Doc, type Query } from "@blocksuite/store"
import { getFilename } from "@opencode-ai/util/path"
import "@/components/blocksuite/blocksuite-doc.css"
import { watchCursorLabels } from "./cursor-labels"
import { baseline, docMarkdown, docPlain, ensureEditable } from "./doc-content"
import { initDoc } from "./doc-init"
import { link, load, remote } from "./doc-remote"
import { ensureEffects } from "./effects"
import { frame, settled } from "./frame"
import { inlineReady } from "./inline-editor"
import { OpencodeAwarenessSource, OpencodeBlobSource, OpencodeDocSource, type DocSyncOpts } from "./opencode-doc-source"
import {
  createMissingRegistry,
  createUploadTracker,
  missingMarks,
  paintUploads,
  type DocMissing,
  type DocUpload,
} from "./doc-upload"
import { scheme } from "./theme"
import { FileReferenceBlockSpec, withFileReferenceSchema, type FileNodeType } from "./file-reference-block"
import { LineReferenceBlockSpec, withLineReferenceSchema } from "./line-reference-block"
import { lineReferenceUrl, normLineRef, type LineRefInput } from "./line-reference-url"
import { actor, label, type DocActor } from "./actor"
import { matchKeybind, parseKeybind } from "@/context/command"
import { patchSlashMenu } from "./slash-menu-patch"
import { patchFormatBar } from "./format-bar-patch"
import { LinkedDocConfig } from "./linked-doc-patch"
import { MAX_ATTACHMENT_BYTES } from "@/constants/file-picker"

export type { DocActor } from "./actor"

export type DocMountInput = {
  theme: "light" | "dark"
  sync?: DocSyncOpts
  init?: boolean
  // `readonly` = not editable (typing/collab blocked) but still the full composer layout — used by the
  // ?readonly=true prompt viewer. `preview` = the sent-message BUBBLE layout (Preview specs, grow to
  // content height, no inner scroll) — used by DocMessage and the consent-dialog snapshot. A preview
  // is always readonly; a readonly viewer is NOT a preview. Keeping them separate lets the viewer match
  // the editable composer exactly (padding + scroll) while messages keep their bubble sizing.
  readonly?: boolean
  preview?: boolean
  onSubmit?: () => void
  /** Submit shortcut in parseKeybind format. Defaults to `enter`. */
  submitKey?: string
  /** Fired when the stop shortcut is pressed; the keypress is always swallowed so BlockSuite's
   *  native Escape behavior (block-selection toolbar) never fires. */
  onStop?: () => void
  /** Stop shortcut in parseKeybind format. Defaults to `escape`. */
  stopKey?: string
  onDraftChange?: () => void
  /** Fired whenever an attachment upload starts, progresses, finishes, fails or is cancelled. */
  onUploadsChange?: (uploads: DocUpload[]) => void
  /** Fired whenever the set of blocks stranded on an asset the server does not have changes. */
  onMissingChange?: (missing: DocMissing[]) => void
}

type TextProp = {
  toString?: () => string
}
type YBlock = {
  get?: (key: string) => unknown
}
type TextModel = {
  id?: string
  text?: TextProp
  yBlock?: YBlock
}

const IMAGES = new Set(["gif", "jpeg", "jpg", "png", "webp"])

const text = (value: unknown): value is TextProp => {
  if (!value || typeof value !== "object") return false
  return typeof (value as TextProp).toString === "function"
}

const yblock = (doc: Doc, block: TextModel) => {
  if (!block.id) return
  return (doc.blockCollection.yBlocks as { get?: (id: string) => unknown }).get?.(block.id) as YBlock | undefined
}

const models = (doc: Doc) => doc.getBlocks().map((model) => model as BlockModel & TextModel)

// Concurrent empty-doc initialization can leave a view Doc bound to a superseded Y.Map.
const desynced = (doc: Doc) =>
  models(doc).some((block) => {
    const live = yblock(doc, block)
    if (live && block.yBlock && live !== block.yBlock) return true
    const next = live?.get?.("prop:text") ?? block.yBlock?.get?.("prop:text")
    if (!text(block.text) || !text(next)) return false
    return block.text.toString?.() !== next.toString?.()
  })

const kind = (file: File) => {
  const type = file.type.split(";", 1)[0]?.trim().toLowerCase()
  if (type) return type
  const idx = file.name.lastIndexOf(".")
  const ext = idx === -1 ? "" : file.name.slice(idx + 1).toLowerCase()
  if (IMAGES.has(ext)) return `image/${ext === "jpg" ? "jpeg" : ext}`
  return "application/octet-stream"
}

const image = (file: File) => kind(file).startsWith("image/")

// Memoized per File: the budget check asks for a file's id before handing that same file to
// addFile, and hashing a 25 MB blob twice means reading it twice. It also keeps the non-secure
// fallback below stable — the two callers must agree on the id, random or not.
const keys = new WeakMap<File, Promise<string>>()

// Content-addressed asset id, matching what BlockSuite's own blob engine derives (sha-256, base64url)
// so the same file attached twice reuses one asset. crypto.subtle is missing outside a secure
// context; a random id is fine there — the id only has to be unique within the doc.
export const assetKey = (file: File) => {
  const cached = keys.get(file)
  if (cached) return cached
  const pending = (async () => {
    try {
      const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer())
      let binary = ""
      for (const byte of new Uint8Array(hash)) binary += String.fromCharCode(byte)
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_")
    } catch {
      return crypto.randomUUID().replace(/-/g, "")
    }
  })()
  keys.set(file, pending)
  return pending
}

const sourceId = (model: BlockModel) => {
  const value = (model as unknown as { sourceId?: unknown }).sourceId
  return typeof value === "string" && value ? value : undefined
}

export async function createPage(input: DocMountInput) {
  await ensureEffects()
  const [
    { PageEditor },
    {
      AffineFormatBarWidget,
      AffineSlashMenuWidget,
      DocModeExtension,
      PageEditorBlockSpecs,
      PreviewEditorBlockSpecs,
      ThemeProvider,
    },
  ] = await Promise.all([import("@blocksuite/presets"), import("@blocksuite/blocks")])

  patchSlashMenu(AffineSlashMenuWidget)
  patchFormatBar(AffineFormatBarWidget)

  const schema = new Schema().register(withLineReferenceSchema(withFileReferenceSchema(AffineSchemas)))
  const page = "page"
  const query = { match: [], mode: "loose" } satisfies Query
  let draft: Doc | undefined
  let collection: DocCollection
  let direct: OpencodeDocSource | undefined
  let channel: Awaited<ReturnType<typeof link>> | undefined
  let awareness: OpencodeAwarenessSource | undefined
  let blobs: OpencodeBlobSource | undefined
  let aware = false

  // Live, mutable copy of the local actor's display identity. The awareness "user" field is set once
  // at construction; this lets us re-apply a corrected name/color later (e.g. after a re-register)
  // WITHOUT a full remount — setLocalStateField triggers an awareness update that the awareness
  // source re-broadcasts to peers, so an already-connected peer's stale label self-heals live.
  let identityName = input.sync?.name
  let identityColor = input.sync?.color

  const applyIdentity = () => {
    if (!input.sync || !awareness) return
    collection.awarenessStore.awareness.setLocalStateField("user", {
      actorID: input.sync.actorID,
      name: label(input.sync.actorID, identityName),
    })
    if (identityColor) collection.awarenessStore.awareness.setLocalStateField("color", identityColor)
  }

  if (input.sync) {
    direct = new OpencodeDocSource(input.sync)
    awareness = input.readonly ? undefined : new OpencodeAwarenessSource(input.sync)
    blobs = new OpencodeBlobSource(input.sync)
    collection = new DocCollection({
      schema,
      id: input.sync.docID,
      blobSources: { main: blobs },
      awarenessSources: awareness ? [awareness] : [],
    })
    collection.meta.initialize()
    if (awareness) applyIdentity()
    if (input.init !== false) {
      draft = await remote(direct, collection, input.sync.docID, page, input.readonly, query)
      draft =
        draft ?? collection.getDoc(page, { readonly: input.readonly, query }) ?? collection.createDoc({ id: page, query })
      if (!draft.loaded) draft.load()
      await load(direct, page, draft.spaceDoc)
      if (!draft.root && !input.readonly) initDoc(draft)
      if (!input.readonly) baseline(draft)
    }
    if (input.init === false) {
      if (input.readonly) {
        draft = await remote(direct, collection, input.sync.docID, page, input.readonly, query)
        if (!draft?.root) throw new Error("doc viewer load failed")
      } else {
        while (!draft) {
          draft = await remote(direct, collection, input.sync.docID, page, input.readonly, query)
          if (draft) break
          await frame()
        }
      }
    }
  } else {
    collection = new DocCollection({ schema })
    collection.meta.initialize()
  }

  let doc = draft ?? collection.getDoc(page, { readonly: input.readonly, query }) ?? collection.createDoc({ id: page, query })
  const dnd = (item: Doc) => {
    if (!input.readonly) item.awarenessStore.setFlag("enable_new_dnd", false)
  }
  if (!doc.loaded) doc.load()
  if (!doc.root && input.init !== false && !input.readonly) initDoc(doc)
  if (!input.readonly) baseline(doc)
  dnd(doc)

  const editor = new PageEditor()
  editor.doc = doc
  editor.specs = [
    // Only the sent-message BUBBLE uses Preview specs. A readonly viewer uses the full PageEditor
    // specs so its chrome/layout is identical to the editable composer.
    ...(input.preview ? PreviewEditorBlockSpecs : PageEditorBlockSpecs),
    DocModeExtension({
      getEditorMode: () => "page",
      getPrimaryMode: () => "page",
      onPrimaryModeChange: () => ({ dispose() {} }),
      setEditorMode: () => {},
      setPrimaryMode: () => {},
      togglePrimaryMode: () => "page",
    }),
    LinkedDocConfig,
    ...FileReferenceBlockSpec,
    ...LineReferenceBlockSpec,
  ]
  editor.hasViewport = true

  // 중지 단축키(기본 Escape)는 에디터 생성 시점에 바로 등록한다. attach() 완료 시점에 붙이면
  // 마운트 직후 첫 Esc가 리스너 등록 전에 BlockSuite로 새어 블록 선택 툴바가 뜨는 레이스가 있어서다.
  // capture 단계 + editor(page-editor)에서 잡으므로 더 깊은 editor-host의 네이티브 Escape보다 먼저
  // 가로챈다. 실제 중지 여부는 부모(onStop)가 실행 중일 때만 판단한다.
  if (!input.readonly && input.onStop) {
    const stopKeys = parseKeybind(input.stopKey?.trim() || "escape")
    if (stopKeys.length > 0) {
      editor.addEventListener(
        "keydown",
        (event: KeyboardEvent) => {
          if (event.isComposing) return
          if (!matchKeybind(stopKeys, event)) return
          event.preventDefault()
          event.stopPropagation()
          if (event.repeat) return
          input.onStop?.()
        },
        true,
      )
    }
  }

  let reload: (() => void) | undefined
  let tick = 0
  let checks = 0

  const applyTheme = () => {
    editor.std.get(ThemeProvider).app$.value = scheme(input.theme)
  }

  const focus = async (ready?: Awaited<ReturnType<typeof inlineReady>>) => {
    // A readonly viewer is never focused/edited; skip so ensureEditable() can't inject a paragraph.
    if (input.readonly) return
    ensureEditable(doc)
    const root = editor.querySelector("affine-page-root")
    if (root instanceof HTMLElement) root.focus()
    const next = ready ?? (await inlineReady(editor))
    next.focusEnd()
    await next.waitForUpdate()
  }

  let resize: ResizeObserver | undefined
  let mutate: MutationObserver | undefined
  let unload: (() => void) | undefined
  let cursors: (() => void) | undefined
  let unkeys: (() => void) | undefined
  let offY: (() => void) | undefined
  let draftFrame: number | undefined

  const notifyDraft = () => {
    if (!input.onDraftChange) return
    if (draftFrame) cancelAnimationFrame(draftFrame)
    draftFrame = requestAnimationFrame(() => {
      draftFrame = undefined
      input.onDraftChange?.()
    })
  }

  let uploadFrame: ReturnType<typeof setTimeout> | undefined
  // Progress events fire many times a second; coalesce the DOM writes. A timer rather than
  // requestAnimationFrame: rAF is suspended while the tab is in the background, which is exactly
  // when a long upload is likely to be running, and the bar would then be frozen on return.
  const paint = () => {
    if (uploadFrame) return
    uploadFrame = setTimeout(() => {
      uploadFrame = undefined
      paintUploads(editor, [...uploads.list(), ...missingMarks(missing.list())])
    }, 60)
  }

  const assetName = (model: BlockModel) => {
    const caption = (model as unknown as { caption?: unknown }).caption
    if (typeof caption === "string" && caption.trim()) return caption.trim()
    const name = (model as unknown as { name?: unknown }).name
    if (typeof name === "string" && name.trim()) return name.trim()
    return sourceId(model) ?? "attachment"
  }

  // Uploads alone cannot say which attachments are actually on the server: the tracker is rebuilt
  // with the editor, so a transfer abandoned mid-flight leaves a block behind that nothing local
  // knows anything about. The registry keeps the server's answer instead.
  const missing = createMissingRegistry({
    blocks: () =>
      [...doc.getBlockByFlavour("affine:image"), ...doc.getBlockByFlavour("affine:attachment")].map((model) => ({
        blockId: model.id,
        key: sourceId(model),
        name: assetName(model),
      })),
    uploading: () => uploads.list().map((item) => item.key),
    onChange: () => {
      paint()
      input.onMissingChange?.(missing.list())
    },
  })

  // Re-write the block's own sourceId once the bytes are up. A collaborator receives the block over
  // the doc socket before the asset exists on the server, so their image/attachment has already
  // failed to fetch and cached that failure; the write emits a sourceId update on every client,
  // which is exactly what those blocks re-fetch on. withoutTransact keeps it out of the undo stack.
  // Every block carrying the asset, not just the first: the same file attached twice is one asset
  // under two blocks, and each of them cached its own failed fetch.
  const settleAsset = (key: string) => {
    const models = [...doc.getBlockByFlavour("affine:image"), ...doc.getBlockByFlavour("affine:attachment")].filter(
      (item) => sourceId(item) === key,
    )
    if (models.length === 0) return
    doc.withoutTransact(() => {
      for (const model of models) doc.updateBlock(model, { sourceId: key })
    })
  }

  const uploads = createUploadTracker({
    upload: async (key, blob, opts) => {
      if (!blobs) throw new Error("doc has no blob source")
      await blobs.upload(key, blob, opts)
      settleAsset(key)
    },
    onChange: () => {
      paint()
      input.onUploadsChange?.(uploads.list())
      // A landed upload takes its asset out of the "still uploading" exemption, so the stranded
      // list can change without any block or fetch having moved.
      missing.refresh()
    },
  })

  // The blob source is the only place that ever asks the server for an asset, so it is where a
  // block's bytes are found to be gone. BlockSuite cannot show that itself — a null blob leaves the
  // image spinning forever — so the answer is routed here instead.
  if (blobs) blobs.onAssetMissing = missing.mark

  // The block IS the upload's handle: removing it (delete, or undo of the add) cancels, and undoing
  // that removal puts it back. `doc` is swapped on rebind(), so this re-subscribes with it.
  let offBlocks: (() => void) | undefined
  const watchBlocks = () => {
    offBlocks?.()
    offBlocks = undefined
    if (input.readonly || !blobs) return
    const sub = doc.slots.blockUpdated.on((event) => {
      if (event.type === "delete") {
        uploads.cancel(event.id)
        // Deleting the block is the only way out of a stranded attachment, so the gate has to
        // notice. Nothing else here fires for it: there is no upload entry left to cancel.
        missing.refresh()
        return
      }
      if (event.type !== "add") return
      const key = sourceId(event.model)
      if (!key) return
      uploads.resume(event.id, key)
      // Undo brought the block back — with it, whatever was wrong with its asset.
      missing.refresh()
    })
    offBlocks = () => sub.dispose()
  }

  // IME 조합(한글 등) 중에는 문서 교체(rebind)/원격 업데이트 적용/포커스 재설정이 조합을 취소시켜
  // 입력이 유실된다. 두 경로가 있다:
  //  1) 최초 다중 접속 시 desynced가 true인 동안 rebind가 매 프레임 돌며 조합을 끊는다.
  //  2) 상대가 타이핑하면 원격 yText 변경이 inline editor를 즉시 re-render해 조합을 끊는다.
  // 조합 상태를 추적해, 조합 중에는 rebind를 미루고(recheck) 원격 업데이트는 link()가 버퍼링한다.
  // compositionend 시점에 버퍼를 flush하고 probe를 다시 무장해 desync 화해를 이어간다.
  let composing = false
  let recheck = false
  const onCompositionStart = () => {
    composing = true
  }
  const onCompositionEnd = () => {
    composing = false
    channel?.flush()
    if (!recheck) return
    recheck = false
    probe()
  }
  let offComposition: (() => void) | undefined
  if (!input.readonly) {
    editor.addEventListener("compositionstart", onCompositionStart, true)
    editor.addEventListener("compositionend", onCompositionEnd, true)
    offComposition = () => {
      editor.removeEventListener("compositionstart", onCompositionStart, true)
      editor.removeEventListener("compositionend", onCompositionEnd, true)
    }
  }

  // A message BUBBLE / snapshot (preview) is a frozen one-time render — it loads its state once and
  // must NOT open a live sync socket (one per bubble would pile up). The editable composer and the
  // readonly prompt VIEWER both link(): the viewer needs remote→local live edits, and its push side is
  // a no-op because the Preview editor never mutates the doc.
  if (input.sync && !input.preview) {
    channel = await link(direct!, collection.doc, doc.spaceDoc, () => composing)
    if (!input.readonly) {
      const onY = () => notifyDraft()
      doc.spaceDoc.on("update", onY)
      offY = () => doc.spaceDoc.off("update", onY)
    }
  }

  const rebind = () => {
    const current = editor.std?.doc ?? doc
    if (!desynced(current)) return
    // 조합 중이면 문서를 갈아끼우지 않는다 — 조합이 끊기며 입력이 유실된다. 조합이 끝나면
    // onCompositionEnd가 probe()를 다시 돌려 화해를 마저 처리한다.
    if (composing) {
      recheck = true
      return
    }
    const active = document.activeElement
    const restore = active instanceof Element && editor.contains(active)
    current.blockCollection.clearQuery(query, input.readonly)
    const fresh = collection.getDoc(page, { readonly: input.readonly, query })
    if (!fresh) return
    if (!fresh.loaded) fresh.load()
    dnd(fresh)
    doc = fresh
    editor.doc = fresh
    if (fresh !== current) current.dispose()
    watchBlocks()
    editor.requestUpdate()
    const el = editor.parentElement
    if (!(el instanceof HTMLElement)) return
    requestAnimationFrame(() => {
      cursors?.()
      cursors = input.readonly ? undefined : watchCursorLabels(editor, el)
      fit(el)
      paint()
      // rebind swapped the whole doc; the block list came with it.
      missing.refresh()
      if (restore) void focus()
    })
  }

  const probe = (count = 8) => {
    checks = Math.max(checks, count)
    if (tick) return
    const run = () => {
      tick = 0
      if (checks <= 0) return
      checks--
      rebind()
      if (checks > 0) tick = requestAnimationFrame(run)
    }
    tick = requestAnimationFrame(run)
  }

  if (input.sync) {
    const space = doc.spaceDoc
    const update = () => probe()
    space.on("update", update)
    probe(2)
    reload = () => {
      space.off("update", update)
      checks = 0
      if (!tick) return
      cancelAnimationFrame(tick)
      tick = 0
    }
  }

  watchBlocks()

  // A sent doc message grows to its full content height (no max cap, no inner scroll).
  const clamp = (height: number) => Math.max(40, Math.ceil(height))

  const content = (host: HTMLElement, root?: HTMLElement, preview?: HTMLElement) => {
    const base = host.getBoundingClientRect().top
    const boxes = Array.from(
      editor.querySelectorAll(
        [
          "img",
          "svg",
          "canvas",
          "video",
          "affine-image",
          "affine-image-block",
          "affine-attachment",
          "affine-embed",
          "[data-block-id]",
        ].join(","),
      ),
    )
      .filter((node): node is HTMLElement | SVGElement => node instanceof HTMLElement || node instanceof SVGElement)
      .map((node) => node.getBoundingClientRect().bottom - base)
    return Math.max(root?.scrollHeight ?? 0, preview?.scrollHeight ?? 0, ...boxes)
  }

  const fit = (host: HTMLElement) => {
    const width = host.clientWidth
    const root = editor.querySelector(".affine-page-root-block-container")
    const preview = editor.querySelector("affine-preview-root")
    // Only the message bubble (input.preview) grows to content height with no inner scroll. A readonly
    // viewer uses the composer's own sizing (host height + inner scroll) so it matches the editor.
    const height = input.preview
      ? content(
          host,
          root instanceof HTMLElement ? root : undefined,
          preview instanceof HTMLElement ? preview : undefined,
        )
      : host.clientHeight
    const tall = input.preview ? clamp(height) : height
    if (tall <= 0) return
    if (input.preview) host.style.height = `${tall}px`
    editor.style.display = "block"
    editor.style.height = `${tall}px`
    editor.style.width = width > 0 ? `${width}px` : "100%"
    const viewport = editor.querySelector(".affine-page-viewport")
    if (viewport instanceof HTMLElement) {
      viewport.style.width = width > 0 ? `${width}px` : "100%"
      viewport.style.height = `${tall}px`
      viewport.style.minHeight = input.preview ? "0" : `${tall}px`
      // Preview (a sent message): never scroll — grow to full content. Editing/viewer keeps default.
      viewport.style.overflowY = input.preview ? "visible" : ""
    }
    if (root instanceof HTMLElement) {
      root.style.maxWidth = "none"
      root.style.margin = "0"
      if (width > 0) root.style.width = `${width}px`
      if (input.preview) root.style.minHeight = "0"
    }
    if (preview instanceof HTMLElement) {
      preview.style.display = "block"
      preview.style.width = width > 0 ? `${width}px` : "100%"
      preview.style.maxWidth = "none"
      preview.style.margin = "0"
    }
  }

  const attach = async (el: HTMLElement) => {
    const attached = editor.parentElement === el
    el.setAttribute("aria-busy", "true")
    if (!attached) el.replaceChildren(editor)
    try {
      await settled(editor.updateComplete)
      await settled(editor.host?.updateComplete)
      // BlockSuite's RemoteColorManager sets the awareness `color` field to a persisted/random color
      // when affine-page-root mounts, clobbering the color we set in applyIdentity() before mount. Now
      // that the root (and its color manager) has initialized, re-apply our server/identity color so it
      // is the one broadcast to peers — matching the avatar colors.
      applyIdentity()
      const ready = input.readonly ? undefined : await inlineReady(editor)
      applyTheme()
      fit(el)
      // A sent message can finish laying out a frame after the first measure; re-fit once so its
      // full height is captured (no clipping). Guarded so a detached node never collapses to min.
      if (input.preview) requestAnimationFrame(() => el.isConnected && fit(el))
      resize?.disconnect()
      resize = new ResizeObserver(() => fit(el))
      resize.observe(el)
      resize.observe(editor)
      const root = editor.querySelector(".affine-page-root-block-container")
      if (root instanceof HTMLElement) resize.observe(root)
      const preview = editor.querySelector("affine-preview-root")
      if (preview instanceof HTMLElement) resize.observe(preview)
      mutate?.disconnect()
      // The bubble (preview) is static, so no observer. A readonly viewer keeps the observer so live
      // remote edits re-fit and update draft/filled state, exactly like the editable composer.
      mutate = input.preview
        ? undefined
        : new MutationObserver(() => {
            fit(el)
            notifyDraft()
            // Lit re-creates block elements on doc changes, so the progress marks have to be
            // re-applied. paintUploads is idempotent and a no-op with nothing in flight.
            paint()
          })
      mutate?.observe(editor, { childList: true, characterData: true, subtree: true })
      unload?.()
      const loaded = () => fit(el)
      editor.addEventListener("load", loaded, true)
      unload = () => editor.removeEventListener("load", loaded, true)
      cursors?.()
      cursors = input.readonly ? undefined : watchCursorLabels(editor, el)
      unkeys?.()
      unkeys = undefined
      // 중지(Escape) 리스너는 editor 생성 시점에 한 번 등록한다(위 참고). 여기서는 전송 키만 처리.
      const send = input.onSubmit
      if (!input.readonly && send) {
        const submitKeys = parseKeybind(input.submitKey?.trim() || "enter")
        const onSubmitKey = (event: KeyboardEvent) => {
          // IME 조합 중 전송 방지. 전송 키가 아닌 입력(예: 기본값에서 Shift+Enter)은
          // 가로채지 않고 BlockSuite 네이티브 줄바꿈에 맡긴다.
          if (event.isComposing) return
          if (!matchKeybind(submitKeys, event)) return
          event.preventDefault()
          event.stopPropagation()
          if (event.repeat) return
          send()
        }
        editor.addEventListener("keydown", onSubmitKey, true)
        unkeys = () => editor.removeEventListener("keydown", onSubmitKey, true)
      }
      if (!attached && ready) await focus(ready)
      if (input.sync && awareness && !aware) {
        collection.awarenessSync.connect()
        aware = true
      }
      await frame()
      fit(el)
      notifyDraft()
      paint()
      if (!input.readonly && document.activeElement === editor.querySelector("affine-page-root")) await focus(ready)
    } finally {
      el.removeAttribute("aria-busy")
    }
  }

  const detach = () => {
    unkeys?.()
    unkeys = undefined
    cursors?.()
    cursors = undefined
    resize?.disconnect()
    resize = undefined
    mutate?.disconnect()
    mutate = undefined
    unload?.()
    unload = undefined
    editor.remove()
  }

  let hadText = false

  const settle = () => {
    // A readonly viewer must never mutate the doc — ensureEditable() would inject a paragraph.
    if (!input.readonly) ensureEditable(doc)
    const empty = !docPlain(doc)
    if (empty) {
      if (!input.sync) doc.resetHistory()
      hadText = false
      notifyDraft()
      return
    }
    hadText = true
    notifyDraft()
  }

  const onHistory = () => {
    const empty = !docPlain(doc)
    if (hadText && empty && !input.sync) doc.resetHistory()
    hadText = !empty
    if (!input.readonly) ensureEditable(doc)
    notifyDraft()
  }

  const guard = () => {
    if (input.readonly) return
    ensureEditable(doc)
  }

  const refocus = (target?: Element) => {
    if (target && editor.contains(target)) return
    void focus()
  }

  const insert = (id: string, file: File, parent: string) =>
    image(file)
      ? doc.addBlock("affine:image", { sourceId: id, caption: file.name, size: file.size }, parent)
      : doc.addBlock(
          "affine:attachment",
          { sourceId: id, name: file.name, size: file.size, type: kind(file), embed: false },
          parent,
        )

  const addFile = async (file: File) => {
    if (input.readonly) return false
    // Reject oversized files before we read the whole blob (arrayBuffer + base64)
    // into memory, which would crash the tab. Callers surface the toast.
    if (file.size > MAX_ATTACHMENT_BYTES) return false
    ensureEditable(doc)
    const parent = doc.getBlockByFlavour("affine:note")[0]
    if (!parent) return false
    if (!blobs) {
      // No sync layer (message bubble, tests): no upload lane either, so keep the direct path.
      insert(await doc.blobSync.set(file), file, parent.id)
    } else {
      // Cache first, insert second, upload third. The block renders from the local blob right away
      // and carries a progress bar until the bytes land — instead of the editor sitting empty for
      // the whole upload and then flashing a block that looks already finished.
      const id = await assetKey(file)
      blobs.remember(id, file)
      const blockId = insert(id, file, parent.id)
      if (blockId) uploads.start({ blockId, key: id, name: file.name, blob: file })
    }
    onHistory()
    requestAnimationFrame(() => void focus())
    return true
  }

  // What this doc currently carries as attachments. Counts every image/attachment block, including
  // ones BlockSuite created itself (native paste inside the editor never goes through addFile), so
  // the caller's budget check cannot be walked around. A block without a usable size counts toward
  // the number but contributes nothing to the byte total.
  //
  // Counted per ASSET, not per block: ids are content hashes, so the same file in two blocks is one
  // stored asset uploaded once and costs the budget once. `keys` is what the caller matches an
  // incoming file against to decide whether it is free.
  const assets = () => {
    const blocks = [...doc.getBlockByFlavour("affine:image"), ...doc.getBlockByFlavour("affine:attachment")]
    const seen = new Set<string>()
    let count = 0
    let bytes = 0
    for (const block of blocks) {
      const key = sourceId(block)
      // A block with no asset id yet matches nothing, so it can only count for itself.
      if (key) {
        if (seen.has(key)) continue
        seen.add(key)
      }
      count += 1
      const size = (block as unknown as { size?: unknown }).size
      if (typeof size === "number" && size > 0) bytes += size
    }
    return { count, bytes, keys: [...seen] }
  }

  const addReference = (path: string, nodeType: FileNodeType = "file") => {
    if (input.readonly) return false
    ensureEditable(doc)
    const parent = doc.getBlockByFlavour("affine:note")[0]
    if (!parent) return false
    const name = nodeType === "directory" ? path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path : getFilename(path)
    doc.addBlock(
      "opencode:file-reference",
      { name, path, url: path, nodeType },
      parent.id,
    )
    onHistory()
    requestAnimationFrame(() => void focus())
    return true
  }

  const addLineReference = (ref: LineRefInput) => {
    if (input.readonly) return false
    ensureEditable(doc)
    const parent = doc.getBlockByFlavour("affine:note")[0]
    if (!parent) return false
    const norm = normLineRef(ref)
    const path = ref.path
    const comment = ref.comment?.trim() ?? ""
    const preview = ref.preview?.trim() ?? ""
    doc.addBlock(
      "opencode:line-reference",
      {
        name: getFilename(path),
        path,
        url: lineReferenceUrl({ ...ref, ...norm }),
        start: norm.start,
        end: norm.end,
        side: norm.side ?? "",
        endSide: norm.endSide ?? "",
        additionStart: ref.additionStart ?? 0,
        additionEnd: ref.additionEnd ?? 0,
        deletionStart: ref.deletionStart ?? 0,
        deletionEnd: ref.deletionEnd ?? 0,
        label: ref.label?.trim() ?? "",
        preview,
        comment,
      },
      parent.id,
    )
    onHistory()
    requestAnimationFrame(() => void focus())
    return true
  }

  const undo = () => {
    if (!doc.canUndo) return
    doc.undo()
    settle()
    requestAnimationFrame(() => void focus())
  }

  const redo = () => {
    if (!doc.canRedo) return
    doc.redo()
    onHistory()
    requestAnimationFrame(() => void focus())
  }

  const actors = () => {
    const own = input.sync ? [{ actorID: input.sync.actorID, name: label(input.sync.actorID, identityName) }] : []
    const states = Array.from(collection.awarenessStore.awareness.getStates().values())
    return Array.from(
      [...own, ...states.map(actor).filter((item): item is DocActor => !!item)]
        .reduce((map, item) => map.set(item.actorID, item), new Map<string, DocActor>())
        .values(),
    )
  }

  return {
    get doc() {
      return doc
    },
    editor,
    collection,
    attach,
    detach,
    guard,
    refocus,
    addFile,
    assets,
    uploads: () => uploads.list(),
    uploading: () => uploads.active(),
    missing: missing.list,
    addReference,
    addLineReference,
    onHistory,
    markdown: async () => {
      const sync = input.sync
      if (!sync) return { text: docPlain(doc), assets: [], missing: [] }
      const out = await docMarkdown(doc, {
        docID: sync.docID,
        directory: sync.directory,
        client: sync.client,
      })
      // The export re-reads every asset, which makes it the freshest answer there is — fold it back
      // in so a block that only turns out to be dead at send time gets marked too, not just refused.
      for (const item of out.assets) missing.mark(item.id, false)
      for (const item of out.missing) missing.mark(item.id, true)
      return out
    },
    plain: () => docPlain(doc),
    empty: () => !docPlain(doc),
    undo,
    redo,
    canUndo: () => doc.canUndo,
    canRedo: () => doc.canRedo,
    actors,
    setActorIdentity: (name: string | undefined, color?: string) => {
      if (name === identityName && (color === undefined || color === identityColor)) return
      identityName = name
      if (color !== undefined) identityColor = color
      applyIdentity()
    },
    setTheme: (theme: "light" | "dark") => {
      // attach() 가 applyTheme() 로 집어가므로 붙기 전에 불려도 값은 안 잃는다. std 는 attach
      // 전까지 없어서, 여기서 바로 만지면 터진다.
      input.theme = theme
      if (!editor.std) return
      editor.std.get(ThemeProvider).app$.value = scheme(theme)
    },
    dispose: async () => {
      reload?.()
      reload = undefined
      offComposition?.()
      offComposition = undefined
      offBlocks?.()
      offBlocks = undefined
      missing.dispose()
      uploads.dispose()
      if (uploadFrame) clearTimeout(uploadFrame)
      uploadFrame = undefined
      if (draftFrame) cancelAnimationFrame(draftFrame)
      draftFrame = undefined
      offY?.()
      offY = undefined
      unkeys?.()
      unkeys = undefined
      cursors?.()
      cursors = undefined
      resize?.disconnect()
      resize = undefined
      mutate?.disconnect()
      mutate = undefined
      unload?.()
      unload = undefined
      detach()
      if (input.sync) {
        channel?.unlink()
        direct?.close()
        if (aware) collection.awarenessSync.disconnect()
        collection.dispose()
      }
      doc.dispose()
    },
  }
}
