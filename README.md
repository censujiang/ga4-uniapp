# ga4-uniapp

GA4 direct-collect client for uni-app. It sends browser-style GA4 hits to the
Google Analytics collect endpoint with a measurement ID only; no Measurement
Protocol `api_secret` is required or sent.

uni-app GA4 直连统计客户端。SDK 使用类似 gtag.js 的 URL 参数格式向 Google
Analytics collect 端点发送事件，只需要 GA4 Measurement ID，不使用也不会发送
Measurement Protocol 的 `api_secret`。

## Install

```bash
bun add ga4-uniapp
```

安装：

```bash
bun add ga4-uniapp
```

## Usage

```ts
import { createUniAppGA4 } from "ga4-uniapp"

export const ga4 = createUniAppGA4({
  measurementId: "G-XXXXXXXXXX",
  appOrigin: "https://your-app.example",
  debug: import.meta.env.DEV,
})

// Sends the initial page_view and registers uni/H5 automatic collectors.
ga4.init()
await ga4.event("select_content", {
  content_type: "button",
  item_id: "hero-cta",
})
```

用法：

```ts
import { createUniAppGA4 } from "ga4-uniapp"

export const ga4 = createUniAppGA4({
  measurementId: "G-XXXXXXXXXX",
  appOrigin: "https://your-app.example",
  debug: import.meta.env.DEV,
})

// 发送初始 page_view，并注册 uni/H5 自动统计能力。
ga4.init()
await ga4.event("select_content", {
  content_type: "button",
  item_id: "hero-cta",
})
```

## Transport

The default endpoint is:

```text
https://www.google-analytics.com/g/collect
```

This is the GA4 web collect endpoint used by gtag-style browser hits. The SDK
does not call `https://www.google-analytics.com/mp/collect` and does not use an
API secret. Event parameters are encoded as query parameters such as `v=2`,
`tid`, `cid`, `sid`, `sct`, `en`, `dl`, `dt`, and `ep.*`. Like gtag.js, the
first hit of every session also carries `_ss=1&_nsi=1` (and the first hit of a
brand-new client `_fv=1`), which is how GA4 derives `session_start`,
`first_visit`, sessions, and new users. When `debug` is enabled every hit also
carries `ep.debug_mode=true` (what gtag.js sends) plus the legacy `_dbg=1`. GA4 DebugView only lists devices that send debug-flagged
hits, so enable `debug` while verifying in DebugView (and reload the DebugView
page / reopen its device dropdown, because the device list does not refresh by
itself).

By default, transport goes through `uni.request`, and persistence goes through
`uni.getStorageSync`, `uni.setStorageSync`, and `uni.removeStorageSync`. The
SDK default path does not use browser-only `Image`, `fetch`, or `localStorage`
fallbacks.

### Delivery reliability

Hits are delivered oldest-first, one request at a time. A hit leaves the queue
only after the collect endpoint answered with a 2xx/3xx status. A failed or
timed-out request keeps the hit (and everything queued behind it) in the queue,
persists the queue through uni storage, and retries with backoff. Hits that
could not be delivered before the app was closed are delivered by the next
`init()`.

```ts
createUniAppGA4({
  measurementId: "G-XXXXXXXXXX",
  requestTimeoutMs: 10_000, // per request, default 10s (fails fast on blocked networks)
  retryDelaysMs: [2_000, 5_000, 15_000, 30_000, 60_000], // backoff, last value repeats; [] disables timed retries
  maxQueueSize: 100, // oldest undelivered hits are dropped beyond this
  persistQueue: true, // keep undelivered hits across app restarts
  maxPendingAgeMs: 24 * 60 * 60 * 1000, // discard hits older than this instead of retrying
})
```

If your users cannot reliably reach `www.google-analytics.com` (for example on
mainland-China networks), point `collectEndpoint` at a first-party relay that
forwards the query string to `https://www.google-analytics.com/g/collect`.

默认端点是：

```text
https://www.google-analytics.com/g/collect
```

这是 GA4 Web 统计的 gtag 风格端点。SDK 不调用
`https://www.google-analytics.com/mp/collect`，也不使用 API secret。事件参数会被编码成
`v=2`、`tid`、`cid`、`sid`、`sct`、`en`、`dl`、`dt`、`ep.*` 等查询参数；与 gtag.js 一样，
每个会话的第一个 hit 还会带上 `_ss=1&_nsi=1`（全新 client 的第一个 hit 带 `_fv=1`），
GA4 正是靠它们生成 `session_start`、`first_visit` 以及会话数、新用户数。开启 `debug` 时每个
hit 还会带上 `ep.debug_mode=true`（gtag.js 发送的就是它）以及旧的 `_dbg=1`。GA4 DebugView 只会列出发送了调试标记的设备，所以用 DebugView 验证时请开启
`debug`（并且刷新 DebugView 页面 / 重新展开设备下拉框，因为设备列表不会自动刷新）。

默认传输使用 `uni.request`，默认持久化使用 `uni.getStorageSync`、
`uni.setStorageSync` 和 `uni.removeStorageSync`。SDK 默认路径不会走浏览器专属的
`Image`、`fetch` 或 `localStorage` 兜底。

### 投递可靠性

hit 按先后顺序、一次一个请求地投递；只有收到 2xx/3xx 响应后才会从队列中移除。请求失败或
超时时，该 hit（以及排在它后面的所有 hit）会继续留在队列里，队列会通过 uni 存储持久化，并按
退避策略重试；应用关闭前没送出去的 hit 会在下一次 `init()` 时补发。

```ts
createUniAppGA4({
  measurementId: "G-XXXXXXXXXX",
  requestTimeoutMs: 10_000, // 单个请求超时，默认 10 秒（网络被屏蔽时快速失败）
  retryDelaysMs: [2_000, 5_000, 15_000, 30_000, 60_000], // 退避间隔，最后一个值会重复；传 [] 关闭定时重试
  maxQueueSize: 100, // 未送达 hit 的上限，超出时丢弃最旧的
  persistQueue: true, // 跨应用重启保留未送达的 hit
  maxPendingAgeMs: 24 * 60 * 60 * 1000, // 超过该时长的 hit 直接丢弃，不再重试
})
```

如果你的用户无法稳定访问 `www.google-analytics.com`（例如中国大陆网络），可以把
`collectEndpoint` 指向一个自有的中转服务，由它把查询串转发到
`https://www.google-analytics.com/g/collect`。

## Automatic Collection

`ga4.init()` enables these collectors by default:

- initial `page_view`
- uni interceptors for `navigateTo`, `redirectTo`, `reLaunch`, `switchTab`, `navigateBack`, `downloadFile`, and `openDocument`
- H5 `history.pushState/replaceState/popstate` page views
- H5 outbound-link, file-download, form-start, form-submit, scroll, pagehide, and visibility flush listeners

The public event names and common event parameter keys are typed from
`@types/gtag.js`; direct-collect URL parameter mapping remains internal to this
SDK.

The SDK imports `core-js` URL and URLSearchParams polyfills at the package entry
so uni-app App runtimes without native `URL` objects can still use WHATWG-style
URL parsing. H5 builds keep using native implementations when they are already
valid.

In App runtimes that do not expose `location.href`, page locations are built
from the uni page route and `appOrigin`. If `appOrigin` is omitted, the fallback
origin is `https://uniapp.local`, so GA4 still receives a protocol-qualified
`page_location` such as `https://uniapp.local/pages/index/index`.

`ga4.init()` 默认开启这些自动统计能力：

- 初始 `page_view`
- `navigateTo`、`redirectTo`、`reLaunch`、`switchTab`、`navigateBack`、`downloadFile`、`openDocument` 的 uni 拦截器
- H5 `history.pushState/replaceState/popstate` 页面浏览
- H5 外链点击、文件下载、表单开始、表单提交、滚动、pagehide、visibility flush 监听

公共事件名和常见事件参数 key 使用 `@types/gtag.js` 类型；direct collect 的 URL 参数映射仍由 SDK 内部维护。

SDK 在入口处导入 `core-js` 的 URL 和 URLSearchParams 垫片，因此没有原生
`URL` 对象的 uni-app App 运行时也会走 WHATWG 风格 URL 解析。H5 环境已有有效原生实现时会继续使用原生实现。

在没有 `location.href` 的 App 运行时，页面地址会由 uni 页面路由和 `appOrigin`
拼出。未配置 `appOrigin` 时兜底 origin 是 `https://uniapp.local`，因此 GA4 仍会收到带 protocol 的
`page_location`，例如 `https://uniapp.local/pages/index/index`。

## Playground

The `playground/` directory is created from the official uni-app Vue 3 + Vite TypeScript template. The official CLI docs recommend `dcloudio/uni-preset-vue#vite-ts` for this template family.

`playground/` 目录来自官方 uni-app Vue 3 + Vite TypeScript 模板。官方 CLI 文档推荐使用 `dcloudio/uni-preset-vue#vite-ts` 这一模板分支。

```bash
bun install
bun run playground:dev
```

For local GA4 DebugView testing, create `playground/.env.local`:

```bash
VITE_GA4_MEASUREMENT_ID=G-XXXXXXXXXX
```

## MCP Docs Server

Build the package and generate the API Extractor JSON first:

先构建包并生成 API Extractor JSON：

```bash
bun install
bun run docs
```

Start the docs MCP server:

启动文档 MCP 服务器：

```bash
ga4-uniapp mcp
```

Use a custom docs path:

使用自定义文档路径：

```bash
ga4-uniapp mcp --docs=./docs/public/json/ga4-uniapp.api.json
```

Available MCP tools:

可用 MCP 工具：

- `ga4_uniapp_search_docs`: search generated API docs by keyword.
- `ga4_uniapp_get_doc`: read one exact generated API doc entry.
- `ga4_uniapp_list_capabilities`: list exported runtime APIs and exported types from the main package entry.

The package intentionally exports only the main entry (`"."`). Type information is emitted through `dist/index.d.ts`, without a separate `./types` export path.

本包有意只导出主入口（`"."`）。类型信息通过 `dist/index.d.ts` 提供，不再单独提供 `./types` 导出路径。
