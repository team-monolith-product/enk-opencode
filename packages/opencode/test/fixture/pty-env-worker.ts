import fs from "fs/promises"
import { Instance } from "../../src/project/instance"
import { Pty } from "../../src/pty"

/**
 * PTY 자식의 환경을 덤프해서 stdout 으로 돌려주는 워커.
 *
 * 별도 프로세스인 이유: 이 테스트가 재려는 건 **exec 시점 C `environ`** 의 상속이다. 테스트
 * 안에서 `process.env.X = v` 로 넣은 값은 `environ` 에 들어가지 않아 버그가 있든 없든 자식에
 * 안 보인다 — 그렇게 짠 테스트는 아무것도 증명하지 못하고 통과한다. 그래서 오염시킨 환경으로
 * 이 파일을 새로 exec 해야 한다.
 */
type Msg = {
  dir: string
  /** 덤프를 적을 파일. opencode 의 로그가 stdio 에 섞이므로 파일로 돌려준다. */
  out: string
}

function input() {
  const raw = process.argv[2]
  if (!raw) throw new Error("Missing pty env worker input")
  return JSON.parse(raw) as Msg
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function main() {
  const msg = input()

  await Instance.provide({
    directory: msg.dir,
    fn: async () => {
      // 덤프 전에 잠깐 쉰다. 즉시 끝나는 명령은 구독자가 붙기도 전에 출력이 지나가 버린다.
      const info = await Pty.create({ command: "/usr/bin/env", args: ["sh", "-c", "sleep 0.5; printenv"] })
      try {
        const chunks: string[] = []
        const ws = {
          readyState: 1,
          data: {},
          send: (data: unknown) => {
            chunks.push(typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8"))
          },
          close: () => {},
        }
        // 명령이 짧아서 출력이 순식간에 끝난다. 버퍼 되감기에 기대지 말고 먼저 붙는다.
        Pty.connect(info.id, ws as any)
        await sleep(1500)

        await fs.writeFile(msg.out, chunks.join(""))
      } finally {
        await Pty.remove(info.id)
      }
    },
  })
}

await main().catch((err) => {
  const text = err instanceof Error ? (err.stack ?? err.message) : String(err)
  process.stderr.write(text)
  process.exit(1)
})
