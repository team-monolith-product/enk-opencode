#!/usr/bin/env node
/**
 * Claude Code `WorktreeCreate` 훅.
 *
 * 이 훅은 "워크트리 생성 그 자체"를 책임진다(후처리 훅이 아님).
 * 계약(실제 하니스가 보내는 stdin JSON):
 *   { session_id, transcript_path, cwd, prompt_id, hook_event_name, name }
 *       · cwd  : 메인 저장소 작업 디렉터리
 *       · name : 워크트리 이름 (예: "agent-a24e6d2563fccc064")
 *   → worktree_path 는 오지 않으므로 훅이 직접 경로를 정한다:
 *     `<cwd>/.claude/worktrees/<name>` (기존 워크트리들과 동일 규칙).
 *   - 훅은 실제로 `git worktree add` 로 워크트리를 만들고,
 *     성공 시 그 경로만 stdout 으로 출력한 뒤 exit 0.
 *   - 메인 저장소 경로를 출력하거나, 아무것도 출력하지 않으면 하니스가 실패로 처리한다.
 *   - 워크트리를 만들 수 없으면 exit 1 로 생성을 중단시킨다.
 *
 * 워크트리를 만든 뒤 부가 작업:
 *   1) 메인 저장소에는 있지만 gitignore 되어 체크아웃에 따라오지 않는
 *      `.env*` 파일들을 복사한다(대상에 이미 있으면 skip).
 *   2) 이 프로젝트 전용 git 사용자 정보(name/email)를 로컬 config 로 설정한다.
 *   3) `bun install` 로 의존성을 설치한다. node_modules 는 gitignore 라
 *      `git worktree add` 로 따라오지 않으므로 워크트리마다 새로 깔아야 한다.
 */
import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, copyFileSync, readdirSync} from 'node:fs'
import {dirname, join, relative, basename} from 'node:path'

// 이 프로젝트 전용 git 사용자 정보 (글로벌 아님)
const GIT_USER_NAME = 'bichikim'
const GIT_USER_EMAIL = 'kbc@team-mono.com'

const log = (...a) => process.stderr.write(`[worktree-create] ${a.join(' ')}\n`)

function readStdin() {
  try {
    const raw = execFileSync('cat', [], {stdio: ['inherit', 'pipe', 'ignore']})
      .toString()
      .trim()
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function git(cwd, args) {
  return execFileSync('git', args, {cwd, stdio: ['ignore', 'pipe', 'ignore']})
    .toString()
    .trim()
}

function branchExists(repo, name) {
  try {
    git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`])
    return true
  } catch {
    return false
  }
}

/** 이 경로가 이미 등록된 워크트리인지 확인. */
function isRegisteredWorktree(mainRepo, worktreePath) {
  try {
    const out = git(mainRepo, ['worktree', 'list', '--porcelain'])
    return out
      .split('\n')
      .some((line) => line.startsWith('worktree ') && line.slice('worktree '.length) === worktreePath)
  } catch {
    return false
  }
}

/** 메인 저장소(main working tree) 루트를 찾는다. */
function resolveMainRepo(input) {
  const base = input.cwd && existsSync(input.cwd) ? input.cwd : process.cwd()
  // --git-common-dir 는 공용 .git(메인 저장소의 .git)를 가리킨다 → 그 부모가 메인 루트.
  const commonDir = git(base, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  return dirname(commonDir)
}

/** 실제로 워크트리를 만든다. 이미 존재하면 그대로 재사용한다. */
function createWorktree(mainRepo, worktreePath, worktreeName) {
  if (isRegisteredWorktree(mainRepo, worktreePath)) {
    log(`이미 등록된 워크트리 재사용: ${worktreePath}`)
    return
  }

  // 브랜치 이름: 하니스 기본 규칙(worktree-<name>)을 따르되 충돌 시 접미사로 유일화.
  const nameBase = worktreeName || basename(worktreePath)
  const branchBase = nameBase.startsWith('worktree-') ? nameBase : `worktree-${nameBase}`
  let branch = branchBase
  let n = 1
  while (branchExists(mainRepo, branch)) {
    branch = `${branchBase}-${n++}`
  }

  mkdirSync(dirname(worktreePath), {recursive: true})
  git(mainRepo, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'])
  log(`워크트리 생성: ${worktreePath} (브랜치 ${branch})`)
}

/** 워크트리에 프로젝트 전용 git 사용자 정보를 로컬 config 로 설정한다. */
function setGitIdentity(worktree) {
  try {
    git(worktree, ['config', 'user.name', GIT_USER_NAME])
    git(worktree, ['config', 'user.email', GIT_USER_EMAIL])
    log(`git 사용자 설정: ${GIT_USER_NAME} <${GIT_USER_EMAIL}>`)
  } catch (err) {
    log('git 사용자 설정 실패(무시):', err.message)
  }
}

/** 메인 저장소에서 복사 후보 .env* 파일을 수집한다(node_modules 등 제외). */
function collectEnvFiles(root) {
  const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'dist', 'build', '.next', '.turbo', 'coverage'])
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, {withFileTypes: true})
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        walk(full)
      } else if (e.isFile() && basename(e.name).startsWith('.env')) {
        out.push(full)
      }
    }
  }
  walk(root)
  return out
}

function copyEnvFiles(mainRepo, worktree) {
  const envFiles = collectEnvFiles(mainRepo)
  let copied = 0
  for (const src of envFiles) {
    const rel = relative(mainRepo, src)
    const dest = join(worktree, rel)
    if (existsSync(dest)) continue // tracked 파일 등 이미 있는 것은 건너뜀
    try {
      mkdirSync(dirname(dest), {recursive: true})
      copyFileSync(src, dest)
      copied++
      log(`복사: ${rel}`)
    } catch (err) {
      log(`복사 실패(${rel}):`, err.message)
    }
  }
  log(copied > 0 ? `완료 — ${copied}개 .env 파일 복사됨` : '복사할 .env 파일 없음')
}

/**
 * 워크트리에 의존성을 설치한다. node_modules 는 gitignore 라 워크트리에
 * 따라오지 않으므로(bun 워크스페이스 모노레포 → 루트+패키지별 node_modules),
 * 워크트리마다 `bun install` 이 필요하다.
 * 실패해도 워크트리 자체는 유효하므로 로그만 남기고 삼킨다.
 */
function installDeps(worktree) {
  try {
    execFileSync('bun', ['install', '--frozen-lockfile'], {
      cwd: worktree,
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    log('bun install 완료')
  } catch (err) {
    log('bun install 실패(무시):', err && err.message)
  }
}

function main() {
  const input = readStdin()
  const mainRepo = resolveMainRepo(input)

  // 워크트리 이름 → 경로. worktree_path 가 오면 그대로 쓰고, 아니면 name 으로 만든다.
  const name = input.name || input.worktree_name
  const worktreePath =
    input.worktree_path ||
    input.worktreePath ||
    (name ? join(mainRepo, '.claude', 'worktrees', name) : null)

  if (!worktreePath) {
    log('worktree 경로를 결정할 수 없음(name/worktree_path 없음) → 실패')
    return null
  }
  if (worktreePath === mainRepo) {
    log(`worktree 경로가 메인 저장소와 동일 → 실패: ${worktreePath}`)
    return null
  }

  // 1) 워크트리 생성(핵심). 실패하면 예외가 올라가 exit 1 처리된다.
  createWorktree(mainRepo, worktreePath, name)

  // 2) 부가 작업 — 실패해도 워크트리 자체는 유효하므로 삼킨다.
  setGitIdentity(worktreePath)
  copyEnvFiles(mainRepo, worktreePath)
  installDeps(worktreePath)

  return worktreePath
}

try {
  const worktreePath = main()
  if (worktreePath) {
    process.stdout.write(`${worktreePath}\n`)
    process.exit(0)
  }
  // 경로를 못 만들었으면 생성 중단.
  process.exit(1)
} catch (err) {
  log('워크트리 생성 실패:', err && err.message)
  process.exit(1)
}
