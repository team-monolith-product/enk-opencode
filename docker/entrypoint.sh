#!/bin/sh
# opencode 를 띄우기 전에 시크릿을 exec 시점 environ 에서 걷어낸다.
#
# 리눅스의 /proc/<pid>/environ 은 exec 당시 스택을 그대로 보여준다. 프로세스가 나중에 unsetenv 를
# 해도 남아 있어서, 같은 uid 로 도는 에이전트 셸이 `cat /proc/1/environ` 한 줄로 컨테이너에 주입된
# 시크릿을 통째로 읽는다. 자식 환경 필터(ChildEnv)도 권한 가드도 이 경로는 못 막는다.
#
#   1. 시크릿 이름/값을 0600 파일에 적는다 (한 줄에 `NAME base64(value)`)
#   2. 그 이름들을 지운 채로 opencode 를 exec 한다 → /proc/<pid>/environ 이 깨끗해진다
#   3. opencode 가 부팅 첫 줄에서 파일을 읽어 process.env 로 복원하고 지운다 (src/boot/env.ts)
#
# 런타임에 넣은 값은 /proc 의 그 파일에 나타나지 않으므로, opencode 는 값을 그대로 쓰면서도
# 파일로는 새지 않는다.
#
# 옮길 대상은 이름이 시크릿처럼 보이는 것 전부 + OPENCODE_SCRUB_ENV 에 쉼표로 적은 이름이다.
# 넓게 잡아도 안전하다 — 값을 지우는 게 아니라 전달 경로만 바꾸므로 opencode 는 그대로 다 본다.
set -eu

boot="${TMPDIR:-/tmp}/opencode-boot-$$.env"
extra="${OPENCODE_SCRUB_ENV:-}"

# 하드닝 때문에 컨테이너가 안 뜨는 게 더 나쁘다. 도구나 쓰기 권한이 없으면 경고만 남기고
# 예전처럼 그대로 띄운다.
if ! command -v awk > /dev/null 2>&1 || ! command -v base64 > /dev/null 2>&1; then
  echo "opencode-entrypoint: awk/base64 not found, starting without env scrubbing" >&2
  exec "$@"
fi

# 0600 으로 만든다. 읽는 창은 opencode 가 부팅 첫 줄에서 지울 때까지의 한순간이다.
umask 077
if ! : > "$boot" 2> /dev/null; then
  echo "opencode-entrypoint: cannot write $boot, starting without env scrubbing" >&2
  exec "$@"
fi

# ENVIRON 순회는 값에 개행이 섞여도 흔들리지 않는다 (`env` 출력 파싱과 다른 점).
names=$(awk 'BEGIN { for (k in ENVIRON) print k }' < /dev/null | sort)

scrub=""
for name in $names; do
  keep=0
  # 키워드는 src/util/child-env.ts 의 DENY_RE 와 맞춘다. 한쪽만 아는 이름이 생기면
  # "자식 환경에서는 걸러지는데 /proc/<pid>/environ 에는 남는" 틈이 된다.
  case "$name" in
  *TOKEN* | *KEY* | *SECRET* | *PASSWORD* | *PASSWD* | *CREDENTIAL* | *PRIVATE* | *AUTH*) keep=1 ;;
  esac
  case ",$extra," in
  *",$name,"*) keep=1 ;;
  esac
  [ "$keep" = 1 ] || continue

  value=$(awk -v k="$name" 'BEGIN { printf "%s", ENVIRON[k] }' < /dev/null | base64 | tr -d '\n')
  printf '%s %s\n' "$name" "$value" >> "$boot"
  scrub="$scrub -u $name"
done

export OPENCODE_BOOT_ENV="$boot"

# 이름에는 공백이 없으므로 $scrub 의 단어 분리는 의도된 것이다.
# shellcheck disable=SC2086
exec env $scrub "$@"
