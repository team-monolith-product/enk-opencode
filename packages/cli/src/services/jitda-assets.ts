import { Assets } from "@opencode/plugin-jitda/assets"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { existsSync } from "node:fs"
import path from "node:path"
import type { Readable } from "node:stream"

// 업로드 폴더(__assets__) HTTP. 원본 바이트를 스트리밍으로 받아야 해서 JSON RPC 가 아니라 여기서 받는다.
export const PATH = "/api/jitda/assets"

function authorized(request: HttpServerRequest.HttpServerRequest, basic: string) {
  if (request.headers.authorization === basic) return true
  const token = new URL(request.url, "http://localhost").searchParams.get("auth_token")
  return token !== null && `Basic ${token}` === basic
}

const error = (message: string, status = 400) => HttpServerResponse.jsonUnsafe({ error: message }, { status })

export const handle = Effect.fn("cli.jitda-assets.handle")(function* (
  request: HttpServerRequest.HttpServerRequest,
  basic: string,
) {
  if (!authorized(request, basic)) return error("Authentication required", 401)
  const url = new URL(request.url, "http://localhost")
  const directory = url.searchParams.get("location[directory]") ?? url.searchParams.get("directory") ?? ""
  if (!path.isAbsolute(directory) || !existsSync(directory)) return error("Invalid directory")
  const target = url.searchParams.get("path") ?? undefined

  if (request.method === "GET") return HttpServerResponse.jsonUnsafe(Assets.snapshot(directory))
  if (request.method === "DELETE")
    return yield* Effect.promise(() =>
      Assets.remove(directory, target).then(
        () => HttpServerResponse.jsonUnsafe(true),
        (cause: Error) => error(cause.message),
      ),
    )
  if (request.method === "POST") {
    if (!target) return error("Invalid upload path")
    const declared = Number(request.headers["content-length"] ?? 0)
    const body = request.source as Readable
    return yield* Effect.promise(() =>
      Assets.upload(directory, target, declared, body).then(
        (entry) => HttpServerResponse.jsonUnsafe(entry),
        (cause: Error) => error(cause.message),
      ),
    )
  }
  return error("Method not allowed", 405)
})

export * as JitdaAssets from "./jitda-assets"
