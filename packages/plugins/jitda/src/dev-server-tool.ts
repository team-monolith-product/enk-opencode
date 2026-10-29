import type { Plugin } from "@opencode/plugin"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { DevServer } from "./dev-server"
import DESCRIPTION from "./ensure-dev-server.txt"
import { ServeTargets } from "./serve-targets"
import * as Definitions from "./rpc"

type Context = Plugin.Context

const DEFAULT_LOG_LINES = 40

const HOST_HINT =
  "서버가 루프백(127.0.0.1)에만 바인딩돼 있어 미리보기 주소로는 열리지 않습니다. " +
  "쓰는 프레임워크에서 모든 주소(0.0.0.0)에 바인딩하는 옵션을 찾아 cmd 에 넣고 restart: true 로 다시 호출하세요."

type Payload = {
  status: "already_running" | "started" | "failed"
  url?: string
  port: number
  ms: number
  reason?: string
  recorded_cmd?: string
  hint?: string
}

type Input = { cwd?: string; cmd: string; ready_timeout_ms?: number; restart?: boolean }

export function input(directory: string) {
  const port = ServeTargets.forCwd(directory)?.port ?? ServeTargets.PORTS.project
  return {
    type: "object",
    properties: {
      cwd: { type: "string", description: `서버를 실행할 작업 디렉토리 (기본값 ${directory})` },
      cmd: {
        type: "string",
        description:
          `실행할 셸 명령. 포트는 반드시 ${port} 로 적는다. ` +
          `예: 'npm run dev -- --host 0.0.0.0 --port ${port}', 'npx --yes serve -l ${port} .'`,
      },
      ready_timeout_ms: {
        type: "number",
        description: "새로 띄울 때 LISTEN 시작을 기다리는 최대 시간(ms).",
        default: 15000,
      },
      restart: {
        type: "boolean",
        description:
          "true 면 포트를 잡고 있는 기존 서버를 종료하고 cmd 로 새로 띄운다. " +
          "cmd 를 고쳤거나 미리보기가 오류일 때 사용. bash 로 직접 죽이고 띄우지 말고 이 인자를 쓴다.",
        default: false,
      },
    },
    required: ["cmd"],
    additionalProperties: false,
  } as const
}

export async function ensure(
  directory: string,
  raw: Input,
  options: { signal?: AbortSignal; ask: (cmd: string, port: number) => Promise<void> },
) {
  const started = Date.now()
  const cwd = resolve(raw.cwd ?? directory)
  const target = ServeTargets.forCwd(cwd)
  const port = target?.port ?? ServeTargets.PORTS.project
  const timeout = raw.ready_timeout_ms ?? 15000
  const result = (payload: Payload) => ({ content: JSON.stringify(payload), metadata: payload })

  if (!existsSync(cwd))
    return result({ status: "failed", port, ms: Date.now() - started, reason: `cwd 가 존재하지 않습니다: ${cwd}` })

  const existing = await DevServer.loadRecord(cwd)
  const running = await DevServer.probePort(port)

  if (running && !raw.restart) {
    // 기록은 "재기동하면 이대로 뜬다"는 약속이라 검증된 커맨드만 담는다. 기록이 없을 때만 백필한다.
    if (!existing) await DevServer.record(directory, { cmd: raw.cmd, cwd, port })
    const hints: string[] = []
    if (existing && existing.cmd !== raw.cmd)
      hints.push(
        "실행 중인 서버는 기록된 명령으로 떠 있어 이번 cmd 는 반영되지 않았습니다. " +
          "이 cmd 로 바꾸려면 restart: true 로 다시 호출하세요.",
      )
    if ((await DevServer.reachableExternally(port)) === false) hints.push(HOST_HINT)
    return result({
      status: "already_running",
      url: DevServer.serveUrl(port, target?.kind),
      port,
      ms: Date.now() - started,
      ...(existing && existing.cmd !== raw.cmd ? { recorded_cmd: existing.cmd } : {}),
      ...(hints.length ? { hint: hints.join(" ") } : {}),
    })
  }

  await options.ask(raw.cmd, port)

  if (running && !(await DevServer.stop(port, existing?.pid)))
    return result({
      status: "failed",
      port,
      ms: Date.now() - started,
      reason: `포트 ${port} 를 점유한 기존 프로세스를 종료하지 못했습니다. 학생에게 어떤 프로세스가 포트를 쓰고 있는지 확인이 필요하다고 안내하세요.`,
    })

  const child = await DevServer.launch(raw.cmd, cwd, { dir: directory })
  const ready = await DevServer.waitForPort(port, timeout, options.signal)
  const ms = Date.now() - started
  if (!ready)
    return result({
      status: "failed",
      port,
      ms,
      reason: `포트 ${port} 가 ${timeout}ms 안에 LISTEN 되지 않았습니다. cmd 가 ${port} 에 바인딩하는지 확인하세요: ${raw.cmd}`,
    })

  await DevServer.record(directory, { cmd: raw.cmd, cwd, port, ...(child.pid ? { pid: child.pid } : {}) })
  return result({
    status: "started",
    url: DevServer.serveUrl(port, target?.kind),
    port,
    ms,
    ...((await DevServer.reachableExternally(port)) === false ? { hint: HOST_HINT } : {}),
  })
}

export const Rpc = Definitions.DevServer

export async function start(ctx: Context) {
  const directory = ctx.location.directory
  const registration = await ctx.rpc.register(Rpc, {
    status: async () => DevServer.status(directory),
    restart: async (_input, call) => DevServer.restart(directory, call.signal),
    logs: async (raw) => {
      const tail = Number((raw as { tail?: number }).tail)
      const lines = Number.isFinite(tail) && tail > 0 ? Math.trunc(tail) : DEFAULT_LOG_LINES
      const [rows, state] = await Promise.all([
        DevServer.readLog({ dir: directory, lines }),
        DevServer.loadRecord(directory),
      ])
      return { lines: rows, ...(state ? { cmd: state.cmd, port: state.port } : {}) }
    },
  })
  const tools = await ctx.tool.transform((editor) => {
    editor.add({
      name: "ensure_dev_server",
      description: DESCRIPTION,
      input: input(directory),
      options: { codemode: false },
      execute: (raw, call) =>
        ensure(directory, raw as Input, {
          signal: call.signal,
          ask: (cmd, port) =>
            ctx.permission.assert({
              sessionID: call.sessionID,
              agent: call.agent,
              action: "shell",
              resources: [cmd],
              save: [`ensure_dev_server :${port}`],
              source: { type: "tool", messageID: call.messageID, id: call.id },
            }),
        }),
    })
  })
  return async () => {
    await tools.dispose()
    await registration.dispose()
  }
}

export * as DevServerTool from "./dev-server-tool"
