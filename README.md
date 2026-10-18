# My Model — DeepSeek Web for DeepSeek Harness

`My Model` adds a **My Model / 我的模型** page under Harness Settings and a
`deepseek-web` model provider. It calls the same web-chat endpoints as
`chat.deepseek.com` using your own browser login, so no official API key is
needed.

> This is not an official DeepSeek API. It uses the web product's login state
> and web quota, is subject to DeepSeek's terms, and can break when the web
> frontend, anti-bot checks, or quota rules change. Never share your token.

## Install

The package is a normal local DSH bundle. Install it into the active profile:

```powershell
dsh plugin --profile desktop add "<absolute path to this directory>"
```

or use the Plugin Manager's **Install from directory** action. After install,
open **Settings → My Model / 我的模型**.

## Configure

1. Open <https://chat.deepseek.com> in a browser and sign in.
2. Open DevTools → **Application** → **Local Storage** →
   `https://chat.deepseek.com`.
3. Copy the `userToken` entry's `value`. The raw
   `{"value":"…","__version":"0"}` wrapper is also accepted.
4. Paste it into **My Model → User Token**, then **Save**.
5. Click **Test connection**. A success means the token was accepted and the
   proof-of-work challenge was solved locally (no chat message is sent).

If the upstream responds with a human-verification challenge (AWS WAF,
Cloudflare, or Huawei Cloud WAF) — including one served as HTTP 200 with an HTML
body — paste the site's cookie string into the optional **Cookie** field and
retry. Huawei challenges are recognised by `Server: CW`, `HWWAF*` markers, and
the usual verification copy (人机验证 / 验证码 / 请完成验证). The client also keeps `Set-Cookie` values it receives while running.

## Models

| Model id | Mode | Notes |
| --- | --- | --- |
| `deepseek-web-chat` | Quick | No reasoning phase. |
| `deepseek-web-thinking` | Expert / thinking | Emits a reasoning block, then the answer. |
| `deepseek-web-search` | Expert + web search | Upstream performs the search. |

Pick one in the composer model selector. The settings page can also set the
default for **new** sessions; existing sessions keep their own model.

## Rate limits

The web account is a shared, rate-limited resource. The plugin treats it that
way instead of firing every Harness request at it:

- **One generation at a time.** Main turns, title generation, and subagents
  queue behind one account slot, with a short gap between turn starts.
- **Session reuse.** A conversation keeps its `chat.deepseek.com` session for
  up to 12 hours, so a continuing turn sends only the new tail instead of
  rebuilding the whole transcript in a fresh session. The cache key includes the
  Harness session, the web model, and the token, so switching to another
  provider (for example the official API) and back reuses the same web
  conversation instead of dropping it.
- **Stale session recovery.** If the upstream rejects a reused session because
  it expired or was deleted while you were away, the turn is retried once with a
  freshly created session (`STALE_SESSION`) instead of failing.
- **Cheaper session creation.** A new chat session is created with a bare
  request; the PoW challenge is spent only on the completion call. If an older
  upstream still requires PoW for session creation, the client detects it once
  and remembers the fallback.
- **Cooldown, not hot retries.** An upstream 429 or `rate_limit_reached` sets a
  jittered exponential cooldown and honors `Retry-After`. Waits shorter than
  `maxAutoWaitMs` happen inside the turn; longer ones fail with a `RATE_LIMIT`
  retry hint so the Harness schedules the next attempt instead of hammering.
- **PoW retry.** A rejected proof-of-work challenge is re-solved once
  automatically (a challenge can expire between fetch and use), instead of
  failing the turn.
- **Transient upstream retry.** Overload/busy answers that arrive as an
  in-stream error frame (`服务器暂时不可用`, `service is busy`, `overloaded`,
  …) carry no HTTP status, so they are classified `SERVER` and retried in-turn
  once (about 1–2 s backoff; the host retries after 5 s) instead of failing an
  otherwise healthy turn. The retry is skipped once output has started, so
  visible text is never duplicated.
- **Terminal classification.** Quota exhaustion (`QUOTA`) and a muted account
  (`ACCOUNT_MUTED`) are reported separately and are not retried.
- **No duplicate output.** A failure after the first streamed chunk is a
  terminal `STREAM_INTERRUPTED`, not a retry that would repeat visible text.

These options shape that behavior (all optional):

| Key | Default | Meaning |
| --- | --- | --- |
| `maxConcurrentTurns` | `1` | Maximum generations in flight for the account. |
| `minTurnGapMs` | `3000` | Minimum gap between turn starts. |
| `maxAutoWaitMs` | `20000` | Longest cooldown the plugin waits inside a turn. |
| `cooldownBaseMs` | `15000` | First cooldown after a rate limit. |
| `maxCooldownMs` | `120000` | Cooldown cap. |

`clientVersion` (default `2.5.0`) sets the `x-client-version` header and should
track the deployed web client; a stale value is more likely to be flagged by
upstream risk control.

Pacing reduces the chance of hitting the limiter, but it cannot bypass the
upstream account/IP quota. If the account is muted or the daily quota is
exhausted, wait for the upstream to reset or use another account.

## Tools

The web endpoint has no native function-calling field. The plugin adds a DSML
text protocol to the system prompt, parses complete tool calls out of the
stream, tolerates an occasional malformed CDATA close, recovers calls from a
truncated closing tag, and turns them into Harness `tool-call` blocks. Tool
calls depend on the model following the protocol; unrecoverable fragments are
cleaned out of the visible answer.

Each tool result is truncated to `maxToolChars` (default `8000`) and common
credential shapes (`sk-…`, `Bearer …`, `api_key=…`, `password=…`, `token=…`) are
redacted before it is replayed. File paths are preserved because the model needs
them to act. Lower `maxToolChars` if large command outputs should not dominate a
turn.

A thinking-mode stream that ends with the whole turn inside the reasoning
channel and an empty answer — the model drafted its tool call in its thinking
and the fragment-type switch was missed — is healed: the calls are parsed back
out of the reasoning and executed, and the plugin log records
`answer channel was empty; recovered N tool call(s) from the reasoning
channel`. A fence spelling the streaming sieve does not recognise (a spaced
`<| DSML | invoke …>` variant) is recovered from the answer text the same way
(`recovered N tool call(s) from the answer text`). The reasoning text itself is
already visible to the user, so it is not re-emitted as the answer.

When a turn ends with neither a tool call nor usable text — which the UI would
otherwise show as a plain "已完成" with an empty answer — the plugin log
records a `suspicious completion` line with the answer length, a snippet, and
the raw upstream frames (capped), so the next occurrence can be root-caused
from the log.

## Config

The bundle patch writes `config: {}`. Every field is optional:

```yaml
- id: my-model
  name: '@local/dsh-my-model'
  config:
    baseURL: https://chat.deepseek.com
    clientVersion: 2.5.0
    tokenEnv: DEEPSEEK_WEB_TOKEN
    cookiesEnv: DEEPSEEK_WEB_COOKIES
    timeoutMs: 300000
    maxPromptChars: 1000000
    maxToolChars: 8000
    minTurnGapMs: 3000
    maxConcurrentTurns: 1
    maxAutoWaitMs: 20000
    cooldownBaseMs: 15000
    maxCooldownMs: 120000
```

The adapter reports the DeepSeek web context window as 1M tokens. Because the
transcript builder works in characters, `maxPromptChars` stays at 1,000,000
characters — roughly the same budget for CJK text, and a conservative budget
for Latin text — so a single oversized message is truncated instead of being
rejected by the upstream.

The token and cookie are stored through the Harness credential service under
`tokenEnv` / `cookiesEnv`; they are not written into `cordis.patch.yml`.

### Detection-avoidance options (方案A)

The web endpoint is a consumer product with anti-bot risk control. When it is
driven from an automated agent (for example, to control the computer), the
account can be **muted** (`ACCOUNT_MUTED`, a terminal state — not retried). The
options below reduce how much the traffic looks like a non-browser bot. They
lower the probability of a mute but do **not** guarantee it; the durable fix is
to use the official DeepSeek API or a local model for agent workloads.

| Key | Default | Meaning |
| --- | --- | --- |
| `userAgent` | *(browser default)* | `User-Agent`. Match the browser that issued the login token. |
| `secChUa` | *(browser default)* | `sec-ch-ua` client hint. Match the live web client. |
| `secChUaPlatform` | `"Windows"` | `sec-ch-ua-platform` client hint. Match your OS. |
| `secChUaMobile` | `?0` | `sec-ch-ua-mobile` client hint. |
| `acceptLanguage` | `zh-CN,zh;q=0.9` | `Accept-Language`. Match the browser. |
| `clientLocale` | `zh_CN` | `x-client-locale`. |
| `clientPlatform` | `web` | `x-client-platform`. |
| `clientBundleId` | `com.deepseek.chat` | `x-client-bundle-id`. |
| `secFetchSite` | `same-origin` | `sec-fetch-site`, captured from a real same-origin fetch. |
| `secFetchMode` | `cors` | `sec-fetch-mode`. |
| `secFetchDest` | `empty` | `sec-fetch-dest`. |
| `priority` | `u=1, i` | `priority`. |
| `referer` | `https://chat.deepseek.com/a/chat/` | `Referer`. |
| `humanizePacing` | `true` | Jitter the inter-turn gap and insert occasional idle pauses. |
| `turnGapJitter` | `0.6` | Inter-turn gap jitter ratio (`0` = strict `minTurnGapMs`). |
| `humanLongPauseChance` | `0.25` | Probability of a longer idle before a turn. |
| `humanLongPauseMinMs` | `5000` | Lower bound of that idle. |
| `humanLongPauseMaxMs` | `20000` | Upper bound of that idle. |

These can also be set from **Settings → My Model → Browser fingerprint**. That
editor persists the values to `<profile>/.my-model.json` (merged over the loader
config on the next boot) and applies them to the live client immediately. Leave
a field blank to fall back to the built-in default. The file is per profile, so
each profile keeps its own fingerprint.

Operational rules that code cannot enforce:

- **Run the harness on the same machine and network as the browser that issued
  the token.** A datacenter proxy/VPN plus a reused token is the strongest mute
  trigger (it looks like credential abuse).
- **Keep `clientVersion` in sync with the deployed web client** — still the most
  important fingerprint field. The built-in defaults are a snapshot measured on
  this machine (Chrome 155 / web client 2.5.0); they still go stale as the
  browser and web client update. With no settings-page overrides, the adapter
  logs a startup reminder.
- Use a dedicated account, not your main, and rotate if one gets muted.
- The system prompt no longer announces the tool protocol; do not re-add phrases
  such as "function-calling field" or "OpenAI-style".

### Transport layer (TLS) — measured ceiling

The Node runtime generates the TLS handshake itself and `fetch` exposes no
knobs for it. Measured with `node tools/tls-probe.mjs` on this machine
(plugin node v22, OpenSSL 3.5 vs Chrome 155):

| Aspect | This plugin (Node) | Chrome 155 | Changeable from JS? |
| --- | --- | --- | --- |
| Offered ciphers | 52 | 16 (GREASE first) | only via a custom dispatcher |
| Extensions | 11, different order, no GREASE | 16, GREASE first | no — OpenSSL emits them |
| `encrypt_then_mac` / `extended_master_secret` | sent | not sent | no |
| SCT / `status_request` / `compress_certificate` | absent | sent | no |
| Supported groups | PQC `4588` first, 8 total | X25519, P-256, P-384 | no from `fetch` |
| key_share | PQC + X25519 | X25519 + P-256 | no |
| HTTP version | `http/1.1` (verified: undici fetch ALPN) | `h2` | no without an `undici` dispatcher |

The request path is the DSH-installed global dispatcher (proxy per environment
variables), and `fetch` accepts neither TLS options nor an HTTP/2 toggle, so
**nothing below the HTTP byte level can be changed in this plugin without
changing transport strategy**. Verified earlier in this cycle: unauthenticated
endpoints answer `{"code":40002,"msg":"Missing Token"}` instead of a WAF
challenge — the risk control in front of `chat.deepseek.com` was not gating on
the TLS fingerprint at that time.

If that changes, the only fidelity-restoring moves, in order of cost:

1. An `undici` dispatcher with `allowH2` (fixes only the h1/h2 bit; adds a
   runtime dependency and duplicates DSH's proxy-env logic).
2. Rewrite the client on `node:https` with a pinned `Agent`
   (`ciphers`/`ecdhCurve`/`sigalgs` — the probe prints what actually changes;
   still no GREASE, no SCT, no extension-order control, HTTP/1.1 only).
3. A `curl-impersonate` / Go `uTLS` sidecar on localhost — full ClientHello
   clone, but an external binary to build, ship, and keep updated.
4. Drive the user's real Chrome over CDP — the only option where the TLS stack
   is not a forgery but the browser itself (requires Chrome running with a
   debug port, and a fallback path when it is not).

Until the upstream rejects the Node handshake directly, options 1–3 buy
cosmetic JA3 proximity at the price of new failure modes; the probe is kept
as the regression detector — re-run it after any transport change, and watch
for `{"code":40002}` turning into challenge HTML from this same Node stack.

## Logs

The desktop app does not persist the host's stdout, so the plugin appends its
own warnings and errors to `<profile>/my-model.log` (rotated to `.1` at 1 MB).
For the `desktop` profile that is
`~/.dsh/profiles/desktop/my-model.log`. It records rate limits, WAF challenges,
PoW retries, session recoveries and transient-upstream retries (`retrying
DeepSeek Web call after STALE_SESSION` / `… after SERVER`), fingerprint
warnings, and every stopping cause (`terminal
failure ACCOUNT_MUTED`, `terminal failure WAF_CHALLENGE`, `terminal failure
QUOTA`, `terminal failure RATE_LIMIT`, …), and the same messages still go to the
host logger when one is attached. Open it in any editor, or watch it with
`tail -f` (Git Bash) / `Get-Content -Wait` (PowerShell).

The settings page mirrors the last failure on the account card as
`上次失败原因：<CODE> · <message>`, so a disconnect that happened while Harness
was busy has a visible reason without opening the log. The line clears itself
after the next successful turn.

## Files

- `index.js` — Host plugin, provider registration, settings API.
- `client.js` — Web settings section.
- `deepseek-web.js` — HTTP/SSE client and `LlmAdapter`.
- `dsml.js` — tool protocol, parser, stream sieve, prompt builder.
- `pow.js` + `sha3_wasm_bg.wasm` — DeepSeekHashV1 proof-of-work solver.
- `tools/tls-probe.mjs` — offline ClientHello fingerprint probe (dev only).

## Attribution

The DSML protocol/parser and the PoW approach are adapted from:

- <https://github.com/snake-aabb-wtf/deepseek-web2api-free> (MIT)
- <https://www.npmjs.com/package/@rezaparsian/deepseek-pow-solver> (MIT)

The icon and UI are original to this plugin.

## Development

```powershell
node --check index.js
node --check client.js
node --check deepseek-web.js
node --check dsml.js
node --check pow.js
npm test
```

`npm test` runs the self test, stream/host/UI smoke tests, and the rate-limit
scheduling/classification tests.

`node tools/tls-probe.mjs` captures this machine's real TLS ClientHello and
diffs it against the Chrome reference (see *Transport layer*). It is offline
and dev-only; `tools/` is not part of the bundle (`files` in `package.json`).
