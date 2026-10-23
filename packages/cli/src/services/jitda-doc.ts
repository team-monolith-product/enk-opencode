import { Doc, Recorder, Room, Store } from "@opencode/plugin-jitda/doc"
import { Effect, Queue, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { Socket } from "effect/socket"
import path from "node:path"

// 협업 프롬프트 문서·합의 투표 HTTP/WS(V1 /doc, /session/:id/prompt-doc 등). 로직은 @opencode/plugin-jitda/doc 에 있고
// 투표가 통과했을 때의 동작은 루프백으로 V2 서버 API 를 부른다.

export const PATH = "/api/jitda/doc"
const SESSION_TTL = 30_000
const MAX_ASSET = 10 * 1024 * 1024
const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"])

type Loopback = { server: string; auth: string }
let loopback: Loopback | undefined
let prefix = () => ""
const streams = new Set<(frame: string) => void>()
const sessions = new Map<string, { at: number; directory?: string }>()

type Outbound = string | Uint8Array | Socket.CloseEvent

async function call(method: string, route: string, body?: unknown, directory?: string) {
  if (!loopback) throw new Error("jitda doc server is not ready")
  const res = await fetch(`${loopback.server}${route}`, {
    method,
    headers: {
      authorization: loopback.auth,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(directory ? { "x-opencode-directory": encodeURIComponent(directory) } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(text || `${method} ${route} failed with ${res.status}`)
  return text ? (JSON.parse(text) as unknown) : undefined
}

async function session(sessionID: string) {
  const cached = sessions.get(sessionID)
  if (cached && Date.now() - cached.at < SESSION_TTL) return cached
  const info = (await call("GET", `/api/session/${encodeURIComponent(sessionID)}`).catch(() => undefined)) as
    | { data?: { location?: { directory?: string } }; location?: { directory?: string } }
    | undefined
  if (!info) return undefined
  const next = { at: Date.now(), directory: (info.data ?? info).location?.directory }
  sessions.set(sessionID, next)
  return next
}

type FormDetail = { fields?: { key: string; type: string }[] }

const host: Doc.Host = {
  prompt: async (sessionID, body) => {
    const id = encodeURIComponent(sessionID)
    const { model, agent, ...rest } = body as { model?: unknown; agent?: unknown } & Record<string, unknown>
    // 되돌리기가 걸린 채 모델·에이전트를 바꾸면 접수 시점 커밋이 그 전환 기록을 지운다. 먼저 커밋한다.
    await call("POST", `/api/session/${id}/revert/commit`).catch(() => undefined)
    if (typeof agent === "string" && agent) await call("POST", `/api/session/${id}/agent`, { agent })
    if (model && typeof model === "object") {
      const ref = model as { id?: string; modelID?: string; providerID?: string; variant?: string }
      const modelID = ref.id ?? ref.modelID
      if (modelID && ref.providerID)
        await call("POST", `/api/session/${id}/model`, {
          model: { id: modelID, providerID: ref.providerID, ...(ref.variant ? { variant: ref.variant } : {}) },
        })
    }
    const result = (await call("POST", `/api/session/${id}/prompt`, rest)) as { data?: { id?: string } } | undefined
    return { messageID: result?.data?.id }
  },
  interrupt: (sessionID) => call("POST", `/api/session/${encodeURIComponent(sessionID)}/interrupt`),
  formReply: async (sessionID, formID, answers) => {
    const route = `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}`
    const detail = (await call("GET", route).catch(() => undefined)) as { data?: FormDetail } | FormDetail | undefined
    const fields = ((detail as { data?: FormDetail })?.data ?? (detail as FormDetail))?.fields ?? []
    const answer: Record<string, string | string[]> = {}
    answers.forEach((values, index) => {
      const field = fields[index]
      const key = field?.key ?? `q${index}`
      if (field?.type === "multiselect") answer[key] = values
      else if (values[0] !== undefined) answer[key] = values[0]
    })
    return call("POST", `${route}/reply`, { answer })
  },
  formCancel: (sessionID, formID) =>
    call("DELETE", `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}`),
  archive: async (sessionID) => {
    const info = await session(sessionID)
    return call("POST", "/api/rpc/jitda.session/archive", { input: { sessionID } }, info?.directory)
  },
  revert: async (sessionID, messageID) => {
    const id = encodeURIComponent(sessionID)
    await call("POST", `/api/session/${id}/interrupt`)
    await call("POST", `/api/experimental/session/${id}/wait`)
    return call("POST", `/api/session/${id}/revert/stage`, { messageID })
  },
  unrevert: (sessionID) => call("DELETE", `/api/session/${encodeURIComponent(sessionID)}/revert`),
  emit: (event) => {
    const frame = `data: ${JSON.stringify({ type: event.type, properties: event.properties })}\n\n`
    for (const write of streams) write(frame)
  },
}

export function configure(input: { data: string; database: string; prefix?: () => string }) {
  const file = process.env.OPENCODE_JITDA_DB ?? path.join(input.data, "jitda.db")
  if (input.prefix) prefix = input.prefix
  Doc.setHost(host)
  // 짓다 문서 저장소를 못 열어도 서버는 떠야 한다. 이때 /api/jitda/doc 는 503 을 준다.
  try {
    Store.open(file, input.database === ":memory:" ? undefined : input.database)
    Doc.recover()
  } catch (error) {
    console.warn("[jitda.doc] doc store unavailable", file, String(error))
  }
}

const failures = new Map<string, NodeJS.Timeout>()

async function recordSession(sessionID: string, interrupted: boolean) {
  const info = await session(sessionID)
  const page = (await call("GET", `/api/session/${encodeURIComponent(sessionID)}/message?order=desc&limit=200`)) as {
    data?: Recorder.Message[]
  }
  const messages = (page?.data ?? []).slice().reverse()
  Recorder.record({ sessionID, directory: info?.directory, messages, interrupted })
}

function scheduleRecord(sessionID: string, interrupted: boolean) {
  const existing = failures.get(sessionID)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    failures.delete(sessionID)
    recordSession(sessionID, interrupted).catch((error) =>
      console.warn("[jitda.doc] cycle record failed", sessionID, String(error)),
    )
  }, 200)
  timer.unref?.()
  failures.set(sessionID, timer)
}

export function observe(event: { type?: string; data?: any }) {
  const data = event.data ?? {}
  switch (event.type) {
    case "form.replied":
    case "form.cancelled":
      if (typeof data.id === "string") Doc.questionDraftReset(data.id)
      return
    case "rpc.jitda.env-request.resolved":
      if (typeof data.requestID === "string") Doc.envDraftReset(data.requestID)
      return
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      if (typeof data.sessionID === "string")
        scheduleRecord(data.sessionID, event.type === "session.execution.interrupted" && data.reason === "user")
      return
  }
}

export function start(server: string, auth: string, listen: (handler: (event: any) => void) => void) {
  loopback = { server, auth }
  listen(observe)
  const close = () => Room.closeAll(Room.CLOSE_SESSION_ENDED, "session ended")
  process.once("SIGTERM", close)
  process.once("SIGINT", close)
}

function authorized(request: HttpServerRequest.HttpServerRequest, basic: string) {
  if (request.headers.authorization === basic) return true
  const token = new URL(request.url, "http://localhost").searchParams.get("auth_token")
  return token !== null && `Basic ${token}` === basic
}

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status })
const fail = (name: string, message: string, status: number) => json({ name, data: { message } }, status)

function failure(error: unknown) {
  if (error instanceof Doc.NotFoundError) return fail(error.name, error.message, 404)
  if (error instanceof Doc.VoteConflictError || error instanceof Doc.InvalidError)
    return fail(error.name, error.message, 400)
  return fail("UnknownError", error instanceof Error ? error.message : String(error), 500)
}

function mime(input: string) {
  const type = input.split(";")[0]?.trim().toLowerCase()
  return type && INLINE.has(type) ? type : "application/octet-stream"
}

const b64 = (input: Uint8Array) => Buffer.from(input).toString("base64")
const fromB64 = (value: string) => new Uint8Array(Buffer.from(value, "base64"))
const isPong = (data: string) => data.includes('"pong"')

const body = (request: HttpServerRequest.HttpServerRequest) =>
  request.json.pipe(
    Effect.map((value) => (value && typeof value === "object" ? (value as Record<string, any>) : {})),
    Effect.catch(() => Effect.succeed({} as Record<string, any>)),
  )

const string = (value: unknown): value is string => typeof value === "string" && value.length > 0
const optionalNumber = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)
const names = (value: unknown): Record<string, string> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(([, item]) => typeof item === "string"),
      ) as Record<string, string>)
    : undefined

function invalid(message = "Invalid request") {
  return fail("BadRequestError", message, 400)
}

const run = <A>(fn: () => A) =>
  Effect.try({ try: fn, catch: (error) => error }).pipe(
    Effect.map((value) => json(value ?? null)),
    Effect.catch((error) => Effect.succeed(failure(error))),
  )

function socket(
  request: HttpServerRequest.HttpServerRequest,
  open: (peer: { send: (data: string | Uint8Array) => void; close: (code?: number, reason?: string) => void }) => {
    message?: (data: string | Uint8Array) => void
    close?: () => void
  },
) {
  return Effect.gen(function* () {
    const ws = yield* Effect.orDie(request.upgrade)
    const outbox = yield* Queue.unbounded<Outbound>()
    let closed = false
    const peer = {
      send: (data: string | Uint8Array) => {
        if (closed) return
        Queue.offerUnsafe(outbox, data)
      },
      close: (code = 1000, reason?: string) => {
        if (closed) return
        closed = true
        Queue.offerUnsafe(outbox, new Socket.CloseEvent(code, reason))
      },
    }
    let handlers: ReturnType<typeof open> = {}
    const drain = Effect.gen(function* () {
      const writer = yield* ws.writer
      while (true) {
        const item = yield* Queue.take(outbox)
        yield* writer.write(item)
        if (item instanceof Socket.CloseEvent) return
      }
    })
    const read = Effect.gen(function* () {
      const reader = yield* ws.reader
      handlers = open(peer)
      while (true)
        yield* Effect.forEach(yield* reader.pull, (message) => Effect.sync(() => handlers.message?.(message)), {
          discard: true,
        })
    })
    yield* Effect.raceFirst(drain, read).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          closed = true
          handlers.close?.()
        }),
      ),
      Effect.catchCause(() => Effect.void),
    )
    return HttpServerResponse.empty()
  })
}

function text(message: string | Uint8Array) {
  return typeof message === "string" ? message : new TextDecoder().decode(message)
}

function bytes(message: string | Uint8Array) {
  return typeof message === "string" ? new TextEncoder().encode(message) : message
}

function events() {
  const stream = Stream.callback<string>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const write = (frame: string) => Queue.offerUnsafe(queue, frame)
        streams.add(write)
        Queue.offerUnsafe(queue, `data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`)
        return write
      }),
      (write) => Effect.sync(() => streams.delete(write)),
    ),
  )
  const heartbeat = Stream.tick("15 seconds").pipe(Stream.map(() => ": heartbeat\n\n"))
  return HttpServerResponse.stream(stream.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText), {
    contentType: "text/event-stream",
    headers: { "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
  })
}

function submitSocket(
  request: HttpServerRequest.HttpServerRequest,
  connect: (peer: { send: (data: string) => void; close: () => void }) => Doc.Handle | undefined,
) {
  return socket(request, (peer) => {
    const handle = connect({ send: (data) => peer.send(data), close: () => peer.close() })
    return {
      message: (message) => {
        if (isPong(text(message))) handle?.pong()
      },
      close: () => handle?.(),
    }
  })
}

const sessionRoute = Effect.fn("cli.jitda-doc.session")(function* (
  request: HttpServerRequest.HttpServerRequest,
  sessionID: string,
  rest: string[],
  query: URLSearchParams,
) {
  const method = request.method
  const route = rest.join("/")
  const upgrade = !!request.headers.upgrade

  if (method === "GET" && upgrade && route === "prompt-doc/submit/connect") {
    const docID = query.get("docID")
    const actorID = query.get("actorID")
    if (!Store.valid("doc", docID) || !Store.valid("act", actorID)) return invalid()
    const observer = query.get("observer") === "true" || query.get("observer") === "1"
    const found = yield* Effect.try({ try: () => Doc.get(docID), catch: (error) => error }).pipe(
      Effect.map(() => undefined),
      Effect.catch((error) => Effect.succeed(failure(error))),
    )
    if (found) return found
    return yield* submitSocket(request, (peer) => Doc.submitConnect({ sessionID, docID, actorID, observer, peer }))
  }
  if (method === "GET" && upgrade && route === "question/submit/connect") {
    const requestID = query.get("requestID")
    const actorID = query.get("actorID")
    if (!string(requestID) || !Store.valid("act", actorID)) return invalid()
    const observer = query.get("observer") === "true" || query.get("observer") === "1"
    return yield* submitSocket(request, (peer) =>
      Doc.questionSubmitConnect({ sessionID, requestID, actorID, observer, peer }),
    )
  }
  if (method === "GET" && upgrade && route === "question/draft/connect") {
    const requestID = query.get("requestID")
    const actorID = query.get("actorID")
    if (!string(requestID) || !Store.valid("act", actorID)) return invalid()
    return yield* socket(request, (peer) => {
      const handle = Doc.questionDraftConnect({
        sessionID,
        requestID,
        actorID,
        peer: { send: (data) => peer.send(data), close: () => peer.close() },
      })
      return {
        message: (message) => {
          const data = text(message)
          if (isPong(data)) return handle.pong()
          const parsed = (() => {
            try {
              return JSON.parse(data) as { type?: string; op?: Doc.QuestionDraftOp; entry?: Doc.QuestionPresenceEntry }
            } catch {
              return undefined
            }
          })()
          if (parsed?.type === "op" && parsed.op && typeof parsed.op === "object") {
            Doc.questionDraftApply({ sessionID, requestID, op: parsed.op })
            return
          }
          if (parsed?.type === "presence" && parsed.entry && typeof parsed.entry === "object")
            Doc.questionPresenceSet({ sessionID, requestID, entry: parsed.entry })
        },
        close: () => handle(),
      }
    })
  }
  if (method === "GET" && upgrade && route === "env-request/draft/connect") {
    const requestID = query.get("requestID")
    const actorID = query.get("actorID")
    const key = query.get("key")
    if (!string(requestID) || !Store.valid("act", actorID) || key === null) return invalid()
    return yield* socket(request, (peer) => {
      const handle = Doc.envDraftConnect({
        sessionID,
        requestID,
        actorID,
        key,
        peer: { send: (data) => peer.send(data), close: () => peer.close() },
      })
      return {
        message: (message) => {
          if (!handle) return
          const data = text(message)
          if (isPong(data)) return handle.pong()
          const parsed = (() => {
            try {
              return JSON.parse(data) as { type?: string; op?: Doc.EnvDraftOp; entry?: Doc.EnvPresenceEntry }
            } catch {
              return undefined
            }
          })()
          if (parsed?.type === "op" && (parsed.op?.kind === "key" || parsed.op?.kind === "value")) {
            if (typeof parsed.op.text !== "string") return
            Doc.envDraftApply({ sessionID, requestID, key, op: parsed.op })
            return
          }
          if (parsed?.type === "presence" && parsed.entry && typeof parsed.entry === "object")
            Doc.envPresenceSet({ sessionID, requestID, entry: parsed.entry })
        },
        close: () => handle?.(),
      }
    })
  }

  if (!(yield* Effect.promise(() => session(sessionID)))) return fail("NotFoundError", "Session not found", 404)

  if (method === "GET" && route === "prompt-doc") return yield* run(() => Doc.prompt(sessionID))
  if (method === "GET" && route === "actor") return yield* run(() => Doc.actorList(sessionID))
  if (method !== "POST") return fail("NotFoundError", "Not found", 404)

  const input = yield* body(request)
  if (route === "prompt-doc/advance")
    return yield* run(() =>
      Doc.promptAdvance({ sessionID, ...(string(input.clientID) ? { clientID: input.clientID } : {}) }),
    )
  if (route === "prompt-doc/ready") {
    if (!Store.valid("doc", input.docID)) return invalid()
    return yield* run(() =>
      Doc.promptReady({
        sessionID,
        docID: input.docID,
        ...(string(input.clientID) ? { clientID: input.clientID } : {}),
        ...(typeof input.init === "boolean" ? { init: input.init } : {}),
      }),
    )
  }
  if (route === "prompt-doc/submit") {
    if (!Store.valid("doc", input.docID) || !Store.valid("act", input.actorID)) return invalid()
    if (!input.prompt || typeof input.prompt !== "object" || typeof input.prompt.text !== "string")
      return invalid("Invalid prompt")
    return yield* run(() =>
      Doc.submitCreate({
        sessionID,
        docID: input.docID,
        actorID: input.actorID,
        names: names(input.names),
        prompt: input.prompt,
        timeoutMs: optionalNumber(input.timeoutMs),
      }),
    )
  }
  if (route === "prompt-doc/stop" || route === "prompt-doc/clear") {
    if (!Store.valid("doc", input.docID) || !Store.valid("act", input.actorID)) return invalid()
    const create = route === "prompt-doc/stop" ? Doc.stopSubmitCreate : Doc.clearSubmitCreate
    return yield* run(() =>
      create({
        sessionID,
        docID: input.docID,
        actorID: input.actorID,
        names: names(input.names),
        timeoutMs: optionalNumber(input.timeoutMs),
      }),
    )
  }
  if (route === "prompt-doc/revert") {
    if (!Store.valid("doc", input.docID) || !Store.valid("act", input.actorID)) return invalid()
    const redo = input.redo === true
    if (!redo && !string(input.messageID)) return invalid("Invalid revert target")
    return yield* run(() =>
      Doc.revertSubmitCreate({
        sessionID,
        docID: input.docID,
        actorID: input.actorID,
        names: names(input.names),
        ...(redo ? { redo } : { messageID: input.messageID }),
        timeoutMs: optionalNumber(input.timeoutMs),
      }),
    )
  }
  if (route === "question/submit") {
    const payload = input.payload
    if (!string(input.requestID) || !Store.valid("act", input.actorID)) return invalid()
    if (!payload || typeof payload !== "object" || typeof payload.requestID !== "string")
      return invalid("Invalid payload")
    return yield* run(() =>
      Doc.questionSubmitCreate({
        sessionID,
        requestID: input.requestID,
        actorID: input.actorID,
        names: names(input.names),
        payload: {
          requestID: payload.requestID,
          ...(Array.isArray(payload.answers) ? { answers: payload.answers } : {}),
          ...(typeof payload.reject === "boolean" ? { reject: payload.reject } : {}),
          ...(typeof payload.step === "number" ? { step: payload.step } : {}),
        },
        timeoutMs: optionalNumber(input.timeoutMs),
      }),
    )
  }
  const respond = route.match(/^(prompt-doc|question)\/submit\/([^/]+)\/respond$/)
  if (respond) {
    const action = input.action
    if (!Store.valid("act", input.actorID) || !["approve", "cancel", "exclude"].includes(action)) return invalid()
    return yield* run(() =>
      Doc.submitRespond({ sessionID, submitID: decodeURIComponent(respond[2]!), actorID: input.actorID, action }),
    )
  }
  if (route === "actor")
    return yield* run(() =>
      Doc.actorUpsert({
        sessionID,
        ...(Store.valid("act", input.actorID) ? { actorID: input.actorID } : {}),
        ...(string(input.userID) ? { userID: input.userID } : {}),
        ...(typeof input.name === "string" ? { name: input.name } : {}),
        ...(typeof input.color === "string" ? { color: input.color } : {}),
      }),
    )
  return fail("NotFoundError", "Not found", 404)
})

const docRoute = Effect.fn("cli.jitda-doc.doc")(function* (
  request: HttpServerRequest.HttpServerRequest,
  docID: string,
  rest: string[],
  query: URLSearchParams,
) {
  const method = request.method
  if (!Store.valid("doc", docID)) return invalid()
  const route = rest.join("/")
  if (method === "GET" && route === "connect" && request.headers.upgrade) {
    const missing = yield* Effect.try({ try: () => Doc.get(docID), catch: (error) => error }).pipe(
      Effect.map(() => undefined),
      Effect.catch((error) => Effect.succeed(failure(error))),
    )
    if (missing) return missing
    return yield* socket(request, (peer) => {
      const roomPeer: Room.Peer = { send: (data) => peer.send(data), close: (code, reason) => peer.close(code, reason) }
      const stop = Room.connect(docID, roomPeer)
      return {
        message: (message) => {
          const msg = Room.decode(bytes(message), docID)
          if (!msg) return
          if (msg.type === Room.MSG_DOC) {
            try {
              Doc.syncPush({ docID, guid: msg.guid, data: new Uint8Array(msg.data), peer: roomPeer })
            } catch (error) {
              console.warn("[jitda.doc] push failed", docID, String(error))
            }
            return
          }
          if (msg.type === Room.MSG_AWARENESS) Room.awareness(docID, new Uint8Array(msg.data), roomPeer)
        },
        close: () => stop(),
      }
    })
  }
  if (route === "sync" && method === "GET") {
    const state = query.get("state")
    const guid = query.get("guid") || docID
    return yield* Effect.try({
      try: () => Doc.syncPull({ docID, guid, state: state ? fromB64(state) : new Uint8Array() }),
      catch: (error) => error,
    }).pipe(
      Effect.map((result) => json(result ? { data: b64(result.data), state: b64(result.state) } : null)),
      Effect.catch((error) => Effect.succeed(failure(error))),
    )
  }
  if (route === "sync" && method === "POST") {
    const input = yield* body(request)
    if (!string(input.data)) return invalid()
    return yield* Effect.try({
      try: () => Doc.syncPush({ docID, guid: string(input.guid) ? input.guid : docID, data: fromB64(input.data) }),
      catch: (error) => error,
    }).pipe(
      Effect.map(() => HttpServerResponse.empty({ status: 204 })),
      Effect.catch((error) => Effect.succeed(failure(error))),
    )
  }
  if (route === "asset" && method === "POST") {
    const input = yield* body(request)
    if (!string(input.mime) || !string(input.data)) return invalid()
    const data = fromB64(input.data)
    if (data.byteLength > MAX_ASSET) return fail("BadRequestError", "Doc asset is too large", 400)
    return yield* Effect.try({
      try: () =>
        Doc.assetCreate({
          docID,
          ...(string(input.id) ? { assetID: input.id } : {}),
          mime: mime(input.mime),
          data,
        }),
      catch: (error) => error,
    }).pipe(
      Effect.map((asset) => {
        const next = new URL(`${prefix()}${PATH}/${docID}/asset/${asset.assetID}`, "http://opencode.internal")
        for (const key of ["directory", "workspace"]) {
          const value = query.get(key)
          if (value) next.searchParams.set(key, value)
        }
        return json({ ...asset, url: next.pathname + next.search })
      }),
      Effect.catch((error) => Effect.succeed(failure(error))),
    )
  }
  if (rest[0] === "asset" && rest.length === 2 && method === "GET") {
    return yield* Effect.try({
      try: () => Doc.assetGet({ docID, assetID: decodeURIComponent(rest[1]!) }),
      catch: (error) => error,
    }).pipe(
      Effect.map((asset) => {
        const type = mime(asset.mime)
        return HttpServerResponse.uint8Array(asset.data, {
          contentType: type,
          headers: {
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
            ...(type === "application/octet-stream"
              ? { "Content-Disposition": `attachment; filename="${asset.assetID.replace(/["\\\r\n]/g, "_")}"` }
              : {}),
          },
        })
      }),
      Effect.catch((error) => Effect.succeed(failure(error))),
    )
  }
  return fail("NotFoundError", "Not found", 404)
})

export function matches(pathname: string) {
  return pathname === PATH || pathname.startsWith(`${PATH}/`)
}

export const handle = Effect.fn("cli.jitda-doc.handle")(function* (
  request: HttpServerRequest.HttpServerRequest,
  basic: string,
) {
  if (!authorized(request, basic)) return fail("UnauthorizedError", "Authentication required", 401)
  if (!Store.ready()) return fail("UnknownError", "Doc store is not ready", 503)
  const url = new URL(request.url, "http://localhost")
  const parts = url.pathname
    .slice(PATH.length)
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part))
  if (request.method === "GET" && parts.length === 1 && parts[0] === "event") return events()
  if (request.method === "GET" && parts[0] === "cycle") {
    if (parts.length === 2) {
      const cycle = Recorder.get(parts[1]!)
      return cycle ? json(cycle) : fail("NotFoundError", "Prompt cycle not found", 404)
    }
    const limit = Number(url.searchParams.get("limit") ?? 100)
    const offset = Number(url.searchParams.get("offset") ?? 0)
    const status = url.searchParams.get("status") ?? undefined
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(offset) || offset < 0)
      return invalid()
    if (status && !(Recorder.STATUSES as readonly string[]).includes(status)) return invalid()
    return json(
      Recorder.list({
        sessionID: url.searchParams.get("sessionID") ?? undefined,
        docID: url.searchParams.get("docID") ?? undefined,
        status,
        limit,
        offset,
      }),
    )
  }
  if (parts[0] === "session" && parts[1])
    return yield* sessionRoute(request, parts[1], parts.slice(2), url.searchParams)
  if (parts[0]) return yield* docRoute(request, parts[0], parts.slice(1), url.searchParams)
  return fail("NotFoundError", "Not found", 404)
})

export * as JitdaDoc from "./jitda-doc"
