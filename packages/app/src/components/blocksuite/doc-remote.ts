import type { Doc, Query } from "@blocksuite/store"
import { DocCollection } from "@blocksuite/store"
import type { OpencodeDocSource } from "./opencode-doc-source"

type YDoc = InstanceType<typeof DocCollection.Y.Doc>

function subdoc(collection: DocCollection, page: string) {
  return collection.doc.spaces.get(page)
}

function bind(collection: DocCollection, page: string, readonly?: boolean, query?: Query) {
  const doc = collection.getDoc(page, { readonly, query })
  if (doc) return doc
  if (!subdoc(collection, page)) return null
  if (!collection.meta.getDocMeta(page)) {
    collection.meta.addDocMeta({
      id: page,
      title: "",
      createDate: Date.now(),
      tags: [],
    })
  }
  return collection.getDoc(page, { readonly, query })
}

export async function load(source: OpencodeDocSource, id: string, doc: YDoc) {
  const next = await source.pull(id, DocCollection.Y.encodeStateVector(doc))
  if (next?.data.length) DocCollection.Y.applyUpdate(doc, next.data, source.name)
}

// `hold`가 true인 동안(로컬 IME 조합 중) 원격 업데이트 적용을 버퍼링한다. BlockSuite inline
// editor는 원격 yText 변경에 무조건 즉시 re-render해서, 상대가 타이핑하는 동안 내 한글 조합이
// 매번 취소된다(영어만 입력되는 증상). Y 업데이트는 순서 무관 병합이 가능하므로 조합이 끝난 뒤
// flush()로 몰아서 적용해도 수렴이 깨지지 않는다.
export async function link(source: OpencodeDocSource, root: YDoc, page: YDoc, hold?: () => boolean) {
  let pending: Uint8Array[] = []
  const apply = (id: string, data: Uint8Array) => {
    if (id !== page.guid) return
    if (hold?.()) {
      pending.push(data)
      return
    }
    DocCollection.Y.applyUpdate(page, data, source.name)
  }
  const flush = () => {
    if (!pending.length) return
    const batch = DocCollection.Y.mergeUpdates(pending)
    pending = []
    DocCollection.Y.applyUpdate(page, batch, source.name)
  }
  const stop = await source.subscribe(apply, () => undefined)
  await load(source, root.guid, root)
  await load(source, page.guid, page)
  await source.push(root.guid, DocCollection.Y.encodeStateAsUpdate(root))
  await source.push(page.guid, DocCollection.Y.encodeStateAsUpdate(page))
  const push = (data: Uint8Array, origin: unknown, doc: YDoc) => {
    if (origin === source.name) return
    void source.push(doc.guid, data)
  }
  page.on("update", push)
  const unlink = () => {
    page.off("update", push)
    stop()
    source.close()
  }
  return { unlink, flush }
}

export async function remote(
  source: OpencodeDocSource,
  collection: DocCollection,
  root: string,
  page: string,
  readonly?: boolean,
  query?: Query,
) {
  await load(source, root, collection.doc)
  const doc = bind(collection, page, readonly, query)
  if (!doc) return
  if (!doc.loaded) doc.load()
  await load(source, page, doc.spaceDoc)
  if (!doc.root) return
  return doc
}
