// worktree-create.mjs 훅 테스트.
// 루트 bunfig 의 test.root 가드 때문에 bare `bun test` 로는 안 걸린다.
// 실행: 이 디렉터리(.claude/hooks)에서 `bun test ./worktree-create.test.mjs`
import {afterEach, beforeEach, describe, expect, test} from 'bun:test'
import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {collectEnvFiles, copyClaudeFiles, copyEnvFiles, createWorktree} from './worktree-create.mjs'

let base

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'wt-test-'))
})

afterEach(() => {
  rmSync(base, {recursive: true, force: true})
})

/** base 밑에 상대경로로 파일을 쓴다(중간 디렉터리 생성). */
function write(rel, content = '') {
  const full = join(base, rel)
  mkdirSync(dirname(full), {recursive: true})
  writeFileSync(full, content)
  return full
}

function read(rel) {
  return readFileSync(join(base, rel), 'utf8')
}

function has(rel) {
  return existsSync(join(base, rel))
}

describe('copyClaudeFiles', () => {
  test('gitignore 된 로컬 설정을 워크트리로 복사한다', () => {
    write('main/.claude/CLAUDE.md', 'flow')
    write('main/.claude/settings.local.json', '{}')
    mkdirSync(join(base, 'wt'), {recursive: true})

    copyClaudeFiles(join(base, 'main'), join(base, 'wt'))

    expect(read('wt/.claude/CLAUDE.md')).toBe('flow')
    expect(has('wt/.claude/settings.local.json')).toBe(true)
  })

  test('대상에 이미 있는 파일은 덮어쓰지 않는다', () => {
    write('main/.claude/settings.json', 'main')
    write('wt/.claude/settings.json', 'tracked') // 이미 체크아웃된 tracked 파일

    copyClaudeFiles(join(base, 'main'), join(base, 'wt'))

    expect(read('wt/.claude/settings.json')).toBe('tracked')
  })

  test('worktrees 디렉터리는 복사하지 않는다', () => {
    write('main/.claude/CLAUDE.md', 'x')
    write('main/.claude/worktrees/other/foo.txt', 'nested')
    mkdirSync(join(base, 'wt'), {recursive: true})

    copyClaudeFiles(join(base, 'main'), join(base, 'wt'))

    expect(has('wt/.claude/CLAUDE.md')).toBe(true)
    expect(has('wt/.claude/worktrees/other/foo.txt')).toBe(false)
  })

  test('.claude 가 없으면 아무 일도 하지 않는다', () => {
    mkdirSync(join(base, 'main'), {recursive: true})
    mkdirSync(join(base, 'wt'), {recursive: true})

    expect(() => copyClaudeFiles(join(base, 'main'), join(base, 'wt'))).not.toThrow()
    expect(has('wt/.claude')).toBe(false)
  })
})

describe('collectEnvFiles / copyEnvFiles', () => {
  test('.env* 만 수집하고 node_modules·.claude·.git 은 건너뛴다', () => {
    write('main/.env', 'A=1')
    write('main/packages/x/.env.local', 'B=2')
    write('main/config.txt', 'nope')
    write('main/node_modules/dep/.env', 'skip')
    write('main/.claude/.env', 'skip')
    write('main/.git/.env', 'skip')

    const found = collectEnvFiles(join(base, 'main')).sort()

    expect(found).toEqual([join(base, 'main/.env'), join(base, 'main/packages/x/.env.local')].sort())
  })

  test('복사하되 이미 있는 파일은 건너뛴다', () => {
    write('main/.env', 'A=1')
    write('main/packages/x/.env', 'B=2')
    write('wt/.env', 'existing') // 이미 있는 것은 유지

    copyEnvFiles(join(base, 'main'), join(base, 'wt'))

    expect(read('wt/.env')).toBe('existing')
    expect(read('wt/packages/x/.env')).toBe('B=2')
  })
})

describe('createWorktree', () => {
  function initRepo() {
    mkdirSync(join(base, 'repo'), {recursive: true})
    // git 은 resolved(심링크 해소된) 경로를 돌려주므로, 프로덕션에서
    // mainRepo 를 얻는 방식과 동일하게 realpath 로 맞춰 재사용 감지를 검증한다.
    const repo = realpathSync(join(base, 'repo'))
    const g = (...args) => execFileSync('git', args, {cwd: repo, stdio: 'ignore'})
    g('init')
    g('config', 'user.name', 'test')
    g('config', 'user.email', 'test@example.com')
    writeFileSync(join(repo, 'README.md'), 'hi')
    g('add', '.')
    g('commit', '-m', 'init')
    return repo
  }

  test('HEAD 에서 워크트리와 브랜치를 만든다', () => {
    const repo = initRepo()
    const wt = join(repo, '.claude/worktrees/foo')

    createWorktree(repo, wt, 'foo')

    expect(existsSync(join(wt, 'README.md'))).toBe(true)
    const branches = execFileSync('git', ['branch', '--format=%(refname:short)'], {cwd: repo}).toString()
    expect(branches).toContain('worktree-foo')
  })

  test('이미 등록된 워크트리는 그대로 재사용한다(에러 없음)', () => {
    const repo = initRepo()
    const wt = join(repo, '.claude/worktrees/foo')
    createWorktree(repo, wt, 'foo')

    expect(() => createWorktree(repo, wt, 'foo')).not.toThrow()
    expect(existsSync(join(wt, 'README.md'))).toBe(true)
  })

  test('브랜치 이름이 충돌하면 접미사로 유일화한다', () => {
    const repo = initRepo()
    execFileSync('git', ['branch', 'worktree-bar'], {cwd: repo, stdio: 'ignore'})

    createWorktree(repo, join(repo, '.claude/worktrees/bar'), 'bar')

    const branches = execFileSync('git', ['branch', '--format=%(refname:short)'], {cwd: repo}).toString()
    expect(branches).toContain('worktree-bar-1')
  })
})
