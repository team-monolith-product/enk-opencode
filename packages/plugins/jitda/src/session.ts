import type { Plugin } from "@opencode/plugin"
import * as Definitions from "./rpc"

// 작업 폴더마다 보관되지 않은 메인(루트) 세션을 하나만 둔다. 팀원이 모두 같은 대화에서 만나야 하기 때문이다.
// 처음 열릴 때 없으면 만들고, 대화를 지울 때는 실행을 먼저 끊고 보관한 뒤 대체 세션을 하나만 만든다.
// 같은 폴더로 동시에 들어온 요청은 하나로 묶는다(여럿이 동시에 지워도 대체 세션은 하나다).

type Context = Plugin.Context

type Info = { id: string; parentID?: string; time: { archived?: number }; location: { directory: string } }

export function createMain(api: { list: () => Promise<Info[]>; create: () => Promise<Info> }) {
  let pending: Promise<Info> | undefined
  const active = async (exclude?: string) =>
    (await api.list()).filter((session) => !session.parentID && !session.time.archived && session.id !== exclude)
  const main = async (exclude?: string) => {
    const [existing] = await active(exclude)
    if (existing) return existing
    pending ??= api.create().finally(() => (pending = undefined))
    return pending
  }
  return { active, main }
}

export const Rpc = Definitions.Session

const mains = new WeakMap<Context, ReturnType<typeof createMain>>()

// 같은 플러그인 컨텍스트(작업 폴더)에서는 메인 세션 판정과 생성 묶음을 하나만 쓴다(최초 기획 전달도 여기로 간다).
export function mainOf(ctx: Context) {
  const known = mains.get(ctx)
  if (known) return known
  const directory = ctx.location.directory
  const created = createMain({
    list: async () =>
      (
        (await ctx.session.list({ parentID: null, archived: false, directory, order: "desc", limit: 50 }))
          .data as unknown as Info[]
      ).filter((session) => session.location.directory === directory),
    create: async () => (await ctx.session.create({ location: { directory } })) as unknown as Info,
  })
  mains.set(ctx, created)
  return created
}

export async function start(ctx: Context) {
  const directory = ctx.location.directory
  const sessions = mainOf(ctx)

  const archived = new Set<string>()
  const archive = async (sessionID: string) => {
    if (archived.has(sessionID)) return false
    const session = (await ctx.session.get({ sessionID })) as unknown as Info
    if (session.time.archived) return false
    archived.add(sessionID)
    await ctx.session.interrupt({ sessionID }).catch(() => undefined)
    await ctx.session.update({ sessionID, archived: true })
    return true
  }

  const registration = await ctx.rpc.register(Rpc, {
    main: async () => JSON.parse(JSON.stringify(await sessions.main())),
    archive: async (input) => {
      const ok = await archive((input as { sessionID: string }).sessionID)
      const sessionID = (input as { sessionID: string }).sessionID
      return { archived: ok, main: JSON.parse(JSON.stringify(await sessions.main(sessionID))) }
    },
    remove: async (input) => {
      const sessionID = (input as { sessionID: string }).sessionID
      await ctx.session.interrupt({ sessionID }).catch(() => undefined)
      await ctx.session.remove({ sessionID })
      return { main: JSON.parse(JSON.stringify(await sessions.main(sessionID))) }
    },
  })

  void sessions.main().catch((error) => console.warn("[jitda.session] ensure failed", String(error)))

  const controller = new AbortController()
  void (async () => {
    while (!controller.signal.aborted) {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const value = event as { type: string; location?: { directory?: string } }
          if (value.location?.directory !== directory) continue
          if (value.type === "session.archived" || value.type === "session.deleted")
            void sessions.main().catch(() => undefined)
        }
      } catch {
        if (controller.signal.aborted) return
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  })()

  return async () => {
    controller.abort()
    await registration.dispose()
  }
}

export * as Session from "./session"
