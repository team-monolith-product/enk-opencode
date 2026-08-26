import { describe, expect, test } from "bun:test"
import { dict as en } from "./en"
import { dict as ar } from "./ar"
import { dict as br } from "./br"
import { dict as bs } from "./bs"
import { dict as da } from "./da"
import { dict as de } from "./de"
import { dict as es } from "./es"
import { dict as fr } from "./fr"
import { dict as ja } from "./ja"
import { dict as ko } from "./ko"
import { dict as no } from "./no"
import { dict as pl } from "./pl"
import { dict as ru } from "./ru"
import { dict as th } from "./th"
import { dict as zh } from "./zh"
import { dict as zht } from "./zht"
import { dict as tr } from "./tr"

const locales = [ar, br, bs, da, de, es, fr, ja, ko, no, pl, ru, th, tr, zh, zht]
const keys = ["command.session.previous.unseen", "command.session.next.unseen"] as const

const consentKeys = (dict: Record<string, string>) => Object.keys(dict).filter((key) => key.startsWith("docSubmit."))

describe("i18n parity", () => {
  // 합의 다이얼로그는 문구가 전부 i18n 에 있다. 한쪽에만 키가 있으면 그 자리에 키 문자열이 그대로
  // 노출되므로, ko 와 en 은 같은 집합을 들고 있어야 한다.
  test("consent dialog keys exist in both ko and en", () => {
    expect(consentKeys(ko).sort()).toEqual(consentKeys(en).sort())
    expect(consentKeys(en).length).toBeGreaterThan(0)
  })


  test("non-English locales translate targeted unseen session keys", () => {
    for (const locale of locales) {
      for (const key of keys) {
        expect(locale[key]).toBeDefined()
        expect(locale[key]).not.toBe(en[key])
      }
    }
  })
})
