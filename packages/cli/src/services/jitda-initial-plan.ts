import { ServeTargets } from "@opencode/plugin-jitda/serve-targets"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"

// 최초 기획 전달 HTTP(V1 POST /enk/initial-plan/deliver). 로직은 @opencode/plugin-jitda 의 jitda.initial-plan RPC 에 있고,
// 요청이 어느 디렉터리(튜토리얼 화면이어도)에서 왔든 본행사 프로젝트 위치로 루프백한다.

export const PATH = "/api/jitda/initial-plan/deliver"
const RPC = "/api/rpc/jitda.initial-plan/deliver"
const STATES = new Set(["delivered", "already_delivered", "not_finalized", "pending_elsewhere", "failed"])

type Loopback = { server: string; auth: string }
let loopback: Loopback | undefined

export function start(server: string, auth: string) {
  loopback = { server, auth }
}

export function directory(requested: string | null, env: NodeJS.ProcessEnv = process.env) {
  return ServeTargets.project(env)?.dir ?? (requested || undefined)
}

type Output = { state?: unknown; error?: unknown; unavailable?: unknown }

async function rpc(target: string, server: Loopback) {
  const res = await fetch(`${server.server}${RPC}`, {
    method: "POST",
    headers: {
      authorization: server.auth,
      "content-type": "application/json",
      "x-opencode-directory": encodeURIComponent(target),
    },
    body: JSON.stringify({ input: {} }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(text || `initial plan RPC failed with ${res.status}`)
  return ((text ? JSON.parse(text) : {}) as { output?: Output }).output
}

export async function deliver(
  target: string,
): Promise<{ status: number; body: { state: string } | { error: string } }> {
  if (!loopback) return { status: 503, body: { error: "jitda server is not ready" } }
  const output: Output | undefined = await rpc(target, loopback).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }))
  if (typeof output?.state === "string" && STATES.has(output.state))
    return { status: 200, body: { state: output.state } }
  const error = typeof output?.error === "string" ? output.error : "initial plan delivery failed"
  return { status: output?.unavailable === true ? 503 : 502, body: { error } }
}

function authorized(request: HttpServerRequest.HttpServerRequest, basic: string) {
  return request.headers.authorization === basic
}

export const handle = Effect.fn("cli.jitda-initial-plan.handle")(function* (
  request: HttpServerRequest.HttpServerRequest,
  basic: string,
) {
  if (!authorized(request, basic))
    return HttpServerResponse.jsonUnsafe({ error: "Authentication required" }, { status: 401 })
  if (request.method !== "POST") return HttpServerResponse.jsonUnsafe({ error: "Method not allowed" }, { status: 405 })
  const url = new URL(request.url, "http://localhost")
  const target = directory(url.searchParams.get("directory"))
  if (!target) return HttpServerResponse.jsonUnsafe({ error: "Invalid directory" }, { status: 400 })
  const result = yield* Effect.promise(() => deliver(target))
  return HttpServerResponse.jsonUnsafe(result.body, { status: result.status })
})

export * as JitdaInitialPlan from "./jitda-initial-plan"
