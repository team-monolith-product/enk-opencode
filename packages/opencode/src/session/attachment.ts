import { Cause, Duration, Effect, Layer, Schedule, ServiceMap } from "effect"
import mime from "mime-types"
import path from "path"
import { AppFileSystem } from "@/filesystem"
import { decodeDataUrlBytes } from "@/util/data-url"
import { Identifier } from "../id/id"
import { Log } from "../util/log"
import { PartID } from "./schema"
import { ATTACHMENT_DIR, ATTACHMENT_GLOB } from "./attachment-dir"

export namespace Attachment {
  const log = Log.create({ service: "attachment" })
  const RETENTION = Duration.days(7)

  export const DIR = ATTACHMENT_DIR
  export const GLOB = ATTACHMENT_GLOB

  /**
   * Filenames arrive from the client, so the stored basename is derived from a freshly
   * generated part id and a sanitized copy of the original name. Nothing the client sends
   * can escape ATTACHMENT_DIR.
   */
  function filename(original: string | undefined, mediaType: string) {
    const fallback = "attachment" + (mime.extension(mediaType) ? "." + mime.extension(mediaType) : "")
    const base = path.basename(original ?? fallback).replaceAll(/[^a-zA-Z0-9._-]/g, "_")
    const safe = base.replaceAll(/^[.]+/g, "") || fallback
    return PartID.ascending() + "-" + safe.slice(0, 100)
  }

  export interface Interface {
    readonly cleanup: () => Effect.Effect<void>
    /**
     * Writes an attachment to disk so the agent can reference the original bytes by path.
     * Accepts either a data url or already-decoded bytes (an upload that lives in the doc
     * asset store). Returns the absolute path, or undefined when the write fails.
     */
    readonly save: (input: {
      url?: string
      bytes?: Uint8Array
      mime: string
      filename?: string
    }) => Effect.Effect<string | undefined>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Attachment") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service

      const cleanup = Effect.fn("Attachment.cleanup")(function* () {
        const cutoff = Identifier.timestamp(Identifier.create("part", false, Date.now() - Duration.toMillis(RETENTION)))
        const entries = yield* fs.readDirectory(ATTACHMENT_DIR).pipe(
          Effect.map((all) => all.filter((name) => name.startsWith("prt_"))),
          Effect.catch(() => Effect.succeed([])),
        )
        for (const entry of entries) {
          if (Identifier.timestamp(entry) >= cutoff) continue
          yield* fs.remove(path.join(ATTACHMENT_DIR, entry)).pipe(Effect.catch(() => Effect.void))
        }
      })

      const save = Effect.fn("Attachment.save")(function* (input: {
        url?: string
        bytes?: Uint8Array
        mime: string
        filename?: string
      }) {
        const bytes = input.bytes ?? (input.url ? decodeDataUrlBytes(input.url) : new Uint8Array())
        if (bytes.length === 0) return undefined
        const file = path.join(ATTACHMENT_DIR, filename(input.filename, input.mime))
        const written = yield* fs.writeWithDirs(file, bytes).pipe(
          Effect.as(true),
          // A failed write must never break the prompt — the model still gets the inline image.
          Effect.catchCause((cause) => {
            log.error("failed to persist attachment", { cause: Cause.pretty(cause) })
            return Effect.succeed(false)
          }),
        )
        return written ? file : undefined
      })

      yield* cleanup().pipe(
        Effect.catchCause((cause) => {
          log.error("attachment cleanup failed", { cause: Cause.pretty(cause) })
          return Effect.void
        }),
        Effect.repeat(Schedule.spaced(Duration.hours(1))),
        Effect.delay(Duration.minutes(1)),
        Effect.forkScoped,
      )

      return Service.of({ cleanup, save })
    }),
  )
}
