import * as Definitions from "@opencode/plugin-jitda/rpc"
import { useLocation } from "@solidjs/router"
import { createSimpleContext } from "@opencode/ui/context"
import { createResource, type ParentProps } from "solid-js"
import { authTokenFromCredentials } from "@/runtime/server/api"
import { useServer } from "@/runtime/server/current"
import { usePlatform } from "@/runtime/platform/platform"
import type { DocApi } from "./composer/doc-submit"

export type ClientEnv = {
  serveDomain?: string
  jupyterhubUser?: string
  environment?: string
  aiModel?: string
  aiModelVariant?: string
}

export type Identity = { id: string; name?: string; color?: string }

// 호스트(짓다 프론트)가 `?user=id||이름||색` 으로 넘긴 신원. 이름·색은 비어 있을 수 있다.
export function parseIdentity(raw: string | null | undefined): Identity | undefined {
  if (!raw) return undefined
  const [id, name, color] = raw.split("||")
  if (!id?.trim()) return undefined
  return { id: id.trim(), name: name?.trim() || undefined, color: color?.trim() || undefined }
}

const context = createSimpleContext({
  name: "Jitda",
  init: (props: { directory: string; sessionID: string }) => {
    const server = useServer()
    const platform = usePlatform()
    const location = useLocation()
    const api = server.ctx.sdk.api
    const options = () => ({ location: { directory: props.directory } })
    const rpc = {
      session: api.rpc(Definitions.Session),
      image: api.rpc(Definitions.Image),
      devServer: api.rpc(Definitions.DevServer),
      envRequest: api.rpc(Definitions.EnvRequest),
      envFile: api.rpc(Definitions.EnvFile),
      env: api.rpc(Definitions.Env),
      github: api.rpc(Definitions.Github),
      projectSummary: api.rpc(Definitions.ProjectSummary),
    }
    const http = server.conn.type === "http" ? server.conn.http : undefined
    const token = http?.password ? authTokenFromCredentials({ password: http.password }) : undefined
    const base = () => (http?.url ?? "").replace(/\/+$/, "")

    // 짓다 전용 HTTP(/api/jitda/...). 웹(hub) 에서는 쿠키로, 로컬 개발에서는 Basic 으로 인증한다.
    const request = (path: string, init?: RequestInit & { query?: Record<string, string | undefined> }) => {
      const url = new URL(`${base()}${path}`, window.location.href)
      url.searchParams.set("directory", props.directory)
      for (const [key, value] of Object.entries(init?.query ?? {}))
        if (value !== undefined) url.searchParams.set(key, value)
      const headers = new Headers(init?.headers)
      if (token) headers.set("authorization", `Basic ${token}`)
      return (platform.fetch ?? fetch)(url, { ...init, headers, credentials: "include" })
    }

    // 브라우저 WebSocket 은 헤더를 못 실으므로 로컬에서는 auth_token 쿼리로 인증한다(서버 jitda-doc 이 받는다).
    const socket = (path: string, query: Record<string, string | undefined>) => {
      const url = new URL(`${base()}${path}`, window.location.href)
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
      url.searchParams.set("directory", props.directory)
      for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value)
      if (token) url.searchParams.set("auth_token", token)
      return url.toString()
    }

    const doc: DocApi = {
      url: (path) => {
        const url = new URL(`${base()}/api/jitda/doc${path}`, window.location.href)
        url.searchParams.set("directory", props.directory)
        return url
      },
      socket: (path) => new URL(socket(`/api/jitda/doc${path}`, {})),
      headers: (): Record<string, string> => (token ? { authorization: `Basic ${token}` } : {}),
    }

    const [env] = createResource(
      () => props.directory,
      () =>
        rpc.env
          .get({}, options())
          .then((value: unknown) => (value ?? {}) as ClientEnv)
          .catch(() => ({}) as ClientEnv),
    )

    const query = () => new URLSearchParams(location.search)

    return {
      get directory() {
        return props.directory
      },
      get sessionID() {
        return props.sessionID
      },
      rpc,
      options,
      request,
      socket,
      doc,
      env: () => env() ?? {},
      identity: () => parseIdentity(query().get("user")),
      locale: () => query().get("locale") ?? undefined,
      readonly: () => query().get("readonly") === "true",
      tutorial: () => props.directory.split("/").includes("tutorial-directory"),
    }
  },
})

export const useJitda = context.use

export function JitdaProvider(props: ParentProps<{ directory: string; sessionID: string }>) {
  return (
    <context.provider directory={props.directory} sessionID={props.sessionID}>
      {props.children}
    </context.provider>
  )
}
