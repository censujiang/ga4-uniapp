// Delivery-queue regression tests (run with `bun test`).
//
// They mock the `uni` global (storage + `uni.request`) and cover the behaviours that decide whether GA4 hits
// survive a flaky network: ordered single-flight delivery, retry with backoff, request timeouts, persistence across
// app restarts, queue limits, opt-out, and the `_ss/_nsi/_fv` session markers that let GA4 derive sessions.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createUniAppGA4 } from "../src/index"

type Outcome = "ok" | "fail" | "hang" | number

const store = new Map<string, unknown>()
const requests: Array<{ en: string; marker: string; n: number; q: Record<string, string> }> = []
let inFlight = 0
let maxInFlight = 0
let attemptCount = 0
let script: (attempt: number, query: URLSearchParams) => Outcome = () => "ok"

function installUni() {
  ;(globalThis as any).uni = {
    getStorageSync: (key: string) => (store.has(key) ? store.get(key) : ""),
    setStorageSync: (key: string, value: unknown) => {
      store.set(key, JSON.parse(JSON.stringify(value)))
    },
    removeStorageSync: (key: string) => {
      store.delete(key)
    },
    getSystemInfoSync: () => ({ language: "zh-CN", screenWidth: 1080, screenHeight: 2400, windowWidth: 360, windowHeight: 800 }),
    request: (opts: { url: string; timeout?: number; success: (r: { statusCode?: number }) => void; fail: (e: unknown) => void }) => {
      attemptCount += 1
      const attempt = attemptCount
      const query = new URL(opts.url).searchParams
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      const outcome = script(attempt, query)
      const finish = (run: () => void) => {
        inFlight -= 1
        run()
      }
      if (outcome === "hang") {
        // Never answers; the JS-side deadline must abort it.
        return { abort: () => { inFlight -= 1 } }
      }
      setTimeout(() => {
        if (outcome === "fail") {
          finish(() => opts.fail({ errMsg: "request:fail" }))
        } else {
          const statusCode = outcome === "ok" ? 204 : outcome
          if (statusCode >= 200 && statusCode < 400) {
            requests.push({ en: query.get("en") || "", marker: query.get("ep.marker") || "", n: attempt, q: Object.fromEntries(query.entries()) })
          }
          finish(() => opts.success({ statusCode }))
        }
      }, 1)
      return { abort: () => {} }
    },
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function newClient(extra: Record<string, unknown> = {}) {
  return createUniAppGA4({
    measurementId: "G-TEST",
    autoPageView: false,
    autoUniInterceptors: false,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...extra,
  })
}

beforeEach(() => {
  store.clear()
  requests.length = 0
  inFlight = 0
  maxInFlight = 0
  attemptCount = 0
  script = () => "ok"
  installUni()
})

afterEach(() => {
  delete (globalThis as any).uni
})

describe("delivery queue", () => {
  test("happy path sends each event once, in order", async () => {
    const ga4 = newClient()
    await ga4.event("a", { marker: "1" })
    await ga4.event("b", { marker: "2" })
    expect(requests.map((r) => r.marker)).toEqual(["1", "2"])
    expect(store.has("uni_ga4_pending_events")).toBe(false)
  })

  test("failed request does not drop the hits queued behind it, and they are retried with backoff", async () => {
    const ga4 = newClient({ retryDelaysMs: [30, 30] })
    script = (attempt) => (attempt <= 3 ? "fail" : "ok")
    const p1 = ga4.event("e", { marker: "1" })
    const p2 = ga4.event("e", { marker: "2" })
    const p3 = ga4.event("e", { marker: "3" })
    await Promise.all([p1, p2, p3])
    // first attempt failed, retry timer pending -> nothing delivered yet
    expect(requests.length).toBe(0)
    expect(store.has("uni_ga4_pending_events")).toBe(true)
    await sleep(400)
    expect(requests.map((r) => r.marker)).toEqual(["1", "2", "3"])
    expect(store.has("uni_ga4_pending_events")).toBe(false)
    expect(maxInFlight).toBe(1)
  })

  test("non-2xx/3xx responses are treated as failures and retried", async () => {
    const ga4 = newClient({ retryDelaysMs: [20] })
    script = (attempt) => (attempt === 1 ? 503 : "ok")
    await ga4.event("e", { marker: "x" })
    expect(requests.length).toBe(0)
    await sleep(200)
    expect(requests.map((r) => r.marker)).toEqual(["x"])
  })

  test("hanging request is aborted by the timeout and retried", async () => {
    const ga4 = newClient({ requestTimeoutMs: 40, retryDelaysMs: [20] })
    script = (attempt) => (attempt === 1 ? "hang" : "ok")
    const started = Date.now()
    await ga4.event("e", { marker: "h" })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(requests.length).toBe(0)
    await sleep(300)
    expect(requests.map((r) => r.marker)).toEqual(["h"])
  })

  test("concurrent events never overlap on the wire and keep their order", async () => {
    const ga4 = newClient()
    await Promise.all(Array.from({ length: 8 }, (_, i) => ga4.event("c", { marker: String(i) })))
    expect(requests.map((r) => r.marker)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"])
    expect(maxInFlight).toBe(1)
  })

  test("undelivered hits survive an app restart and are delivered by the next init()", async () => {
    const first = newClient({ retryDelaysMs: [] })
    script = () => "fail"
    await first.event("e", { marker: "p1" })
    await first.event("e", { marker: "p2" })
    expect(requests.length).toBe(0)
    const persisted = store.get("uni_ga4_pending_events") as Array<{ name: string }>
    expect(persisted.length).toBe(2)

    // "restart": a new client over the same storage, network healthy again
    script = () => "ok"
    const second = newClient({ retryDelaysMs: [] })
    second.init()
    await sleep(100)
    expect(requests.map((r) => r.marker)).toEqual(["p1", "p2"])
    expect(store.has("uni_ga4_pending_events")).toBe(false)
  })

  test("persisted hits older than maxPendingAgeMs are discarded", async () => {
    store.set("uni_ga4_pending_events", [
      { name: "old", params: { marker: "old" }, timestamp: Date.now() - 10_000 },
      { name: "fresh", params: { marker: "fresh" }, timestamp: Date.now() - 10 },
    ])
    const ga4 = newClient({ maxPendingAgeMs: 5_000 })
    ga4.init()
    await sleep(100)
    expect(requests.map((r) => r.marker)).toEqual(["fresh"])
  })

  test("queue is bounded by maxQueueSize (oldest dropped first)", async () => {
    const ga4 = newClient({ maxQueueSize: 3, retryDelaysMs: [] })
    script = () => "fail"
    for (let i = 1; i <= 5; i += 1) {
      await ga4.event("o", { marker: String(i) })
    }
    const persisted = store.get("uni_ga4_pending_events") as Array<{ params: { marker: string } }>
    expect(persisted.map((e) => e.params.marker)).toEqual(["3", "4", "5"])
  })

  test("opt-out clears undelivered hits and storage", async () => {
    const ga4 = newClient({ retryDelaysMs: [] })
    script = () => "fail"
    await ga4.event("e", { marker: "z" })
    expect(store.has("uni_ga4_pending_events")).toBe(true)
    ga4.optOut(true)
    expect(store.has("uni_ga4_pending_events")).toBe(false)
    script = () => "ok"
    await ga4.flush()
    expect(requests.length).toBe(0)
  })

  test("explicit flush() retries immediately and supersedes the backoff timer", async () => {
    const ga4 = newClient({ retryDelaysMs: [5_000] })
    script = (attempt) => (attempt === 1 ? "fail" : "ok")
    await ga4.event("e", { marker: "f" })
    expect(requests.length).toBe(0)
    await ga4.flush("manual")
    expect(requests.map((r) => r.marker)).toEqual(["f"])
  })

  test("events raised while a retry is pending stay queued (no hammering) and ride the next retry", async () => {
    const ga4 = newClient({ retryDelaysMs: [60] })
    script = (attempt) => (attempt === 1 ? "fail" : "ok")
    await ga4.event("e", { marker: "1" })
    const before = attemptCount
    await ga4.event("e", { marker: "2" })
    expect(attemptCount).toBe(before) // second event did not trigger an attempt yet
    await sleep(300)
    expect(requests.map((r) => r.marker)).toEqual(["1", "2"])
  })

  test("session markers: brand-new client sends _ss/_nsi/_fv on the first hit only", async () => {
    const ga4 = newClient()
    await ga4.event("a", { marker: "1" })
    await ga4.event("b", { marker: "2" })
    expect(requests[0].q._ss).toBe("1")
    expect(requests[0].q._nsi).toBe("1")
    expect(requests[0].q._fv).toBe("1")
    expect(requests[1].q._ss).toBeUndefined()
    expect(requests[1].q._nsi).toBeUndefined()
    expect(requests[1].q._fv).toBeUndefined()
  })

  test("session markers: clients created by an older SDK never send _fv, but start their current session once", async () => {
    store.set("uni_ga4_client_id", "1234567890.1700000000")
    const ga4 = newClient()
    await ga4.event("a", { marker: "1" })
    await ga4.event("b", { marker: "2" })
    expect(requests[0].q._ss).toBe("1")
    expect(requests[0].q._nsi).toBe("1")
    expect(requests[0].q._fv).toBeUndefined()
    expect(requests[1].q._ss).toBeUndefined()
  })

  test("session markers: a new session (resetSession) is flagged again, without _fv", async () => {
    const ga4 = newClient()
    await ga4.event("a", { marker: "1" })
    ga4.resetSession()
    await ga4.event("b", { marker: "2" })
    await ga4.event("c", { marker: "3" })
    expect(requests.map((r) => r.q._ss ?? "-")).toEqual(["1", "1", "-"])
    expect(requests.map((r) => r.q._fv ?? "-")).toEqual(["1", "-", "-"])
  })

  test("session markers stay with the first hit when its delivery fails and is retried", async () => {
    const ga4 = newClient({ retryDelaysMs: [20] })
    script = (attempt) => (attempt === 1 ? "fail" : "ok")
    await ga4.event("a", { marker: "1" })
    await ga4.event("b", { marker: "2" })
    await sleep(300)
    expect(requests.map((r) => r.marker)).toEqual(["1", "2"])
    expect(requests.map((r) => r.q._ss ?? "-")).toEqual(["1", "-"])
    expect(requests.map((r) => r.q._fv ?? "-")).toEqual(["1", "-"])
  })

  test("session markers survive persistence across an app restart", async () => {
    const first = newClient({ retryDelaysMs: [] })
    script = () => "fail"
    await first.event("a", { marker: "1" })
    script = () => "ok"
    const second = newClient({ retryDelaysMs: [] })
    second.init()
    await sleep(100)
    expect(requests.map((r) => r.marker)).toEqual(["1"])
    expect(requests[0].q._ss).toBe("1")
    expect(requests[0].q._nsi).toBe("1")
    expect(requests[0].q._fv).toBe("1")
  })

  test("destroy() makes one last attempt but never re-arms the retry timer", async () => {
    const ga4 = newClient({ retryDelaysMs: [20] })
    script = () => "fail"
    await ga4.event("e", { marker: "d" })
    ga4.destroy()
    await sleep(120)
    const settled = attemptCount
    await sleep(250)
    expect(attemptCount).toBe(settled)
  })

  test("batch mode: hits queued behind a failed hit are not dropped", async () => {
    let attempt = 0
    const delivered: string[] = []
    script = () => {
      attempt += 1
      return attempt === 1 ? "fail" : "ok"
    }
    const ga4 = newClient({ batchIntervalMs: 20, retryDelaysMs: [30] })
    void ga4.event("e", { marker: "1" })
    void ga4.event("e", { marker: "2" })
    void ga4.event("e", { marker: "3" })
    await sleep(150)
    await ga4.flush("manual")
    await sleep(100)
    requests.forEach((r) => delivered.push(r.marker))
    expect(delivered).toEqual(["1", "2", "3"])
  })

  test("a custom requestAdapter that never settles cannot wedge the queue", async () => {
    let calls = 0
    const delivered: string[] = []
    const ga4 = newClient({
      requestTimeoutMs: 30,
      retryDelaysMs: [20],
      requestAdapter: (req: { params: Record<string, string> }) => {
        calls += 1
        if (calls === 1) {
          return new Promise(() => {}) // never settles
        }
        delivered.push(req.params["ep.marker"])
        return Promise.resolve({ ok: true, statusCode: 204 })
      },
    })
    const started = Date.now()
    await ga4.event("e", { marker: "stuck-then-ok" })
    expect(Date.now() - started).toBeLessThan(2000)
    await sleep(1400)
    expect(delivered).toEqual(["stuck-then-ok"])
  })

  test("maxQueueSize is clamped to at least one hit", async () => {
    const ga4 = newClient({ maxQueueSize: 0.5, retryDelaysMs: [] })
    script = () => "fail"
    await ga4.event("e", { marker: "only" })
    const persisted = store.get("uni_ga4_pending_events") as Array<{ params: { marker: string } }>
    expect(persisted.map((e) => e.params.marker)).toEqual(["only"])
  })
})
