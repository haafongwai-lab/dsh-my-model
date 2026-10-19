# My Model — DeepSeek Web & ChatGPT Web for DeepSeek Harness

`My Model` adds a **My Model / 我的模型** page under Harness Settings and two
model providers driven by your own browser login state, so no official API key
is needed:

| Provider id | Upstream | What you paste |
| --- | --- | --- |
| `deepseek-web` | `chat.deepseek.com` | the `userToken` from Local Storage |
| `chatgpt-web` | `chatgpt.com` | the `accessToken`, or the site cookies |

> Neither is an official API. Both use a web product's login state and web
> quota, are subject to that service's terms, and can break when the web
> frontend, anti-bot checks, or quota rules change. Never share your token or
> cookies.

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

## Configure — ChatGPT web

1. Open <https://chatgpt.com> in a browser and sign in.
2. Open DevTools → **Network** and pick any `backend-api` request.
3. Copy the token after `Authorization: Bearer` (the `accessToken`), or copy
   the whole **Cookie** request header. Opening
   <https://chatgpt.com/api/auth/session> in the browser also prints the
   `accessToken` in JSON.
4. Paste it into **My Model → ChatGPT web account → Token** and save.

Either credential works on its own:

- **accessToken only** — works until the token expires (the web product rotates
  it; a 401 means re-copy it).
- **cookies only** — the plugin exchanges them for a fresh token at
  `/api/auth/session` on every start, so this survives longer. Paste the
  cookies again after a Cloudflare challenge.

The **Test connection** button does two things: it exchanges the cookies at
`/api/auth/session`, and it fetches the sentinel
`chat-requirements` token (solving its proof of work locally) — so it proves the
whole auth path without sending a chat message. Cloudflare blocks and Turnstile
challenges (`CHALLENGE_REQUIRED`) cannot be solved outside a browser; the
reported message tells you what to paste and from where.

### Transport: Node fetch vs local Chrome (CDP)

chatgpt.com scores the TLS/JA3 fingerprint and HTTP version, which Node's
`fetch` cannot imitate — a perfectly valid token still gets
`403 {"detail":"Unusual activity has been detected from your device."}`. The
settings page therefore offers two transports:

| Transport | What it does | When to use |
| --- | --- | --- |
| Node fetch (default) | The host sends the request itself | First attempt; works when the IP and fingerprint are not questioned |
| Local Chrome | Runs the same `fetch` **inside your logged-in chatgpt.com tab** over CDP | When Node fetch is rejected as unusual activity |

#### One-click launch

**Settings → My Model → ChatGPT → Launch local Chrome** does the whole setup in
one request: it finds `chrome.exe` (or Edge/Chromium), starts it on a dedicated
profile with `--remote-debugging-port`, waits until the DevTools endpoint
answers, and switches the transport to **Local Chrome**. Sign in to
<https://chatgpt.com> in the window it opens (once), keep the window open, and
the next turn uses it.

- The port comes from the ChatGPT transport settings (default `9222`); the
  window is opened on <https://chatgpt.com/>.
- The profile is `%LOCALAPPDATA%\dsh-chrome` on Windows and
  `~/Library/Application Support/dsh-chrome` / `$XDG_CONFIG_HOME/dsh-chrome`
  elsewhere. Since Chrome 136 the **default** profile refuses remote debugging,
  which is exactly why the plugin starts its own.
- The executable is looked up in the usual install locations, then on `PATH`
  (Linux). Set `chromePath` to a full path if the browser lives elsewhere, and
  `chromeUserDataDir` to move the profile.
- If the port already answers, nothing is started — the existing window is
  reused and the transport is switched to it.
- If a Chrome window is already running on that same profile **without** a
  debug port, Chrome hands the new launch off and exits, so the port never
  opens; the action then reports that the profile is in use instead of
  pretending it worked. Close that window and retry.
- The endpoint only accepts the port, which is validated (1–65535); the
  executable and profile come from plugin config, never from the request.

#### Manual setup

1. Quit Chrome completely (check the task manager for leftovers).
2. Start it with a dedicated profile and a debug port:

   ```
   chrome.exe --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\dsh-chrome"
   ```

   Since Chrome 136 the **default** profile refuses remote debugging, so
   `--user-data-dir` is mandatory. The plugin only ever talks to
   `127.0.0.1:9222`; it never exposes the port beyond loopback.
3. Sign in to <https://chatgpt.com> in that window and keep it open.
4. In **Settings → My Model → ChatGPT**, choose **Use local Chrome**, then
   **Test connection**. The row shows whether the debug port is reachable and
   which browser answered.

With this transport the request is genuinely the browser's: same TLS stack,
HTTP/2 connection, cookies, and client hints. For accounts whose sentinel does
not demand Turnstile, the plugin still obtains the sentinel token and solves its
proof of work, because it makes the request itself. When `chat-requirements`
reports `turnstile.required`, the request cannot be replayed by any client, so
the plugin drives the tab's own composer (type, click send, read the reply from
the page) and lets the site supply the proof — see *Known limits* below. The
choice is persisted per profile in `<profile>/.my-model-chatgpt.json`.

## Models

| Model id | Provider | Mode | Notes |
| --- | --- | --- | --- |
| `deepseek-web-chat` | `deepseek-web` | Quick | No reasoning phase. |
| `deepseek-web-thinking` | `deepseek-web` | Expert / thinking | Emits a reasoning block, then the answer. |
| `deepseek-web-search` | `deepseek-web` | Expert + web search | Upstream performs the search. |
| `chatgpt-web-chat` | `chatgpt-web` | Chat | The chatgpt.com default model (`gpt-6-luna` unless configured). |

Pick one in the composer model selector. The settings page can also set the
default for **new** sessions; existing sessions keep their own model.

The ChatGPT provider deliberately exposes **one** model: it drives whatever the
web product serves by default, instead of mirroring the web picker (whose
entries change every few weeks). The web product keeps that choice in the
request payload (`"model": "gpt-6-luna"`), so the slug is configuration rather
than a hard-coded list. The default pins the free-tier model that became the web
default on 2026-10-08 (GPT-6 Luna; before that GPT-5.6 Luna, before that
GPT-5.5). `auto` remains available and is what the web UI sends when the picker
is left alone; set `chatgptModelSlug` to either if you want a different one.
Because a pinned slug can be retired without
notice — that is exactly what happened to GPT-5.5 on 2026-10-14, when every
client with a hard-coded slug started answering "Model not found" — the adapter
classifies that error (`MODEL_NOT_FOUND`) and **retries the turn once on
`auto`**, so a retired slug degrades instead of breaking.

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
    # DeepSeek web account
    baseURL: https://chat.deepseek.com
    clientVersion: 2.5.0
    tokenEnv: DEEPSEEK_WEB_TOKEN
    cookiesEnv: DEEPSEEK_WEB_COOKIES
    # ChatGPT web account
    chatgptBaseURL: https://chatgpt.com
    chatgptTokenEnv: CHATGPT_WEB_TOKEN
    chatgptCookiesEnv: CHATGPT_WEB_COOKIES
    chatgptModelSlug: gpt-6-luna
    chatgptLanguage: zh-CN
    chatgptTransport: node          # node | cdp
    chatgptCdpPort: 9222
    chatgptCdpHost: 127.0.0.1
    # One-click "Launch local Chrome". Empty means auto-detect the browser and
    # use the platform's default dsh-chrome profile directory.
    chromePath: ""
    chromeUserDataDir: ""
    # Shared by both accounts
    timeoutMs: 300000
    maxPromptChars: 1000000
    maxToolChars: 8000
    minTurnGapMs: 3000
    maxConcurrentTurns: 1
    maxAutoWaitMs: 20000
    cooldownBaseMs: 15000
    maxCooldownMs: 120000
```

The two web accounts are independent. Their credentials live in the Harness
credential service under their own `tokenEnv` / `cookiesEnv` keys and are never
written into `cordis.patch.yml`. Each provider has its own pacing scheduler, so
a turn on one account does not queue behind the other. The browser fingerprint
set on the settings page is shared by both clients, because it describes one
browser; `clientVersion` is DeepSeek only, and `chatgptLanguage` sets ChatGPT's
`oai-language` header. `maxPromptChars` / `maxToolChars` apply to both.

The adapter reports the DeepSeek web context window as 1M tokens. Because the
transcript builder works in characters, `maxPromptChars` stays at 1,000,000
characters — roughly the same budget for CJK text, and a conservative budget
for Latin text — so a single oversized message is truncated instead of being
rejected by the upstream.

The token and cookie are stored through the Harness credential service under
`tokenEnv` / `cookiesEnv`; they are not written into `cordis.patch.yml`.

### Detection-avoidance options (方案A)

Both web endpoints are consumer products with anti-bot risk control. When one
is driven from an automated agent (for example, to control the computer), the
account can be **muted** (`ACCOUNT_MUTED`, a terminal state — not retried). The
options below reduce how much the traffic looks like a non-browser bot. They
lower the probability of a mute but do **not** guarantee it; the durable fix is
to use the official API or a local model for agent workloads. The measured
evidence for this plugin comes from the DeepSeek account; chatgpt.com sits
behind Cloudflare, which is strictly harder to satisfy from Node than
`chat.deepseek.com` was — expect it to be the first of the two to refuse.

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
config on the next boot) and applies them to the live clients — both of them —
immediately. Leave a field blank to fall back to the built-in default. The file
is per profile, so each profile keeps its own fingerprint.

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

The settings page mirrors the last failure on each account card as
`上次失败原因：<CODE> · <message>`, so a disconnect that happened while Harness
was busy has a visible reason without opening the log. The line clears itself
after the next successful turn on that account.

## Files

- `index.js` — Host plugin, both provider registrations, settings API.
- `client.js` — Web settings section.
- `deepseek-web.js` — DeepSeek HTTP/SSE client, `LlmAdapter`, and the shared
  pacing primitives (`TurnScheduler`, cookie jar, retry helpers) both clients use.
- `chatgpt-web.js` — ChatGPT HTTP/SSE client and `LlmAdapter`: session-token
  exchange, sentinel `chat-requirements` with a local sha3-512 proof of work,
  and the streaming conversation diffing.
- `chrome-cdp.js` — a small CDP client (loopback only): tab discovery,
  `Runtime.evaluate` for in-page requests, a `Runtime.addBinding` channel so
  streaming still arrives chunk by chunk, and the page-composer calls
  (navigate/insert/send/read).
- `chrome-launch.js` — the one-click launcher: browser discovery per platform,
  the dedicated-profile arguments, spawning it detached, and waiting for the
  DevTools endpoint (with a specific error when the profile is already in use).
- `sha3.js` — SHA3-512 with a native fast path and a self-contained pure-JS
  Keccak fallback. The desktop app runs inside Electron, whose BoringSSL answers
  `Digest method not supported` for `createHash('sha3-512')`; the sentinel proof
  of work therefore never depends on the host's digest list.
- `dsml.js` — tool protocol, parser, stream sieve, prompt builder.
- `pow.js` + `sha3_wasm_bg.wasm` — DeepSeekHashV1 proof-of-work solver.
- `tools/tls-probe.mjs` — offline ClientHello fingerprint probe (dev only).

## Known limits of the ChatGPT path

- **The API reply cannot pass Turnstile; the page's own composer can.** With the
  local-Chrome transport attached to a signed-in tab, the bearer token is
  accepted (`persona: "chatgpt-freeaccount"`) and the sentinel issues a token,
  but `POST /backend-api/conversation` answers `403 Unusual activity` when
  `chat-requirements` reports `turnstile.required: true` — the proof is produced
  by the site's JavaScript during a real send, so no API replay can carry it.
  The plugin therefore stops the API path at `CHALLENGE_REQUIRED` on the Node
  transport, and on the `cdp` transport it types into the tab's composer and
  clicks send, letting the page supply the proof. Verified live on 2026-10-19:
  `What is 2+2?` → `4` and `What is 3+3?` → `6` through
  `ChatGptWebClient.conversationStream`.
- **Reading the reply is DOM-bound.** The live page (2026-10-19) carries no
  `[data-message-author-role]` at all: one `[data-turn-key]` wraps the user
  message *and* the answer, and the answer is the
  `[data-content-search-unit-key$=":assistant"]` (also
  `data-chatgpt-search-unit-key`) node, prefixed with the UI label
  `ChatGPT 说：`. The first implementation read the old role attribute and then
  skipped any turn starting with `你说：`, so it returned an empty string forever:
  ChatGPT answered in the browser while the Harness showed "thinking" until the
  turn was aborted. Now replies are located by the markup the page actually
  uses (all three shapes are tried), the UI prefixes and a bare "Thinking…"
  placeholder are stripped, and replies that existed before the send are marked
  so an older answer is never read as the new one. The DOM is polled every
  700 ms; completion comes from `data-talvt-turn-state="complete"` (or the
  disappearance of the stop button), a reply that has not started within 30 s
  fails in-turn with the page's counters, and the whole poll is capped at 180 s.
- **A new conversation per turn.** In composer mode the plugin always sends from
  a fresh chat and replays the whole transcript, because the page's UI owns the
  conversation id. That is correct, but it costs more tokens than the Node
  transport's session reuse.
- **Formatted text is flattened.** The reply is read as `innerText`, so headings,
  bold text and list markers are not recreated; code blocks arrive as their text
  (which keeps DSML tool-call markup intact) without the surrounding fences.
- **Bot protection can reject the device outright.** Observed in the field on
  2026-10-19: after the token exchange and the sentinel proof of work both
  succeeded, `POST /backend-api/conversation` answered

  ```
  HTTP 403  {"detail":"Unusual activity has been detected from your device. Try again later. (b43ae1c3-…)"}
  ```

  That is Cloudflare/OpenAI bot management, not a credential error, so the plugin
  reports it as `RISK_CONTROL` (terminal, never retried) and says so instead of
  asking for a fresh token. The credential was valid and the PoW gate was passed;
  the request was rejected on device/network reputation. Retrying in a loop
  extends the block.
- **Why it happens, and what actually changes it.** The signal that matters most
  is the TLS/JA3 fingerprint plus HTTP version, and `fetch` cannot change either —
  this is the same ceiling described in *Transport layer* above. The local-Chrome
  transport above is the answer: it runs the request inside the browser, so the
  fingerprint is not a forgery. Before reaching for it, the cheap checks are worth
  doing: run the harness on the same network/IP as the browser that minted the
  token (a proxy or VPN the browser did not use is a strong trigger), and copy
  the browser's exact `userAgent` / `secChUa*` / `acceptLanguage` into the
  settings page.
- **Turnstile and the Node transport.** Without Chrome, a `turnstile.required`
  sentinel is reported as `CHALLENGE_REQUIRED` with paste instructions; it
  cannot be solved from Node. Choose the local-Chrome transport for such an
  account. A Cloudflare challenge in front of the page itself is still solved
  only by the browser: solve it in the tab and paste fresh cookies (including
  `cf_clearance`).
- **The payload is a snapshot.** The `POST /backend-api/conversation` body
  (`action`, `parent_message_id`, `conversation_mode`, `system_hints`, …) and the
  sentinel headers were captured from the current web client. When OpenAI ships
  a client update the shape can change; a 400 that mentions an unknown field, or
  frames the parser does not recognise, is the signal to re-capture it. The
  composer path is even more exposed to markup changes: if the answer stops
  arriving again, compare the selectors in `chrome-cdp.js` with the live DOM
  first.
- **The sentinel difficulty is a threshold, not a mask.** `chat-requirements`
  reports it as a hex string (`"0717f3"`). The digest's leading
  `difficulty.length` hex digits, read as a number, must be **≤ the difficulty**.
  Reading it as "the digest starts with these nibbles" turns a 1-in-36 search
  into a 1-in-16.7-million one — the first implementation burned 976 000 hashes
  and never converged. With the threshold reading, the same challenge needs ~24
  hashes (median) and finishes in well under a millisecond. `parseDifficulty` is
  unit-tested against the value chatgpt.com actually sent.
- **SHA-3 availability and cost.** The sentinel proof of work needs sha3-512.
  Electron's BoringSSL does not provide it (`Digest method not supported`), so
  `sha3.js` ships a pure-JS Keccak and picks it automatically when the native
  digest is missing. The fallback costs roughly 25 µs per hash, so a
  difficulty-4 challenge takes about a second; the native path is an order of
  magnitude faster. `test/sha3.mjs` keeps both implementations byte-identical.
  The search runs in slices that yield to the event loop — an unsliced loop
  froze the whole host for minutes when a challenge did not converge — and it is
  bounded by a 20 s budget. A challenge that still does not converge fails with
  `CHALLENGE_UNSOLVED`, logs the difficulty/threshold/seed length, and backs off
  for five minutes instead of re-burning the budget on every turn.

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
node --check chatgpt-web.js
node --check chrome-cdp.js
node --check chrome-launch.js
node --check sha3.js
node --check dsml.js
node --check pow.js
npm test
```

`npm test` runs the self test, stream/host/UI smoke tests, the rate-limit
scheduling/classification tests, the ChatGPT adapter smoke test (session
exchange, sentinel PoW, cumulative-SSE diffing, failure classification, session
reuse and stale-conversation recovery — all against a stubbed upstream), the
SHA3 test (pure-JS vs native digest across single- and multi-block inputs), and
the CDP test (tab discovery, in-page JSON, streamed frames over a binding, the
page-composer path — including that the reply is read from the live page's
assistant node and that pre-existing replies are marked — and the error paths,
against a fake DevTools endpoint and WebSocket), and the launcher test (browser
discovery per platform, the dedicated-profile arguments, reuse of an open debug
port, a successful spawn, and the "no browser" / "profile in use" / "port never
opened" failures — with the spawn and probe functions stubbed).

`node tools/tls-probe.mjs` captures this machine's real TLS ClientHello and
diffs it against the Chrome reference (see *Transport layer*). It is offline
and dev-only; `tools/` is not part of the bundle (`files` in `package.json`).
