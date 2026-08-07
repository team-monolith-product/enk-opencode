import { readFileSync, unlinkSync } from "fs"

/**
 * exec 시점 environ 에 실려 온 시크릿을 런타임 환경으로 옮긴다.
 *
 * 리눅스의 `/proc/<pid>/environ` 은 exec 당시의 스택 영역을 그대로 보여준다. 프로세스가 나중에
 * unsetenv 를 해도 그 파일에는 남아 있어서, 같은 uid 로 도는 에이전트 셸이 `cat /proc/1/environ`
 * 한 줄로 컨테이너에 주입된 시크릿을 통째로 읽을 수 있다. ChildEnv 필터도 Permission 가드도 이
 * 경로는 못 막는다 — 자식 환경이 아니라 **부모 프로세스의 메모리**이기 때문이다.
 *
 * 그래서 컨테이너 entrypoint(docker/entrypoint.sh)가 순서를 바꾼다.
 *
 *   1. entrypoint 가 시크릿 이름/값을 개인 파일에 적는다
 *   2. 그 이름들을 **지운 채로** opencode 를 exec 한다 → /proc/<pid>/environ 이 깨끗하다
 *   3. opencode 가 부팅 첫 순간 이 모듈에서 파일을 읽어 process.env 로 복원하고 파일을 지운다
 *
 * 런타임에 넣은 값은 `/proc/<pid>/environ` 에 나타나지 않는다(그 파일은 exec 시점 스냅샷이다).
 * 그래서 opencode 는 값을 그대로 쓰면서도 파일로는 새지 않고, 자식 프로세스로는 ChildEnv 가
 * 막는다. 세 층이 서로 다른 경로를 덮는다.
 *
 * 파일 형식은 한 줄에 `NAME base64(value)` 다. 값에 개행이나 따옴표가 섞여도 파싱이 흔들리지
 * 않게 base64 로 감싼다 — 부팅 첫 줄에서 도는 코드라 파서가 틀릴 여지를 아예 없앤다.
 *
 * 이 모듈은 src/index.ts 의 **첫 import** 여야 한다. ESM 은 import 를 선언 순서로 평가하므로
 * flag.ts 처럼 모듈 로드 시점에 process.env 를 읽어 상수로 굳히는 코드보다 먼저 돌아야 한다.
 */
export namespace BootEnv {
  export const VAR = "OPENCODE_BOOT_ENV"

  export function parse(text: string) {
    const out: Record<string, string> = {}
    for (const line of text.split("\n")) {
      const i = line.indexOf(" ")
      if (i <= 0) continue
      out[line.slice(0, i)] = Buffer.from(line.slice(i + 1), "base64").toString("utf8")
    }
    return out
  }

  /** 파일을 읽어 환경에 얹고 지운다. 읽은 이름들을 돌려준다. */
  export function load(file: string, env: NodeJS.ProcessEnv = process.env) {
    let text = ""
    try {
      text = readFileSync(file, "utf8")
    } catch {
      // 파일이 없으면 entrypoint 를 안 거친 실행이거나 이미 읽힌 뒤다. 둘 다 정상이다.
      return []
    }
    // 읽자마자 지운다. 같은 uid 로 도는 셸에게 노출되는 창을 부팅 순간으로 좁힌다.
    try {
      unlinkSync(file)
    } catch {}
    const values = parse(text)
    for (const [name, value] of Object.entries(values)) env[name] = value
    return Object.keys(values)
  }
}

const file = process.env[BootEnv.VAR]
if (file) {
  BootEnv.load(file)
  // 자식이 이미 비워진 파일을 다시 찾지 않게 한다. ChildEnv 도 OPENCODE_ 접두사로 막지만
  // 그 필터를 안 타는 경로가 있어도 흔적이 남지 않는 편이 낫다.
  delete process.env[BootEnv.VAR]
}
