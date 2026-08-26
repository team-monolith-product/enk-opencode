import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { Session } from "./index"

type MainInput = NonNullable<Parameters<typeof Session.create>[0]>

const pending = new Map<string, Promise<Session.Info>>()
const ensuring = new Map<string, Promise<void>>()

function active(dir: string) {
  return [...Session.list({ directory: dir, roots: true })].filter((s) => !s.time?.archived)
}

export async function getOrCreateMain(input?: MainInput) {
  if (input?.parentID) return Session.create(input)

  const config = await Config.get()
  if (!config.ensureOneSession) return Session.create(input)

  const dir = Instance.directory
  const existing = active(dir)
  if (existing[0]) return existing[0]

  const inflight = pending.get(dir)
  if (inflight) return inflight

  const task = Session.create(input).finally(() => pending.delete(dir))
  pending.set(dir, task)
  return task
}

export async function ensureSession() {
  const dir = Instance.directory

  // 같은 디렉터리로 동시에 들어온 요청은 하나로 묶는다. 같은 세션을 함께 보던 사람들이 동시에
  // 지우기를 누르면 보관 요청이 여러 개 오는데, ensureOneSession 이 꺼진 워크스페이스에서는
  // getOrCreateMain 이 곧장 세션을 만들어 대체 세션이 여러 개 생긴다. 그러면 먼저 받은 쪽과
  // 나중에 받은 쪽이 서로 다른 세션으로 흩어진다 — 대체 세션은 언제나 하나여야 한다.
  const inflight = ensuring.get(dir)
  if (inflight) return inflight

  const task = createWhenEmpty(dir).finally(() => ensuring.delete(dir))
  ensuring.set(dir, task)
  return task
}

async function createWhenEmpty(dir: string) {
  const config = await Config.get()
  if (!config.ensureSession) return

  if (active(dir).length > 0) return

  await getOrCreateMain()
}
