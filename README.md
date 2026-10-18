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

## Logs

The desktop app does not persist the host's stdout, so the plugin appends its
own warnings and errors to `<profile>/my-model.log` (rotated to `.1` at 1 MB).
For the `desktop` profile that is
`~/.dsh/profiles/desktop/my-model.log`. It records rate limits, WAF challenges,
PoW retries, session recoveries (`retrying DeepSeek Web call after
STALE_SESSION`), fingerprint warnings, and every stopping cause (`terminal
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
