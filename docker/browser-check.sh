#!/bin/sh
# 에이전트가 학생 앱을 브라우저로 한 번에 점검하는 명령.
#
#   browser-check [-s] [URL] [대기ms] [-- 동작 ...]
#     URL     기본 http://localhost:3000
#     대기ms  접속(load) 뒤, 그리고 동작 뒤 늦게 나는 콘솔/에러를 기다리는 시간, 기본 300
#     -s      화면 구조(클릭·입력 가능한 요소와 ref)도 함께 출력
#     동작    접속한 뒤 차례로 실행할 agent-browser 명령. 예:
#             browser-check http://localhost:3000 -- "find placeholder 이메일 fill a@b.c" "find role button click --name '로그인'"
#
# 접속부터 조회까지 agent-browser batch 한 번으로 끝낸다. 에이전트 셸이 격리(bwrap --unshare-pid)
# 안에서 돌면 명령이 끝날 때 agent-browser 데몬과 브라우저도 함께 죽어서, 따로따로 부르면 앞에서
# 쌓인 콘솔/에러가 사라지기 때문이다.
#
# 브라우저는 닫지 않는다. 격리가 없으면 다음 점검이 떠 있는 브라우저를 그대로 써서 빠르고(약 0.4초,
# 새로 띄우면 약 1.1초), 쓰지 않으면 AGENT_BROWSER_IDLE_TIMEOUT_MS 뒤에 내려간다. 대신 앞 점검의 기록이
# 남아 있으므로 이번 점검에서 생긴 것만 골라 보여 준다.
#
# 다만 마지막으로 연 학생 앱은 탭에서 계속 돈다. 앱에 메모리 누수가 있으면 아무도 안 보는데 Chrome 이
# 계속 커지므로, 점검 뒤 BROWSER_CHECK_RELEASE_SEC(기본 60초) 동안 다음 점검이 없으면 그 탭을 빈 탭으로
# 바꿔 닫는다(release). 고치고 다시 점검하는 연속 점검 중에는 건드리지 않는다. about:blank 로 이동만
# 해서는 앱이 멈출 뿐 쓰던 메모리가 돌아오지 않아(재 보니 300MB 그대로) 탭을 닫는다(84MB 로 줄었다).
# 정리된 뒤의 첫 점검은 탭을 새로 여는 셈이라 약 0.2초 더 걸린다.
#   - 에러/콘솔: 접속 직전에 지금 떠 있는 페이지에서 이번 점검만의 표식(숫자)을 콘솔과 에러에 하나씩
#     찍고, 그 표식 뒤의 기록만 보여 준다. (0.39.4 에는 에러 기록 비우기가 없어 `errors --clear` 가
#     아무것도 안 하고, 기록에 시각도 없다.) 기록은 각 1,000개까지만 남고 넘치면 오래된 것부터
#     지워지는데, 표식은 개수와 상관없이 경계를 정확히 잡는다. 표식이 없으면(이번 점검에서만 1,000개를
#     넘겨 밀려났거나, 앞 페이지가 console.log 를 바꿔 치웠거나) 상한에 닿아 있으면 남은 전부를,
#     아니면 접속 전 개수 이후를 보여 주고, 상한에 닿았으면 앞부분이 빠졌을 수 있다고 표시한다.
#     (콘솔이 이미 상한인데 앞 페이지가 console.log 를 치웠다면 예전 로그가 섞일 수 있다. 드물어서 둔다.)
#     빈 페이지(about:blank)로 먼저 옮기지 않는 이유: 다른 주소로 옮기는 데 약 0.5초가 들지만, 같은
#     주소를 다시 여는 건 0.1초가 안 걸린다.
#   - 요청: 비우기가 믿을 만하지 않아 접속 전에 있던 요청 ID 를 뺀다. 브라우저 캐시 때문에 두 번째
#     점검부터는 favicon 같은 캐시된 요청의 404 가 다시 나오지 않을 수 있다.
#
# 동시에 하나만 돈다. 에이전트가 batch 도구로 browser-check 를 여러 번 동시에 부르면 같은 브라우저를
# 서로 조작해 결과가 섞이므로 잠금(flock)으로 차례를 지킨다. 호출마다 세션을 따로 쓰면 그때마다
# Chrome 이 새로 떠 학생 컨테이너에 여러 개가 쌓이므로 그렇게 하지 않는다.
#
# 결과는 --json 으로 받아 jq 로 추린다. agent-browser 0.39.4 의 errors 텍스트 출력은 잡힌 에러를
# 빈 줄로 찍는 버그가 있고, JSON 에는 실행 상태(lifecycle)와 요청 헤더 전체가 섞여 있어 그대로
# 보여 주면 길기만 하다.
set -eu

dir="${TMPDIR:-/tmp}/browser-check"
mkdir -p "$dir"
# agent-browser 는 처음 부를 때 데몬을 띄우는데, 그 데몬이 잠금 fd(9) 를 물려받으면 이 점검이 끝나도
# 잠금이 안 풀려 다음 점검이 2분을 꼬박 기다린다. 그래서 agent-browser 에는 fd 9 를 닫아서 넘긴다.
ab() { agent-browser "$@" 9>&-; }

# 내부용: browser-check --release 초 표식. 점검이 끝날 때 뒤에서 스스로 띄운다(위 release 설명).
if [ "${1:-}" = "--release" ]; then
  sleep "$2"
  # 그 사이 다음 점검이 있었으면 그 점검이 다시 예약했으니 그만둔다.
  [ "$(cat "$dir/.last" 2> /dev/null)" = "$3" ] || exit 0
  # 지금 점검이 도는 중이면 기다리지 않고 그만둔다(그 점검이 끝나며 다시 예약한다).
  if command -v flock > /dev/null 2>&1; then
    exec 9> "$dir/.lock"
    flock -n 9 || exit 0
  fi
  [ "$(cat "$dir/.last" 2> /dev/null)" = "$3" ] || exit 0
  # 데몬이 이미 내려갔으면(유휴 종료, 격리로 함께 죽음 등) 부르지 않는다. 부르면 탭 하나 닫자고
  # Chrome 을 새로 띄운다.
  pgrep -f 'bin/agent-browser-' > /dev/null 2>&1 || exit 0
  old=$(ab --json tab list | jq -r '.data.tabs[] | select(.active) | .tabId' 2> /dev/null) || exit 0
  [ -n "$old" ] || exit 0
  ab tab new > /dev/null 2>&1 && ab tab close "$old" > /dev/null 2>&1
  exit 0
fi

snapshot=0
url="http://localhost:3000"
wait_ms=300
n=0
while [ $# -gt 0 ]; do
  case "$1" in
    -s) snapshot=1 ;;
    --)
      shift
      break
      ;;
    *)
      [ "$n" = 0 ] && url="$1"
      [ "$n" = 1 ] && wait_ms="$1"
      n=$((n + 1))
      ;;
  esac
  shift
done
# 여기서 남은 "$@" 가 동작 단계다.
actions=$#

# 차례 지키기. flock 은 이미지(Debian util-linux)에 있다. 없는 곳(macOS 로컬 개발)에서는 잠금 없이 돈다.
# 앞 점검이 멈춰 있어도 영원히 기다리지 않도록 2분까지만 기다린다.
if command -v flock > /dev/null 2>&1; then
  exec 9> "$dir/.lock"
  if ! flock -w 120 9; then
    echo "browser-check: 다른 browser-check 가 2분 넘게 끝나지 않습니다. 잠시 뒤 다시 실행하세요." >&2
    exit 1
  fi
fi
# 스크린샷은 최근 20장만 남긴다. 점검마다 한 장씩 쌓여 오래 쓰는 컨테이너의 /tmp 를 채우지 않게.
# 파일 이름은 날짜-PID 라 공백이 없다.
# shellcheck disable=SC2012
ls -1t "$dir"/*.png 2> /dev/null | tail -n +20 | xargs rm -f
shot="$dir/$(date +%Y%m%d-%H%M%S)-$$.png"

# 이번 점검의 표식. batch 문자열은 따옴표가 벗겨지므로 따옴표가 필요 없는 숫자만 쓴다.
# JS 숫자는 16자리를 넘으면 반올림돼 찍힌 표식이 달라지므로, 시각은 끝 6자리만 쓴다. 자릿수를 6으로 채워
# 시각과 PID 경계를 고정하고(안 그러면 5+12 와 51+2 가 같다), 0 으로 시작하면 JS 가 8진수로 읽으므로 1 을
# 앞에 붙인다(1 + 6 + PID 최대 7 = 14자리).
mark="1$(printf '%06d' $(($(date +%s) % 1000000)))$$"

# 앞의 네 단계(접속 전 기록 셋, 표식)가 준비, 뒤의 같은 이름 단계가 접속(과 동작) 후 기록이다.
# 접속 전 요청 목록 조회는 요청 기록도 켠다(기본은 꺼져 있다). 접속 전 에러/콘솔 개수는 표식을 못 찍은
# 경우(앞 페이지가 console.log 를 바꿔 치운 경우 등)에 예전처럼 개수로 자르는 데 쓴다.
# 브라우저를 닫는 `close` 는 넣지 않는다. batch 안에서 close 하면 데몬이 내려가 뒤 단계가 다 실패한다.
# 단계 하나라도 실패하면(서버가 안 떠 있는 경우, 요소를 못 찾은 경우 등) batch 는 1 로 끝나지만,
# 실패 내용은 JSON 에 들어 있으므로 멈추지 않고 그대로 보여 준다.
# 에러 표식은 이벤트 리스너 안에서 던진다. reportError 나 console 은 앱이 바꿔 치울 수 있지만 리스너에서
# 난 예외는 브라우저가 직접 잡지 않은 예외로 기록한다. (공백이 없도록 new(X) 형태로 쓴다.)
set -- "errors" "console" "network requests" \
  "eval console.log($mark);(t=>{t.addEventListener($mark,()=>{throw(new(Error)($mark))});t.dispatchEvent(new(Event)($mark))})(new(EventTarget))" \
  "open $url" "wait $wait_ms" "$@"
if [ "$actions" -gt 0 ]; then
  set -- "$@" "wait $wait_ms"
fi
set -- "$@" "errors" "console" "network requests" "screenshot $shot"
if [ "$snapshot" = 1 ]; then
  set -- "$@" "snapshot -i -c"
fi
run() { ab batch --json "$@" 2>&1 || true; }
is_result() { printf '%s' "$1" | jq -e 'type == "array"' > /dev/null 2>&1; }

out=$(run "$@")
# 닫히는 중이거나 막 죽은 데몬에 붙으면 결과 대신 오류 객체(outcome_unknown)가 온다. 새 데몬이
# 뜨도록 잠깐 두고 한 번만 다시 부른다. 단 동작(클릭·입력)이 있으면 첫 실행에서 이미 눌렸을 수 있어
# (폼 두 번 제출 등) 다시 부르지 않고 알린다.
if ! is_result "$out" && [ "$actions" = 0 ]; then
  sleep 1
  out=$(run "$@")
fi
# 이번 점검을 마지막 점검으로 적고, 일정 시간 뒤 탭 정리를 예약한다. 잠금 fd(9) 와 출력은 넘기지 않는다
# (물려받으면 정리를 기다리는 동안 잠금이 안 풀리고, 셸 도구가 그 출력이 닫히기를 기다린다).
printf '%s' "$mark" > "$dir/.last"
release_sec="${BROWSER_CHECK_RELEASE_SEC:-60}"
if [ "$release_sec" -gt 0 ] 2> /dev/null; then
  if command -v setsid > /dev/null 2>&1; then
    setsid -f sh "$0" --release "$release_sec" "$mark" < /dev/null > /dev/null 2>&1 9>&-
  else
    nohup sh "$0" --release "$release_sec" "$mark" < /dev/null > /dev/null 2>&1 9>&- &
  fi
fi
if ! is_result "$out"; then
  if [ "$actions" -gt 0 ]; then
    echo "browser-check: agent-browser 결과를 받지 못했습니다. 동작이 실행됐는지 알 수 없어 다시 실행하지 않았습니다. 화면 상태를 확인하고 다시 부르세요." >&2
  else
    echo "browser-check: agent-browser 실행 실패. 'agent-browser doctor' 로 확인하세요." >&2
  fi
  printf '%s\n' "$out" >&2
  exit 1
fi

# 동작 단계는 batch 의 7번째(준비 4 + open + wait 다음)부터 $actions 개다.
printf '%s' "$out" | jq -r --argjson actions "$actions" --arg mark "$mark" '
  def before(name): (map(select(.command[0] == name)) | first | .result) // {};
  def result(name): (map(select(.command[0] == name)) | last | .result) // {};
  # 표식 뒤의 기록만. 표식이 없으면 null.
  def after_mark(f): (to_entries | map(select(.value | f)) | last | .key) as $i
    | if $i == null then null else .[$i + 1:] end;
  # 표식이 없을 때: 상한(1,000)에 닿아 있으면 표식이 밀려난 것이고, 그보다 오래된 기록도 다 밀려났으니
  # 남은 전부가 이번 점검 것이다. 상한 아래면 표식을 못 찍은 것이니 접속 전 개수 이후로 자른다.
  def pick(xs; after; n): if after != null then after elif (xs | length) >= 1000 then xs else xs[n:] end;
  .[6:6 + $actions] as $acts
  | (.[0:6] + .[6 + $actions:] | map(select(.success | not))
      | map(if .command[0] == "eval"
        then "참고: 직전 페이지가 응답하지 않아(무한 루프 등) 이번 점검 표식을 못 찍었습니다. 아래 에러·콘솔에 지난 점검 기록이 섞였을 수 있습니다."
        else "실패: \(.command | join(" ")) → \(.error)" end)) as $failed
  | (result("errors").errors // []) as $all_errors
  | ($all_errors | after_mark(.text | . == "Error: \($mark)" or startswith("Error: \($mark)\n"))) as $errors_after
  | (result("console").messages // []) as $all_console
  | ($all_console | after_mark(.text == $mark)) as $console_after
  | pick($all_errors; $errors_after; (before("errors").errors // []) | length) as $errors
  | pick($all_console; $console_after; (before("console").messages // []) | length) as $console
  | ((before("network").requests // []) | map(.requestId)) as $seen
  | ((result("network").requests // [])
      | map(select((.requestId as $id | $seen | any(.[]; . == $id) | not)
          and ((.status // 0) >= 400 or .failed == true)))) as $bad
  # 미리보기 브릿지(/__preview-bridge.js)는 preview-bridge 플러그인이 파일 수정 때와 응답이 끝날 때
  # 복사한다. HTML 을 bash 로 만든 직후에는 아직 없을 수 있어 안내를 붙이되, 진짜 누락(서빙 폴더에 없음)도
  # 보이도록 목록에서 빼지는 않는다.
  | ($bad | map(select(.url | test("/__preview-bridge\\.js([?#]|$)"))) | length > 0) as $bridge_missing
  | [
      "페이지: \(result("open").title // "-") (\(result("open").url // "-"))",
      ($failed[]),
      (if ($acts | length) > 0 then "", "## 동작" else empty end),
      ($acts[] | if .success
        then "- \(.command | join(" ")) → \(.result | del(.lifecycle) | tostring | .[0:300])"
        else "- \(.command | join(" ")) → 실패: \(.error)" end),
      "",
      "## 에러 \($errors | length)건",
      (if $errors_after == null and ($all_errors | length) >= 1000 then "(기록 상한 1,000개에 닿아 앞부분 에러가 빠졌을 수 있음)" else empty end),
      ($errors[] | "- \(.text)"),
      "",
      "## 콘솔 \($console | length)건",
      (if $console_after == null and ($all_console | length) >= 1000 then "(기록 상한 1,000개에 닿아 앞부분 로그가 빠졌을 수 있음)" else empty end),
      ($console[] | "[\(.type)] \(.text)"),
      "",
      "## 실패한 요청 \($bad | length)건",
      ($bad[] | "- \(.method) \(.url) → \(.status // "응답 없음")"),
      (if $bridge_missing then "(/__preview-bridge.js 는 미리보기 브릿지입니다. 응답이 끝나면 자동으로 깔리니 이번 응답에서는 직접 만들거나 태그를 지우지 마세요. 다음 응답에서도 404 면 개발 서버가 프로젝트 루트·public·static·(index.html 있는) src 중 하나를 서빙하는지 확인하세요.)" else empty end),
      "",
      (if result("screenshot").path then "스크린샷: \(result("screenshot").path)" else empty end),
      (if result("snapshot") != {} then "", "## 화면 구조", (result("snapshot").snapshot // result("snapshot") | tostring) else empty end)
    ]
  | .[]
'
