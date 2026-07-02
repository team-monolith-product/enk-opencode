import { Cause, Effect, Layer, Scope, ServiceMap } from "effect"
// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"
import { readdir } from "fs/promises"
import path from "path"
import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { Flag } from "@/flag/flag"
import { Instance } from "@/project/instance"
import { git } from "@/util/git"
import { lazy } from "@/util/lazy"
import { Config } from "../config/config"
import { FileIgnore } from "./ignore"
import { Protected } from "./protected"
import { Log } from "../util/log"

declare const OPENCODE_LIBC: string | undefined

export namespace FileWatcher {
  const log = Log.create({ service: "file.watcher" })
  const SUBSCRIBE_TIMEOUT_MS = 10_000
  // 대량 변경(브랜치 체크아웃, install, 빌드 등) 시 parcel 이벤트가 수백~수천 개
  // 쏟아질 수 있으므로 짧은 창 안에서 file+event 를 합쳐(coalesce) 한 번에 발행한다.
  const DEBOUNCE_MS = 150
  const DEBOUNCE_MAX_BUFFER = 5_000

  export const Event = {
    Updated: BusEvent.define(
      "file.watcher.updated",
      z.object({
        file: z.string(),
        event: z.union([z.literal("add"), z.literal("change"), z.literal("unlink")]),
      }),
    ),
  }

  const watcher = lazy((): typeof import("@parcel/watcher") | undefined => {
    try {
      const binding = require(
        `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${OPENCODE_LIBC || "glibc"}` : ""}`,
      )
      return createWrapper(binding) as typeof import("@parcel/watcher")
    } catch (error) {
      log.error("failed to load watcher binding", { error })
      return
    }
  })

  function getBackend() {
    if (process.platform === "win32") return "windows"
    if (process.platform === "darwin") return "fs-events"
    if (process.platform === "linux") return "inotify"
  }

  function protecteds(dir: string) {
    return Protected.paths().filter((item) => {
      const rel = path.relative(dir, item)
      return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
    })
  }

  export const hasNativeBinding = () => !!watcher()

  export interface Interface {
    readonly init: () => Effect.Effect<void>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/FileWatcher") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service

      const state = yield* InstanceState.make(
        Effect.fn("FileWatcher.state")(
          function* () {
            if (yield* Flag.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER) return

            log.info("init", { directory: Instance.directory })

            const backend = getBackend()
            if (!backend) {
              log.error("watcher backend not supported", { directory: Instance.directory, platform: process.platform })
              return
            }

            const w = watcher()
            if (!w) return

            log.info("watcher backend", { directory: Instance.directory, platform: process.platform, backend })

            const subs: ParcelWatcher.AsyncSubscription[] = []

            // file+event 기준으로 디바운스 창 안의 중복 이벤트를 합친다. Map 은 삽입
            // 순서를 보존하므로 flush 시 발생 순서대로 발행된다. 같은 file 이 create
            // 뒤 delete 되면(임시파일 등) 마지막 상태만 남기도록 file 단위로 최신 event 를
            // 덮어쓴다.
            const pendingEvents = new Map<string, "add" | "change" | "unlink">()
            let flushTimer: ReturnType<typeof setTimeout> | undefined

            const flush = Instance.bind(() => {
              flushTimer = undefined
              if (pendingEvents.size === 0) return
              const batch = [...pendingEvents.entries()]
              pendingEvents.clear()
              for (const [file, event] of batch) {
                Bus.publish(Event.Updated, { file, event })
              }
            })

            const scheduleFlush = () => {
              if (flushTimer) return
              flushTimer = setTimeout(flush, DEBOUNCE_MS)
            }

            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                if (flushTimer) {
                  clearTimeout(flushTimer)
                  flushTimer = undefined
                }
                pendingEvents.clear()
              }).pipe(Effect.andThen(Effect.promise(() => Promise.allSettled(subs.map((sub) => sub.unsubscribe()))))),
            )

            const cb: ParcelWatcher.SubscribeCallback = Instance.bind((err, evts) => {
              if (err) return
              for (const evt of evts) {
                const event = evt.type === "create" ? "add" : evt.type === "delete" ? "unlink" : "change"
                pendingEvents.set(evt.path, event)
              }
              // 버퍼가 비정상적으로 커지면(폭주) 즉시 flush 해 메모리 누적을 방지한다.
              if (pendingEvents.size >= DEBOUNCE_MAX_BUFFER) {
                if (flushTimer) {
                  clearTimeout(flushTimer)
                  flushTimer = undefined
                }
                flush()
                return
              }
              scheduleFlush()
            })

            const subscribe = (dir: string, ignore: string[]) => {
              const pending = w.subscribe(dir, cb, { ignore, backend })
              return Effect.gen(function* () {
                const sub = yield* Effect.promise(() => pending)
                subs.push(sub)
              }).pipe(
                Effect.timeout(SUBSCRIBE_TIMEOUT_MS),
                Effect.catchCause((cause) => {
                  log.error("failed to subscribe", { dir, cause: Cause.pretty(cause) })
                  pending.then((s) => s.unsubscribe()).catch(() => {})
                  return Effect.void
                }),
              )
            }

            const cfg = yield* config.get()
            const cfgIgnores = cfg.watcher?.ignore ?? []

            // 네이티브 디렉터리 워처는 기본 활성. 툴을 거치지 않은 파일 변경(bash
            // touch/mkdir/mv/rm, git checkout, 빌드 산출물, 외부 에디터 등)도
            // file.watcher.updated 이벤트로 흘러 트리가 자동 갱신된다.
            // OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER 로 끌 수 있다(위 가드 참조).
            yield* subscribe(Instance.directory, [
              ...FileIgnore.PATTERNS,
              ...cfgIgnores,
              ...protecteds(Instance.directory),
            ])

            if (Instance.project.vcs === "git") {
              const result = yield* Effect.promise(() =>
                git(["rev-parse", "--git-dir"], {
                  cwd: Instance.project.worktree,
                }),
              )
              const vcsDir =
                result.exitCode === 0 ? path.resolve(Instance.project.worktree, result.text().trim()) : undefined
              if (vcsDir && !cfgIgnores.includes(".git") && !cfgIgnores.includes(vcsDir)) {
                const ignore = (yield* Effect.promise(() => readdir(vcsDir).catch(() => []))).filter(
                  (entry) => entry !== "HEAD",
                )
                yield* subscribe(vcsDir, ignore)
              }
            }
          },
          Effect.catchCause((cause) => {
            log.error("failed to init watcher service", { cause: Cause.pretty(cause) })
            return Effect.void
          }),
        ),
      )

      return Service.of({
        init: Effect.fn("FileWatcher.init")(function* () {
          yield* InstanceState.get(state)
        }),
      })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer))

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export function init() {
    return runPromise((svc) => svc.init())
  }
}
