#!/usr/bin/env bun
/**
 * Vendors upstream packages into this repo without modifying them.
 *
 * The vendored folder is a verbatim copy of `source` at a recorded upstream commit, so syncing with
 * upstream is a folder replacement and `check` fails when someone edits it in place. Local changes
 * belong in adapter code outside the vendored folder.
 *
 *   bun script/vendor.ts add <name> <source> <dest> [ref] [--exclude <path>]...
 *   bun script/vendor.ts sync <name> [ref]
 *   bun script/vendor.ts check [name]
 *   bun script/vendor.ts list
 */
import { $ } from "bun"
import fs from "fs"
import os from "os"
import path from "path"

const root = path.resolve(import.meta.dirname, "..")
const manifestPath = path.join(root, "upstream-vendor.json")

type Entry = { source: string; dest: string; sha: string; exclude?: string[] }
type Manifest = { remote: string; url: string; defaultRef: string; packages: Record<string, Entry> }

const load = (): Manifest => JSON.parse(fs.readFileSync(manifestPath, "utf8"))
const save = (manifest: Manifest) => fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")

const git = (...args: string[]) => $`git -C ${root} ${args}`.quiet()

async function ensureRemote(manifest: Manifest) {
  const remotes = (await git("remote")).text().split("\n")
  if (!remotes.includes(manifest.remote)) await git("remote", "add", manifest.remote, manifest.url)
}

async function resolve(manifest: Manifest, ref: string) {
  await ensureRemote(manifest)
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const has = await $`git -C ${root} cat-file -e ${ref}^{commit}`.quiet().nothrow()
    if (has.exitCode !== 0) await git("fetch", manifest.remote, ref)
    return ref
  }
  await git("fetch", manifest.remote, ref)
  return (await git("rev-parse", "FETCH_HEAD")).text().trim()
}

async function extract(sha: string, source: string, into: string, exclude: string[] = []) {
  const depth = source.split("/").length
  fs.mkdirSync(into, { recursive: true })
  await $`git -C ${root} archive ${sha} ${source} | tar -x -C ${into} --strip-components=${depth}`.quiet()
  for (const item of exclude) fs.rmSync(path.join(into, item), { recursive: true, force: true })
}

function entryOf(manifest: Manifest, name: string) {
  const entry = manifest.packages[name]
  if (!entry) throw new Error(`unknown vendored package: ${name}`)
  return entry
}

async function install(
  manifest: Manifest,
  name: string,
  source: string,
  dest: string,
  ref: string,
  exclude: string[] = [],
) {
  const sha = await resolve(manifest, ref)
  const target = path.join(root, dest)
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-"))
  try {
    await extract(sha, source, staging, exclude)
    fs.rmSync(target, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.cpSync(staging, target, { recursive: true })
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
  manifest.packages[name] = exclude.length ? { source, dest, sha, exclude } : { source, dest, sha }
  save(manifest)
  console.log(`${name}: ${source} @ ${sha.slice(0, 10)} -> ${dest}`)
}

async function verify(manifest: Manifest, name: string) {
  const entry = entryOf(manifest, name)
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-"))
  try {
    await extract(entry.sha, entry.source, staging, entry.exclude)
    const ignored = ["node_modules", "dist", ".turbo"].flatMap((item) => ["-x", item])
    const result = await $`diff -r ${ignored} ${staging} ${path.join(root, entry.dest)}`.quiet().nothrow()
    if (result.exitCode === 0) {
      console.log(`${name}: matches upstream ${entry.sha.slice(0, 10)}`)
      return true
    }
    console.error(`${name}: differs from upstream ${entry.sha.slice(0, 10)}\n${result.stdout.toString().trim()}`)
    return false
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

const [command, ...args] = process.argv.slice(2)
const manifest = load()

if (command === "add") {
  const exclude: string[] = []
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--exclude") exclude.push(args[++i] ?? "")
    else positional.push(args[i])
  }
  const [name, source, dest, ref] = positional
  if (!name || !source || !dest) throw new Error("usage: add <name> <source> <dest> [ref] [--exclude <path>]...")
  if (manifest.packages[name]) throw new Error(`${name} is already vendored; use sync`)
  await install(manifest, name, source, dest, ref ?? manifest.defaultRef, exclude)
} else if (command === "sync") {
  const [name, ref] = args
  if (!name) throw new Error("usage: sync <name> [ref]")
  const entry = entryOf(manifest, name)
  await install(manifest, name, entry.source, entry.dest, ref ?? manifest.defaultRef, entry.exclude)
} else if (command === "check") {
  const names = args[0] ? [args[0]] : Object.keys(manifest.packages)
  const results = await Promise.all(names.map((name) => verify(manifest, name)))
  if (results.some((ok) => !ok)) process.exit(1)
} else if (command === "list") {
  for (const [name, entry] of Object.entries(manifest.packages))
    console.log(`${name}\t${entry.sha.slice(0, 10)}\t${entry.source} -> ${entry.dest}`)
} else {
  console.error("usage: vendor.ts add|sync|check|list")
  process.exit(1)
}
