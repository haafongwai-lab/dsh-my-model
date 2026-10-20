window.__ModuleLoader__.load({
  id: '@local/dsh-my-model',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ZH = {
      'section.label': '我的模型',
      title: '我的模型',
      intro:
        '使用你自己的 DeepSeek 网页版或 ChatGPT 网页版登录态，在 Harness 中调用 chat.deepseek.com 与 chatgpt.com 的免费网页模型。',
      'account.title': 'DeepSeek 网页版账号',
      'account.desc': '凭据保存在 Harness 本地凭据库，不会写入配置文件。',
      'chatgpt.title': 'ChatGPT 网页版账号',
      'chatgpt.desc': '使用 accessToken 或 chatgpt.com 的 Cookie；凭据同样只保存在本机凭据库。',
      'chatgpt.descCdp': '登录态由本机 Chrome 窗口提供，下面的 Token / Cookie 可以留空。',
      'chatgpt.cdpReady': '已连上 Chrome',
      'chatgpt.cdpMissing': '未连上 Chrome',
      'chatgpt.headlessDesc':
        '常驻无头 Chromium 在后台保持一个已登录 chatgpt.com 的浏览器，关闭所有可见 Chrome 窗口也不影响调用；Harness 重启后会接管仍在运行的实例。',
      'chatgpt.headlessReady': '无头 Chromium 已运行',
      'chatgpt.headlessMissing': '无头 Chromium 未运行',
      'chatgpt.headlessHint':
        '无头 profile 与可视 Chrome 不共享登录态：启动时会尝试从本机 Chrome 复制 chatgpt.com Cookie（含 cf_clearance）；复制不到时请在下方粘贴 Cookie。',
      'chatgpt.help.summary': '如何获取 ChatGPT 登录态',
      'chatgpt.help.step1': '在浏览器打开 chatgpt.com 并登录。',
      'chatgpt.help.step2': 'F12 打开开发者工具 → Network，任选一条 backend-api 请求。',
      'chatgpt.help.step3': '在请求头里复制 Authorization: Bearer 后面那一串（accessToken），或复制 Request Headers 里整段 Cookie。',
      'chatgpt.help.step4': '回到这里粘贴并保存。访问 https://chatgpt.com/api/auth/session 也能拿到 accessToken，有效期有限，失效时重新复制即可。',
      'chatgpt.paste': '粘贴 accessToken（Bearer 后面那一串）或整段 Cookie',
      'chatgpt.cookie.placeholder': '遇到人机验证或 Cloudflare 拦截时，粘贴 chatgpt.com 的 Cookie（含 cf_clearance）',
      'chatgpt.tested': '连接成功，sentinel 校验已通过。',
      'chatgpt.confirmClear': '确定要清除保存的 accessToken 和 Cookie 吗？',
      'transport.label': '传输方式',
      'transport.node': 'Node 直连',
      'transport.cdp': '本机 Chrome',
      'transport.cdpWithFallback': '本机 Chrome（自动回退）',
      'transport.headless': '常驻无头 Chromium',
      'transport.useHeadless': '改用常驻无头 Chromium',
      'transport.desc':
        'Node 直连会带上非浏览器的 TLS 指纹，容易被 Cloudflare 判定为「设备异常」（HTTP 403 Unusual activity）。改用本机 Chrome 后，请求在已登录 chatgpt.com 的页面里发出，TLS、HTTP/2、Cookie 与指纹都是浏览器的。',
      'transport.useNode': '改用 Node 直连',
      'transport.useCdp': '改用本机 Chrome',
      'transport.reachable': '调试端口可用',
      'transport.unreachable': '未检测到 Chrome 调试端口',
      'transport.howto': '如何开启 Chrome 调试端口',
      'transport.step1': '完全退出 Chrome（任务管理器里确认没有残留进程）。',
      'transport.step2':
        '用独立用户目录启动（Chrome 136 起默认用户目录不允许远程调试，必须带 --user-data-dir）：',
      'transport.step3': '在那个窗口里登录 chatgpt.com 并保持打开，然后点「改用本机 Chrome」并重新测试连接。',
      'transport.saved': '传输方式已切换。',
      'launch.action': '一键启动本地 Chrome',
      'launch.starting': '正在启动 Chrome…',
      'launch.hint':
        '用独立配置目录打开一个可调试的 Chrome 窗口并自动切到「本机 Chrome」。首次请在该窗口登录 chatgpt.com，之后保持打开即可。',
      'launch.started': 'Chrome 已启动，请在该窗口登录 chatgpt.com。',
      'launch.alreadyRunning': '调试端口已在监听，已切到「本机 Chrome」。',
      'deepseekTransport.desc':
        'Node 直连带的是 Harness 自己的 TLS 指纹；本机 Chrome 会在已登录 chat.deepseek.com 的标签页里发出请求，TLS、HTTP/2、Cookie 与浏览器指纹都来自 Chrome。',
      'deepseekTransport.fallback':
        '关闭 Chrome、调试端口不可用或标签页不存在时，会自动回退到 Node 直连；已同步的浏览器 Cookie 与缓存的 Token 会继续使用，Harness 不会因此中断调用。',
      'deepseekTransport.cdpReady': '已连上 Chrome',
      'deepseekTransport.cdpMissing': '未连上 Chrome',
      'deepseekTransport.descCdp': '登录态由本机 Chrome 窗口提供，Token / Cookie 可以留空。',
      'deepseekTransport.step3':
        '在那个窗口登录 chat.deepseek.com，然后点「改用本机 Chrome」并重新测试连接。关闭窗口后会自动回退 Node。',
      'deepseekTransport.headlessDesc':
        '常驻无头 Chromium 使用独立 profile 和调试端口，由 Harness 后台保持运行；关闭所有可见 Chrome 窗口也不影响调用。该模式不走 Node，要求已保存 Token（或先用本机 Chrome 同步一次登录态）。',
      'deepseekTransport.headlessHint':
        '首次使用会自动启动无头 Chromium。Harness 重启后会接管仍在运行的实例；Cookie 与 Token 会在首次请求时注入。',
      'deepseekTransport.headlessReady': '无头 Chromium 已运行',
      'deepseekTransport.headlessMissing': '无头 Chromium 未运行（首次请求会自动启动）',
      'deepseekLaunch.headlessAction': '启动常驻无头 Chromium',
      'deepseekLaunch.headlessStarting': '正在启动无头 Chromium…',
      'deepseekLaunch.headlessStarted': '无头 Chromium 已启动并切换。',
      'deepseekLaunch.headlessRunning': '无头 Chromium 已在运行，已切换。',
      'deepseekLaunch.action': '启动本地 Chrome 并登录 DeepSeek',
      'deepseekLaunch.starting': '正在启动 Chrome…',
      'deepseekLaunch.hint':
        '用独立配置目录打开一个可调试的 Chrome 窗口并自动切到「本机 Chrome」。首次请在该窗口登录 chat.deepseek.com；关闭窗口后会回退 Node，Harness 仍可调用。',
      'deepseekLaunch.started': 'Chrome 已启动，请在该窗口登录 chat.deepseek.com。',
      'deepseekLaunch.alreadyRunning':
        '调试端口已在监听，已切到「本机 Chrome」；请确认已打开 chat.deepseek.com。',
      'token.label': 'User Token',
      'token.placeholder.empty': '粘贴 chat.deepseek.com 的 userToken',
      'token.placeholder.saved': '已保存，留空保持不变',
      'cookie.label': 'Cookie（可选）',
      'cookie.placeholder': '遇到人机验证时，粘贴 chat.deepseek.com 的 Cookie',
      'cookie.clear': '清除',
      'status.configured': '已配置',
      'status.missing': '未配置',
      'status.active': '模型路由已注册',
      'status.inactive': '模型路由未注册',
      'action.save': '保存',
      'action.saving': '保存中…',
      'action.test': '测试连接',
      'action.testing': '测试中…',
      'action.clear': '清除凭据',
      'action.clearing': '清除中…',
      'action.retry': '重试',
      'help.summary': '如何获取 Token',
      'help.step1': '在浏览器打开 chat.deepseek.com 并登录。',
      'help.step2': '按 F12 打开开发者工具，进入 Application → Local Storage → https://chat.deepseek.com。',
      'help.step3': '找到 userToken，复制它的 value；直接粘贴整段 {"value":"…","__version":"0"} 也可以。',
      'help.step4': '回到这里粘贴并保存。Token 只保存在本机凭据库，不会写进配置文件。',
      'models.title': '可用模型',
      'models.note': '在对话输入框的模型选择器里选择它们；各模型的差异见上方描述。',
      'models.currentDefault': '当前默认',
      'models.setDefault': '设为默认',
      'fingerprint.title': '浏览器指纹（高级）',
      'fingerprint.desc': '与登录 chat.deepseek.com 的浏览器保持一致，可降低被风控的概率；留空表示使用内置默认值。',
      'fingerprint.overridden': '已自定义',
      'fingerprint.defaultTag': '默认值',
      'fingerprint.userAgent': 'User-Agent',
      'fingerprint.secChUa': 'sec-ch-ua',
      'fingerprint.secChUaPlatform': 'sec-ch-ua-platform',
      'fingerprint.secChUaMobile': 'sec-ch-ua-mobile',
      'fingerprint.acceptLanguage': 'Accept-Language',
      'fingerprint.clientVersion': '客户端版本 (x-client-version)',
      'fingerprint.save': '保存指纹',
      'fingerprint.reset': '恢复默认',
      'fingerprint.saved': '指纹已保存并即时生效。',
      'fingerprint.resetDone': '已恢复默认指纹。',
      'fingerprint.unavailable': '当前无法定位 profile 目录，指纹无法持久化；请直接编辑插件配置。',
      'models.unavailable': '当前未注册（插件配置可能未生效）',
      'models.empty': '当前没有可用模型。',
      notice:
        '这不是 DeepSeek 或 OpenAI 的官方 API。它使用网页版登录态和网页版配额，受各自服务条款约束；接口变化、风控或人机验证都可能导致失效。请勿分享 Token 与 Cookie。',
      'message.saved': '已保存。',
      'message.tested': '连接成功，Token 有效。',
      'message.cleared': '已清除保存的 Token 和 Cookie。',
      'message.defaultSet': '已设为默认模型。',
      'message.cookieCleared': '已清除保存的 Cookie。',
      'message.loadFailed': '无法读取插件状态。',
      'message.nothingToSave': '没有需要保存的内容。',
      'message.confirmClear': '确定要清除保存的 Token 和 Cookie 吗？',
      'source.managed': 'Harness 凭据库',
      'source.environment': '环境变量',
      'lastTest.fail': '上次测试失败',
      'lastFailure.label': '上次失败原因',
      'lastFailure.hint': '完整记录见 profile 目录下的 my-model.log',
      loading: '正在读取状态…',
    }

    const EN = {
      'section.label': 'My Model',
      title: 'My Model',
      intro: 'Use your own DeepSeek web or ChatGPT web login to call the free chat.deepseek.com and chatgpt.com models from Harness.',
      'account.title': 'DeepSeek web account',
      'account.desc': 'Credentials are stored in the local Harness credential store, not in a config file.',
      'chatgpt.title': 'ChatGPT web account',
      'chatgpt.desc': 'Use an accessToken or the chatgpt.com cookies; both stay in the local credential store.',
      'chatgpt.descCdp': 'The local Chrome window provides the session, so Token and Cookie can stay empty.',
      'chatgpt.cdpReady': 'Chrome attached',
      'chatgpt.cdpMissing': 'Chrome not attached',
      'chatgpt.headlessDesc':
        'The managed headless Chromium keeps a signed-in chatgpt.com browser running in the background, so closing every visible Chrome window does not affect calls. A Harness restart adopts the still-running instance.',
      'chatgpt.headlessReady': 'Headless Chromium running',
      'chatgpt.headlessMissing': 'Headless Chromium not running',
      'chatgpt.headlessHint':
        'The headless profile does not share the visible Chrome login. Launching tries to copy the chatgpt.com cookies (including cf_clearance) from local Chrome; if that fails, paste the cookies below.',
      'chatgpt.help.summary': 'How to get a ChatGPT login',
      'chatgpt.help.step1': 'Open chatgpt.com in a browser and sign in.',
      'chatgpt.help.step2': 'Open DevTools → Network and pick any backend-api request.',
      'chatgpt.help.step3':
        'Copy the string after Authorization: Bearer (the accessToken), or the whole Cookie request header.',
      'chatgpt.help.step4':
        'Paste it here and save. https://chatgpt.com/api/auth/session also returns an accessToken; it expires, so re-copy it when a turn fails.',
      'chatgpt.paste': 'Paste the accessToken (after Bearer) or the whole Cookie string',
      'chatgpt.cookie.placeholder':
        'Paste chatgpt.com cookies (including cf_clearance) if a human-verification or Cloudflare challenge blocks the turn',
      'chatgpt.tested': 'Connected — the sentinel check passed.',
      'chatgpt.confirmClear': 'Clear the stored accessToken and cookie?',
      'transport.label': 'Transport',
      'transport.node': 'Node fetch',
      'transport.cdp': 'Local Chrome',
      'transport.cdpWithFallback': 'Local Chrome (auto fallback)',
      'transport.headless': 'Managed headless Chromium',
      'transport.useHeadless': 'Use managed headless Chromium',
      'transport.desc':
        'Node fetch carries a non-browser TLS fingerprint, which Cloudflare scores as “unusual activity” (HTTP 403). With local Chrome the request runs inside your logged-in chatgpt.com tab, so TLS, HTTP/2, cookies and client hints are the browser’s own.',
      'transport.useNode': 'Use Node fetch',
      'transport.useCdp': 'Use local Chrome',
      'transport.reachable': 'debug port reachable',
      'transport.unreachable': 'no Chrome debug port detected',
      'transport.howto': 'How to open the Chrome debug port',
      'transport.step1': 'Quit Chrome completely (check the task manager for leftovers).',
      'transport.step2':
        'Start it with a separate profile (since Chrome 136 the default profile refuses remote debugging, so --user-data-dir is required):',
      'transport.step3':
        'Sign in to chatgpt.com in that window, keep it open, then choose “Use local Chrome” and test the connection again.',
      'transport.saved': 'Transport switched.',
      'launch.action': 'Launch local Chrome',
      'launch.starting': 'Starting Chrome…',
      'launch.hint':
        'Opens a debuggable Chrome window on a dedicated profile and switches to “Local Chrome”. Sign in to chatgpt.com there once, then keep the window open.',
      'launch.started': 'Chrome started — sign in to chatgpt.com in that window.',
      'launch.alreadyRunning': 'A debug port is already listening; switched to “Local Chrome”.',
      'deepseekTransport.desc':
        'Node fetch carries Harness’s own TLS fingerprint. Local Chrome runs the request inside a signed-in chat.deepseek.com tab, so TLS, HTTP/2, cookies and client hints are the browser’s own.',
      'deepseekTransport.fallback':
        'If Chrome is closed, the debug port is unavailable, or the tab is missing, the client automatically falls back to Node fetch using the synced browser cookies and cached token — a Harness call never depends on the window staying open.',
      'deepseekTransport.cdpReady': 'Chrome attached',
      'deepseekTransport.cdpMissing': 'Chrome not attached',
      'deepseekTransport.descCdp': 'The local Chrome window provides the session, so Token and Cookie can stay empty.',
      'deepseekTransport.step3':
        'Sign in to chat.deepseek.com in that window, then choose “Use local Chrome” and test the connection again. Closing the window falls back to Node.',
      'deepseekTransport.headlessDesc':
        'The managed headless Chromium keeps its own profile and debug port alive in the background, so closing every visible Chrome window does not affect calls. This mode never falls back to Node; it needs a saved Token (or one synced once through local Chrome).',
      'deepseekTransport.headlessHint':
        'The headless browser starts automatically on first use. A Harness restart adopts the still-running instance; cookies and the token are injected on the first request.',
      'deepseekTransport.headlessReady': 'Headless Chromium running',
      'deepseekTransport.headlessMissing': 'Headless Chromium not running (starts on first use)',
      'deepseekLaunch.headlessAction': 'Start managed headless Chromium',
      'deepseekLaunch.headlessStarting': 'Starting headless Chromium…',
      'deepseekLaunch.headlessStarted': 'Headless Chromium started and selected.',
      'deepseekLaunch.headlessRunning': 'Headless Chromium already running; selected.',
      'deepseekLaunch.action': 'Launch Chrome for DeepSeek',
      'deepseekLaunch.starting': 'Starting Chrome…',
      'deepseekLaunch.hint':
        'Opens a debuggable Chrome window on a dedicated profile and switches to “Local Chrome”. Sign in to chat.deepseek.com there once; closing it falls back to Node without breaking Harness.',
      'deepseekLaunch.started': 'Chrome started — sign in to chat.deepseek.com in that window.',
      'deepseekLaunch.alreadyRunning':
        'A debug port is already listening; switched to “Local Chrome”. Confirm chat.deepseek.com is open.',
      'token.label': 'User token',
      'token.placeholder.empty': 'Paste the chat.deepseek.com userToken',
      'token.placeholder.saved': 'Saved — leave blank to keep it',
      'cookie.label': 'Cookie (optional)',
      'cookie.placeholder': 'Paste chat.deepseek.com cookies if you hit a human-verification challenge',
      'cookie.clear': 'Clear',
      'status.configured': 'Configured',
      'status.missing': 'Not configured',
      'status.active': 'Model route registered',
      'status.inactive': 'Model route not registered',
      'action.save': 'Save',
      'action.saving': 'Saving…',
      'action.test': 'Test connection',
      'action.testing': 'Testing…',
      'action.clear': 'Clear credentials',
      'action.clearing': 'Clearing…',
      'action.retry': 'Retry',
      'help.summary': 'How to get a token',
      'help.step1': 'Open chat.deepseek.com in a browser and sign in.',
      'help.step2': 'Open DevTools → Application → Local Storage → https://chat.deepseek.com.',
      'help.step3': 'Copy the `value` of `userToken`; the raw {"value":"…","__version":"0"} wrapper is accepted too.',
      'help.step4': 'Paste it here and save. The token stays in the local credential store, never in a config file.',
      'models.title': 'Available models',
      'models.note': 'Pick one in the composer model selector; each model’s behaviour is described above.',
      'models.currentDefault': 'Current default',
      'models.setDefault': 'Set as default',
      'fingerprint.title': 'Browser fingerprint (advanced)',
      'fingerprint.desc': 'Match the browser that signed in to chat.deepseek.com to reduce risk-control flags; leave blank to use the built-in defaults.',
      'fingerprint.overridden': 'Customized',
      'fingerprint.defaultTag': 'Defaults',
      'fingerprint.userAgent': 'User-Agent',
      'fingerprint.secChUa': 'sec-ch-ua',
      'fingerprint.secChUaPlatform': 'sec-ch-ua-platform',
      'fingerprint.secChUaMobile': 'sec-ch-ua-mobile',
      'fingerprint.acceptLanguage': 'Accept-Language',
      'fingerprint.clientVersion': 'Client version (x-client-version)',
      'fingerprint.save': 'Save fingerprint',
      'fingerprint.reset': 'Reset to defaults',
      'fingerprint.saved': 'Fingerprint saved and applied immediately.',
      'fingerprint.resetDone': 'Fingerprint reset to defaults.',
      'fingerprint.unavailable': 'The profile directory could not be located, so the fingerprint cannot be persisted; edit the plugin config instead.',
      'models.unavailable': 'Not registered right now (the plugin configuration may not be active)',
      'models.empty': 'No models are available right now.',
      notice:
        'This is not the official DeepSeek or OpenAI API. It uses your web login and web quota, subject to each service’s terms; upstream changes, anti-bot checks, or human-verification challenges can break it. Never share your token or cookies.',
      'message.saved': 'Saved.',
      'message.tested': 'Connected — the token works.',
      'message.cleared': 'Stored token and cookie cleared.',
      'message.defaultSet': 'Set as the default model.',
      'message.cookieCleared': 'Stored cookie cleared.',
      'message.loadFailed': 'Could not read the plugin status.',
      'message.nothingToSave': 'There is nothing to save.',
      'message.confirmClear': 'Clear the stored token and cookie?',
      'source.managed': 'Harness credential store',
      'source.environment': 'Environment variable',
      'lastTest.fail': 'Last test failed',
      'lastFailure.label': 'Last failure',
      'lastFailure.hint': 'The full history lives in my-model.log under the profile directory.',
      loading: 'Loading status…',
    }

    // Visual language mirrors the built-in Models section of Harness settings:
    // Matches the current Harness settings design system: 720px column,
    // 16/24 title, 20px-radius row cards, 12px-radius buttons/inputs,
    // 2px focus rings, and the same alias/radius tokens for both themes.
    const CSS = `
.dsh-mm-section{max-width:720px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.dsh-mm-title{margin:0;font-size:16px;font-weight:500;line-height:24px}
.dsh-mm-intro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:22px}
.dsh-mm-rows{display:flex;flex-direction:column;gap:8px;margin:12px 0 0;padding:0;list-style:none}
.dsh-mm-card{border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l4));background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2));border-radius:var(--dsw-radius-xl,20px);display:flex;flex-direction:column;gap:12px;padding:12px 14px}
.dsh-mm-rowHead{display:flex;align-items:center;gap:10px;min-height:22px}
.dsh-mm-name{font-size:14px;font-weight:500;line-height:22px}
.dsh-mm-rowMeta{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-align:right}
.dsh-mm-tag{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs,4px);color:var(--dsw-alias-label-secondary);flex:none;padding:1px 6px;font-size:11px;line-height:16px}
.dsh-mm-dot{background:var(--dsw-alias-label-dimmed);corner-shape:round;border-radius:50%;flex:none;width:8px;height:8px}
.dsh-mm-dot.on{background:var(--dsw-alias-state-success-primary)}
.dsh-mm-dot.off{background:var(--dsw-alias-state-error-primary)}
.dsh-mm-rowDesc{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsh-mm-editor{background:var(--dsw-alias-bg-module-platform);border-radius:var(--dsw-radius-lg,16px);display:flex;flex-direction:column;gap:14px;padding:14px 16px}
.dsh-mm-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.dsh-mm-fieldHead{display:flex;align-items:center;gap:8px}
.dsh-mm-fieldLabel{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}
.dsh-mm-spacer{flex:1}
.dsh-mm-input{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,12px);box-sizing:border-box;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;height:32px;line-height:22px;padding:0 10px;width:100%}
.dsh-mm-input::placeholder{color:var(--dsw-alias-label-dimmed)}
.dsh-mm-input:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}
.dsh-mm-input:disabled{opacity:.6;cursor:default}
.dsh-mm-textarea{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,12px);box-sizing:border-box;color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;min-height:64px;padding:6px 10px;resize:vertical;width:100%}
.dsh-mm-textarea::placeholder{color:var(--dsw-alias-label-dimmed)}
.dsh-mm-textarea:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}
.dsh-mm-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.dsh-mm-actions.even{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr)}
.dsh-mm-actions.even>.dsh-mm-button{width:100%;min-width:0;padding-left:10px;padding-right:10px}
/* One control system for every button on the page. The shared base fixes the
   box model, kills inherited transforms/filters/animation, and limits motion to
   colour only — so no state can ever resize or nudge a control. */
.dsh-mm-button,.dsh-mm-link,.dsh-mm-segment{-webkit-appearance:none;appearance:none;box-sizing:border-box;margin:0;border:0;background-color:transparent;background-image:none;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap;text-align:center;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;transform:none;filter:none;animation:none;will-change:auto;transition:background-color .12s ease,border-color .12s ease,color .12s ease,box-shadow .12s ease,opacity .12s ease}
.dsh-mm-button{height:36px;min-width:104px;padding:0 14px;border-radius:var(--dsw-radius-md,12px);gap:4px;font-size:14px;line-height:22px}
.dsh-mm-button:not(.primary):not(.danger){border:.5px solid var(--dsw-alias-border-l3)}
.dsh-mm-button:hover:not(:disabled){background-color:var(--dsw-alias-interactive-bg-hover-solid)}
.dsh-mm-button:active:not(:disabled){background-color:var(--dsw-alias-interactive-bg-hover-solid)}
.dsh-mm-button.primary{background-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dsh-mm-button.primary:hover:not(:disabled),.dsh-mm-button.primary:active:not(:disabled){background-color:var(--dsw-alias-button-primary-hover)}
.dsh-mm-button.danger{color:var(--dsw-alias-state-error-primary)}
.dsh-mm-button.danger:hover:not(:disabled),.dsh-mm-button.danger:active:not(:disabled){background-color:var(--dsw-alias-interactive-bg-hover-danger)}
.dsh-mm-button:disabled{cursor:default;opacity:.4}
.dsh-mm-link{height:28px;padding:0 8px;border-radius:var(--dsw-radius-sm,8px);gap:4px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsh-mm-link:hover:not(:disabled){background-color:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsh-mm-link:disabled{cursor:default;opacity:.4}
.dsh-mm-segmented{background:var(--dsw-alias-bg-layer-1);border-radius:var(--dsw-radius-md,12px);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l4);box-sizing:border-box;display:flex;gap:3px;padding:3px;width:100%}
.dsh-mm-segment{border-radius:var(--dsw-radius-sm,8px);color:var(--dsw-alias-label-tertiary);flex:1 1 0;font-size:12px;font-weight:500;height:30px;line-height:18px;min-width:0;padding:0 8px;white-space:nowrap}
.dsh-mm-segment:hover:not(:disabled):not([aria-pressed="true"]){background-color:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsh-mm-segment[aria-pressed="true"]{background-color:var(--dsw-alias-bg-layer-3);box-shadow:0 0 0 .5px var(--dsw-alias-border-l3),0 1px 2px rgba(0,0,0,.06);color:var(--dsw-alias-label-primary)}
.dsh-mm-segment:disabled{cursor:default;opacity:.4}
.dsh-mm-segment[aria-pressed="true"]:disabled{cursor:default;opacity:1}
.dsh-mm-button:focus-visible,.dsh-mm-link:focus-visible,.dsh-mm-segment:focus-visible,.dsh-mm-summary:focus-visible{box-shadow:0 0 0 var(--dsw-focus-ring-width,2px) var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline:none}
/* Defence in depth: host stylesheets sometimes attach a lift/filter/animation
   to every interactive element. Re-assert the neutral state on every pseudo
   class so a hover can never produce a 1px jump. */
.dsh-mm-section .dsh-mm-button,
.dsh-mm-section .dsh-mm-button:hover,
.dsh-mm-section .dsh-mm-button:active,
.dsh-mm-section .dsh-mm-button:focus,
.dsh-mm-section .dsh-mm-button:focus-visible,
.dsh-mm-section .dsh-mm-link,
.dsh-mm-section .dsh-mm-link:hover,
.dsh-mm-section .dsh-mm-link:active,
.dsh-mm-section .dsh-mm-link:focus-visible,
.dsh-mm-section .dsh-mm-segment,
.dsh-mm-section .dsh-mm-segment:hover,
.dsh-mm-section .dsh-mm-segment:active,
.dsh-mm-section .dsh-mm-segment:focus-visible,
.dsh-mm-section .dsh-mm-summary,
.dsh-mm-section .dsh-mm-summary:hover{transform:none;filter:none;animation:none;will-change:auto}
.dsh-mm-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsh-mm-details{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:10px}
.dsh-mm-summary{align-items:center;border:0;border-radius:var(--dsw-radius-sm,8px);color:var(--dsw-alias-label-secondary);cursor:pointer;display:flex;font-size:12px;font-weight:500;gap:6px;line-height:18px;list-style:none;margin-left:-4px;padding:2px 4px;width:fit-content;transform:none;filter:none;animation:none;transition:background-color .12s ease,color .12s ease}
.dsh-mm-summary::-webkit-details-marker{display:none}
.dsh-mm-summary::before{border-bottom:1.5px solid;border-right:1.5px solid;content:"";height:5px;transform:rotate(-45deg) translate(-1px,-1px);transition:transform .12s;width:5px}
.dsh-mm-details[open]>.dsh-mm-summary::before{transform:rotate(45deg) translate(-1px,-1px)}
.dsh-mm-summary:hover{color:var(--dsw-alias-label-primary)}
.dsh-mm-steps{color:var(--dsw-alias-label-tertiary);display:flex;flex-direction:column;font-size:12px;gap:4px;line-height:18px;margin:8px 0 0;padding-left:18px}
.dsh-mm-modelList{display:flex;flex-direction:column;gap:6px;list-style:none;margin:0;padding:0}
.dsh-mm-modelRow{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg,16px);display:grid;gap:10px;grid-template-columns:8px minmax(0,1fr);padding:8px 10px}
.dsh-mm-modelRow>.dsh-mm-dot{margin-top:7px}
.dsh-mm-modelName{font-size:14px;font-weight:500;line-height:22px}
.dsh-mm-modelDesc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsh-mm-savedNotice{color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px;margin:0}
.dsh-mm-lastFailure{color:var(--dsw-alias-state-warn-label);font-size:12px;line-height:18px;margin:0}
.dsh-mm-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin:0}
.dsh-mm-messageLine{align-items:center;display:flex;flex-wrap:wrap;gap:4px}
.dsh-mm-notice{color:var(--dsw-alias-state-warn-label);font-size:12px;line-height:18px;margin:0}
.dsh-mm-code{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm,8px);color:var(--dsw-alias-label-secondary);display:block;font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;margin:6px 0 0;overflow-x:auto;padding:6px 8px;white-space:pre}
@media (max-width:560px){.dsh-mm-card{padding:12px}.dsh-mm-editor{padding:12px}.dsh-mm-rowMeta{display:none}.dsh-mm-actions.even{display:flex;flex-wrap:wrap}.dsh-mm-actions.even>.dsh-mm-button{flex:1 1 100%;width:100%}.dsh-mm-segmented{flex-direction:column}.dsh-mm-segment{flex:none;width:100%}}
@media (prefers-reduced-motion:reduce){.dsh-mm-summary::before{transition:none}}
`

    // The settings shell maps section ids to a fixed set of glyphs and falls
    // back to the Settings gear for every other id, which would make "My Model"
    // look like a second Settings entry. Carry the section glyph in the nav
    // label instead and hide the fallback gear for that row. The glyph is the
    // whale emoji itself (U+1F40B), rendered by the system emoji font.
    const NAV_CSS = `
nav button:has(.dsh-mm-navGlyph)>svg{display:none}
.dsh-mm-navLabel{align-items:center;display:inline-flex;gap:8px;min-width:0}
.dsh-mm-navGlyph{align-items:center;display:inline-flex;flex:none;font-family:"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif;font-size:14px;justify-content:center;line-height:1;width:16px;height:16px}
`

    function renderSectionLabel(t) {
      return         h(
          'span',
          { className: 'dsh-mm-navLabel' },
          h(
            'span',
            {
              className: 'dsh-mm-navGlyph',
              'aria-hidden': 'true',
            },
            '\u{1F40B}',
          ),
          h('span', { className: 'dsh-mm-navText' }, t('section.label')),
        )
    }

    const FINGERPRINT_FIELDS = [
      { key: 'userAgent', label: 'fingerprint.userAgent' },
      { key: 'secChUa', label: 'fingerprint.secChUa' },
      { key: 'secChUaPlatform', label: 'fingerprint.secChUaPlatform' },
      { key: 'secChUaMobile', label: 'fingerprint.secChUaMobile' },
      { key: 'acceptLanguage', label: 'fingerprint.acceptLanguage' },
      { key: 'clientVersion', label: 'fingerprint.clientVersion' },
    ]

    function createSection(t) {
      function request(path, body) {
        const init = {
          method: body === undefined ? 'GET' : 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: body === undefined ? {} : { 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }
        return fetch(path, init).then(async (response) => {
          let data = null
          try {
            data = await response.json()
          } catch {
            data = null
          }
          if (!response.ok || data?.error) {
            const message = data?.error?.message ?? `HTTP ${response.status}`
            const error = new Error(message)
            error.code = data?.error?.code
            throw error
          }
          return data
        })
      }

      return function MyModelSection() {
        const [status, setStatus] = React.useState(null)
        const [token, setToken] = React.useState('')
        const [cookies, setCookies] = React.useState('')
        const [busy, setBusy] = React.useState('')
        const [message, setMessage] = React.useState(null)
        const [fpDraft, setFpDraft] = React.useState(null)
        const [chatgptToken, setChatgptToken] = React.useState('')
        const [chatgptCookies, setChatgptCookies] = React.useState('')

        const load = React.useCallback(async () => {
          try {
            const next = await request('/my-model/api/status')
            setStatus(next)
            if (next.lastTest && next.lastTest.ok === false) {
              setMessage({ kind: 'error', text: `${t('lastTest.fail')}: ${next.lastTest.message}` })
            }
          } catch (error) {
            setMessage({ kind: 'error', text: `${t('message.loadFailed')} ${error.message ?? ''}`.trim() })
          }
        }, [])

        React.useEffect(() => {
          load()
        }, [load])

        const save = async () => {
          setBusy('save')
          setMessage(null)
          try {
            const body = {}
            if (token.trim()) body.token = token.trim()
            if (cookies.trim()) body.cookies = cookies.trim()
            if (!body.token && !body.cookies) {
              setMessage({ kind: 'error', text: t('message.nothingToSave') })
              return
            }
            const next = await request('/my-model/api/credentials', body)
            setStatus(next)
            setToken('')
            setCookies('')
            setMessage({ kind: 'ok', text: t('message.saved') })
          } catch (error) {
            setMessage({ kind: 'error', text: error.message ?? String(error) })
          } finally {
            setBusy('')
          }
        }

        const test = async () => {
          setBusy('test')
          setMessage(null)
          try {
            const body = {}
            if (token.trim()) body.token = token.trim()
            if (cookies.trim()) body.cookies = cookies.trim()
            const result = await request('/my-model/api/test', body)
            setStatus(result.status ?? status)
            setMessage({
              kind: 'ok',
              text: `${t('message.tested')} ${result.lastTest?.latencyMs ? `(${result.lastTest.latencyMs} ms)` : ''}`.trim(),
            })
          } catch (error) {
            setMessage({ kind: 'error', text: error.message ?? String(error) })
          } finally {
            setBusy('')
          }
        }

        const clear = async () => {
          if (!window.confirm(t('message.confirmClear'))) return
          setBusy('clear')
          setMessage(null)
          try {
            const next = await request('/my-model/api/credentials', { clear: true })
            setStatus(next)
            setToken('')
            setCookies('')
            setMessage({ kind: 'ok', text: t('message.cleared') })
          } catch (error) {
            setMessage({ kind: 'error', text: error.message ?? String(error) })
          } finally {
            setBusy('')
          }
        }

        const clearCookie = async () => {
          setBusy('cookie')
          setMessage(null)
          try {
            const next = await request('/my-model/api/credentials', { cookies: '' })
            setStatus(next)
            setCookies('')
            setMessage({ kind: 'ok', text: t('message.cookieCleared') })
          } catch (error) {
            setMessage({ kind: 'error', text: error.message ?? String(error) })
          } finally {
            setBusy('')
          }
        }

        const saveChatgpt = async () => {
          setBusy('chatgptSave')
          setMessage(null)
          try {
            const body = {}
            if (chatgptToken.trim()) body.token = chatgptToken.trim()
            if (chatgptCookies.trim()) body.cookies = chatgptCookies.trim()
            if (!body.token && !body.cookies) {
              setMessage({ kind: 'error', text: t('message.nothingToSave') })
              return
            }
            const next = await request('/my-model/api/chatgpt/credentials', body)
            setStatus(next)
            setChatgptToken('')
            setChatgptCookies('')
            setMessage({ kind: 'ok', text: t('message.saved') })
          } catch (error) {
            setMessage({ kind: 'error', text: error.message ?? String(error) })
          } finally {
            setBusy('')
          }
        }

        const testChatgpt = async () => {
          setBusy('chatgptTest')
          setMessage(null)
          try {
            const body = {}
            if (chatgptToken.trim()) body.token = chatgptToken.trim()
            if (chatgptCookies.trim()) body.cookies = chatgptCookies.trim()
            const result = await request('/my-model/api/chatgpt/test', body)
            setStatus(result.status ?? status)
            setMessage(
              result.lastTest?.ok === true
                ? {
                    kind: 'ok',
                    text: `${t('chatgpt.tested')} ${result.lastTest?.latencyMs ? `(${result.lastTest.latencyMs} ms)` : ''}`.trim(),
                  }
                : { kind: 'error', text: result.lastTest?.message ?? String(result.message ?? '') },
            )
          } catch (error) {
            setMessage({ kind: 'error', text: error.message ?? String(error) })
          } finally {
            setBusy('')
          }
        }

        const clearChatgpt = async () => {
          if (!window.confirm(t('chatgpt.confirmClear'))) return
          setBusy('chatgptClear')
          setMessage(null)
          try {
            const next = await request('/my-model/api/chatgpt/credentials', { clear: true })
            setStatus(next)
            setChatgptToken('')
            setChatgptCookies('')
            setMessage({ kind: 'ok', text: t('message.cleared') })
          } catch (error) {
            setMessage({ kind: 'error', text: error.message ?? String(error) })
          } finally {
            setBusy('')
          }
        }

        const clearChatgptCookie = async () => {
          setBusy('chatgptCookie')
          setMessage(null)
          try {
            const next = await request('/my-model/api/chatgpt/credentials', { cookies: '' })
            setStatus(next)
            setChatgptCookies('')
            setMessage({ kind: 'ok', text: t('message.cookieCleared') })
          } catch (error) {
            setMessage({ kind: 'error', text: error.message ?? String(error) })
          } finally {
            setBusy('')
          }
        }

        const setDeepseekTransport = async (mode) => {
          setBusy('deepseekTransport')
          setMessage(null)
          try {
            const next = await request('/my-model/api/deepseek/transport', { transport: mode })
            setStatus(next)
            setMessage({ kind: 'ok', text: t('transport.saved') })
          } catch (error) {
            setMessage({ kind: 'error', text: error.message ?? String(error) })
          } finally {
            setBusy('')
          }
        }

        const launchDeepseekChrome = async () => {
          setBusy('deepseekLaunchChrome')
          setMessage(null)
          try {
            const result = await request('/my-model/api/deepseek/launch', {})
            setStatus(result.status ?? status)
            setMessage({
              kind: 'ok',
              text: result.launch?.alreadyRunning
                ? t('deepseekLaunch.alreadyRunning')
                : t('deepseekLaunch.started'),
            })
          } catch (error) {
            setMessage({ kind: 'error', text: error.message ?? String(error) })
          } finally {
            setBusy('')
          }
        }

        const startDeepseekHeadless = async () => {
          setBusy('deepseekHeadless')
          setMessage(null)
          try {
            const result = await request('/my-model/api/deepseek/headless', {})
            setStatus(result.status ?? status)
            setMessage({
              kind: 'ok',
              text: result.headless?.alreadyRunning
                ? t('deepseekLaunch.headlessRunning')
                : t('deepseekLaunch.headlessStarted'),
            })
          } catch (error) {
            setMessage({ kind: 'error', text: error.message ?? String(error) })
          } finally {
            setBusy('')
          }
        }

        const setTransport = async (mode) => {
          setBusy('transport')
          setMessage(null)
          try {
            const next = await request('/my-model/api/chatgpt/transport', { transport: mode })
            setStatus(next)
            setMessage({ kind: 'ok', text: t('transport.saved') })
          } catch (error) {
            setMessage({ kind: 'error', text: error.message ?? String(error) })
          } finally {
            setBusy('')
          }
        }

        const launchChrome = async () => {
          setBusy('launchChrome')
          setMessage(null)
          try {
            const result = await request('/my-model/api/chatgpt/launch', {})
            setStatus(result.status ?? status)
            setMessage({
              kind: 'ok',
              text: result.launch?.alreadyRunning ? t('launch.alreadyRunning') : t('launch.started'),
            })
          } catch (error) {
            setMessage({ kind: 'error', text: error.message ?? String(error) })
          } finally {
            setBusy('')
          }
        }

        const startChatgptHeadless = async () => {
          setBusy('chatgptHeadless')
          setMessage(null)
          try {
            const result = await request('/my-model/api/chatgpt/headless', {})
            setStatus(result.status ?? status)
            setMessage({
              kind: 'ok',
              text: result.headless?.alreadyRunning
                ? t('deepseekLaunch.headlessRunning')
                : t('deepseekLaunch.headlessStarted'),
            })
          } catch (error) {
            setMessage({ kind: 'error', text: error.message ?? String(error) })
          } finally {
            setBusy('')
          }
        }

        const setDefault = async (model) => {
          setBusy(`default:${model}`)
          setMessage(null)
          try {
            const result = await request('/my-model/api/default', { model })
            setStatus((prev) =>
              prev ? { ...prev, defaultSelection: result.defaultSelection ?? prev.defaultSelection } : prev,
            )
            setMessage({ kind: 'ok', text: t('message.defaultSet') })
          } catch (error) {
            setMessage({ kind: 'error', text: error.message ?? String(error) })
          } finally {
            setBusy('')
          }
        }

        const saveFingerprint = async () => {
          if (!fp) return
          setBusy('fingerprint')
          setMessage(null)
          try {
            const next = await request('/my-model/api/fingerprint', {
              userAgent: fp.userAgent ?? '',
              secChUa: fp.secChUa ?? '',
              secChUaPlatform: fp.secChUaPlatform ?? '',
              secChUaMobile: fp.secChUaMobile ?? '',
              acceptLanguage: fp.acceptLanguage ?? '',
              clientVersion: fp.clientVersion ?? '',
            })
            setStatus(next)
            setFpDraft(null)
            setMessage({ kind: 'ok', text: t('fingerprint.saved') })
          } catch (error) {
            setMessage({ kind: 'error', text: error.message ?? String(error) })
          } finally {
            setBusy('')
          }
        }

        const resetFingerprint = async () => {
          setBusy('fingerprint')
          setMessage(null)
          try {
            const next = await request('/my-model/api/fingerprint', { reset: true })
            setStatus(next)
            setFpDraft(null)
            setMessage({ kind: 'ok', text: t('fingerprint.resetDone') })
          } catch (error) {
            setMessage({ kind: 'error', text: error.message ?? String(error) })
          } finally {
            setBusy('')
          }
        }

        const tokenConfigured = status?.token?.configured === true
        const cookieConfigured = status?.cookies?.configured === true
        const active = status?.provider?.active === true
        // Chrome mode can use the tab's localStorage token, so it is usable
        // with both fields empty; closing Chrome falls back to Node in the host.
        const deepseekViaCdp = status?.transport === 'cdp'
        const deepseekViaHeadless = status?.transport === 'headless'
        const deepseekCdpReady = status?.cdp?.reachable === true
        const deepseekHeadlessReady = status?.headless?.running === true
        const deepseekBrowserMode = deepseekViaCdp || deepseekViaHeadless
        // Headless owns its own profile, so it needs a stored token; it starts
        // on demand, which is why readiness only depends on the token.
        const deepseekReady = deepseekViaHeadless
          ? tokenConfigured
          : tokenConfigured || (deepseekViaCdp && deepseekCdpReady)
        const models = Array.isArray(status?.models) ? status.models : []
        // The model list shows both providers; each model remembers where it
        // routes so "set as default" can pick the right account.
        const allModels = [
          ...models.map((model) => ({ ...model, provider: status?.provider?.id })),
          ...(Array.isArray(status?.chatgpt?.models) ? status.chatgpt.models : []).map((model) => ({
            ...model,
            provider: status.chatgpt.provider?.id,
          })),
        ]
        const chatgptTokenConfigured = status?.chatgpt?.token?.configured === true
        const chatgptCookieConfigured = status?.chatgpt?.cookies?.configured === true
        // Over CDP the browser tab holds the session; over headless the managed
        // profile does. Neither needs a pasted token.
        const chatgptViaCdp = status?.chatgpt?.transport === 'cdp'
        const chatgptViaHeadless = status?.chatgpt?.transport === 'headless'
        const chatgptBrowserMode = chatgptViaCdp || chatgptViaHeadless
        const chatgptCdpReady = status?.chatgpt?.cdp?.reachable === true
        const chatgptHeadlessReady = status?.chatgpt?.headless?.running === true
        const chatgptProfileReady = chatgptViaCdp
          ? chatgptCdpReady
          : chatgptViaHeadless
            ? chatgptHeadlessReady && (chatgptTokenConfigured || chatgptCookieConfigured)
            : chatgptTokenConfigured
        const canSaveChatgpt = Boolean(chatgptToken.trim() || chatgptCookies.trim())
        const canTestChatgpt =
          chatgptBrowserMode || chatgptTokenConfigured || Boolean(chatgptToken.trim()) || chatgptCookieConfigured
        const chatgptReady = chatgptProfileReady
        const fp = fpDraft ?? status?.fingerprint ?? null
        const fpEditable = status?.fingerprint?.persistable === true
        const canSave = Boolean(token.trim() || cookies.trim())
        const canTest = deepseekViaHeadless
          ? tokenConfigured || Boolean(token.trim())
          : deepseekBrowserMode || tokenConfigured || Boolean(token.trim())
        const retry = () => {
          setMessage(null)
          load()
        }

        const sourceText = (info) => {
          if (!info?.configured) return ''
          if (info.source === 'environment') return t('source.environment')
          if (info.source) return t('source.managed')
          return ''
        }

        const formatTime = (ms) => {
          if (!Number.isFinite(ms)) return ''
          try {
            return new Date(ms).toLocaleString()
          } catch {
            return ''
          }
        }

        return h(
          'section',
          { className: 'dsh-mm-section', 'aria-label': t('title') },
          h('style', null, CSS),
          h('h2', { className: 'dsh-mm-title' }, t('title')),
          h('p', { className: 'dsh-mm-intro' }, t('intro')),
          message
            ? h(
                'div',
                { className: 'dsh-mm-messageLine' },
                h(
                  'p',
                  {
                    className: message.kind === 'ok' ? 'dsh-mm-savedNotice' : 'dsh-mm-error',
                    role: message.kind === 'ok' ? 'status' : 'alert',
                    'aria-live': 'polite',
                  },
                  message.text,
                ),
                message.kind === 'error' && status === null
                  ? h('button', { className: 'dsh-mm-link', type: 'button', onClick: retry }, t('action.retry'))
                  : null,
              )
            : null,
          status === null && !message ? h('p', { className: 'dsh-mm-hint' }, t('loading')) : null,
          status === null
            ? null
            : h(
                'ul',
                { className: 'dsh-mm-rows' },
            h(
              'li',
              { className: 'dsh-mm-card' },
              h(
                'div',
                { className: 'dsh-mm-rowHead' },
                h('span', {
                  className: `dsh-mm-dot ${deepseekReady ? 'on' : 'off'}`,
                  'aria-hidden': true,
                }),
                h('span', { className: 'dsh-mm-name' }, t('account.title')),
                h('span', { className: 'dsh-mm-rowMeta' }, active ? t('status.active') : t('status.inactive')),
              ),
              h(
                'p',
                { className: 'dsh-mm-rowDesc' },
                deepseekViaHeadless
                  ? `${
                      deepseekHeadlessReady
                        ? t('deepseekTransport.headlessReady')
                        : t('deepseekTransport.headlessMissing')
                    } · ${t('deepseekTransport.headlessHint')}`
                  : deepseekViaCdp
                    ? `${
                        deepseekCdpReady ? t('deepseekTransport.cdpReady') : t('deepseekTransport.cdpMissing')
                      } · ${t('deepseekTransport.descCdp')}`
                    : `${tokenConfigured ? t('status.configured') : t('status.missing')}${
                        tokenConfigured && sourceText(status?.token) ? ` · ${sourceText(status?.token)}` : ''
                      } · ${t('account.desc')}`,
              ),
              status?.lastFailure
                ? h(
                    'p',
                    { className: 'dsh-mm-lastFailure' },
                    `${t('lastFailure.label')}：${status.lastFailure.code} · ${status.lastFailure.message}${
                      formatTime(status.lastFailure.at) ? `（${formatTime(status.lastFailure.at)}）` : ''
                    } — ${t('lastFailure.hint')}`,
                  )
                : null,
              h(
                'div',
                { className: 'dsh-mm-editor' },
                h(
                  'label',
                  { className: 'dsh-mm-field', htmlFor: 'dsh-mm-token' },
                  h('span', { className: 'dsh-mm-fieldLabel' }, t('token.label')),
                  h('input', {
                    id: 'dsh-mm-token',
                    className: 'dsh-mm-input',
                    type: 'password',
                    autoComplete: 'off',
                    spellCheck: false,
                    value: token,
                    placeholder: tokenConfigured ? t('token.placeholder.saved') : t('token.placeholder.empty'),
                    onChange: (event) => setToken(event.target.value),
                  }),
                ),
                h(
                  'div',
                  { className: 'dsh-mm-field' },
                  h(
                    'div',
                    { className: 'dsh-mm-fieldHead' },
                    h('label', { className: 'dsh-mm-fieldLabel', htmlFor: 'dsh-mm-cookie' }, t('cookie.label')),
                    cookieConfigured ? h('span', { className: 'dsh-mm-tag' }, t('status.configured')) : null,
                    h('span', { className: 'dsh-mm-spacer' }),
                    cookieConfigured
                      ? h(
                          'button',
                          {
                            className: 'dsh-mm-link',
                            type: 'button',
                            disabled: Boolean(busy),
                            onClick: clearCookie,
                          },
                          t('cookie.clear'),
                        )
                      : null,
                  ),
                  h('textarea', {
                    id: 'dsh-mm-cookie',
                    className: 'dsh-mm-textarea',
                    value: cookies,
                    placeholder: t('cookie.placeholder'),
                    onChange: (event) => setCookies(event.target.value),
                  }),
                ),
                h(
                  'div',
                  { className: 'dsh-mm-actions even' },
                  h(
                    'button',
                    {
                      className: 'dsh-mm-button primary',
                      type: 'button',
                      disabled: Boolean(busy) || !canSave,
                      onClick: save,
                    },
                    busy === 'save' ? t('action.saving') : t('action.save'),
                  ),
                  h(
                    'button',
                    { className: 'dsh-mm-button', type: 'button', disabled: Boolean(busy) || !canTest, onClick: test },
                    busy === 'test' ? t('action.testing') : t('action.test'),
                  ),
                  h(
                    'button',
                    {
                      className: 'dsh-mm-button danger',
                      type: 'button',
                      disabled: Boolean(busy) || (!tokenConfigured && !cookieConfigured),
                      onClick: clear,
                    },
                    busy === 'clear' ? t('action.clearing') : t('action.clear'),
                  ),
                ),
                h(
                  'div',
                  { className: 'dsh-mm-field' },
                  h(
                    'div',
                    { className: 'dsh-mm-fieldHead' },
                    h('span', { className: 'dsh-mm-fieldLabel' }, t('transport.label')),
                  ),
                  h(
                    'p',
                    { className: 'dsh-mm-hint' },
                    deepseekViaHeadless ? t('deepseekTransport.headlessDesc') : t('deepseekTransport.desc'),
                  ),
                  h(
                    'p',
                    { className: 'dsh-mm-hint' },
                    deepseekViaHeadless ? t('deepseekTransport.headlessHint') : t('deepseekTransport.fallback'),
                  ),
                  h(
                    'div',
                    { className: 'dsh-mm-actions even' },
                    h(
                      'button',
                      {
                        className: 'dsh-mm-button',
                        type: 'button',
                        disabled: Boolean(busy),
                        onClick: launchDeepseekChrome,
                      },
                      busy === 'deepseekLaunchChrome' ? t('deepseekLaunch.starting') : t('deepseekLaunch.action'),
                    ),
                    h(
                      'button',
                      {
                        className: 'dsh-mm-button',
                        type: 'button',
                        disabled: Boolean(busy),
                        onClick: startDeepseekHeadless,
                      },
                      busy === 'deepseekHeadless'
                        ? t('deepseekLaunch.headlessStarting')
                        : t('deepseekLaunch.headlessAction'),
                    ),
                  ),
                  h(
                    'div',
                    {
                      className: 'dsh-mm-segmented',
                      role: 'group',
                      'aria-label': t('transport.label'),
                    },
                    h(
                      'button',
                      {
                        className: 'dsh-mm-segment',
                        type: 'button',
                        'aria-pressed': !deepseekViaCdp && !deepseekViaHeadless,
                        disabled: Boolean(busy) || (!deepseekViaCdp && !deepseekViaHeadless),
                        onClick: () => setDeepseekTransport('node'),
                      },
                      t('transport.node'),
                    ),
                    h(
                      'button',
                      {
                        className: 'dsh-mm-segment',
                        type: 'button',
                        'aria-pressed': deepseekViaCdp,
                        disabled: Boolean(busy) || deepseekViaCdp,
                        onClick: () => setDeepseekTransport('cdp'),
                      },
                      t('transport.cdp'),
                    ),
                    h(
                      'button',
                      {
                        className: 'dsh-mm-segment',
                        type: 'button',
                        'aria-pressed': deepseekViaHeadless,
                        disabled: Boolean(busy) || deepseekViaHeadless,
                        onClick: () => setDeepseekTransport('headless'),
                      },
                      t('transport.headless'),
                    ),
                  ),
                  deepseekViaHeadless
                    ? status.headless
                      ? h(
                          'p',
                          { className: 'dsh-mm-hint' },
                          status.headless.running
                            ? `${t('deepseekTransport.headlessReady')} · pid ${status.headless.pid ?? '?'} · ${status.headless.host}:${status.headless.port}`
                            : `${t('deepseekTransport.headlessMissing')} · ${status.headless.host}:${status.headless.port}`,
                        )
                      : null
                    : status.cdp
                      ? h(
                          'p',
                          { className: 'dsh-mm-hint' },
                          status.cdp.reachable
                            ? `${t('transport.reachable')} · ${status.cdp.browser ?? 'Chromium'} · ${status.cdp.host}:${status.cdp.port}`
                            : `${t('transport.unreachable')} (${status.cdp.host}:${status.cdp.port})`,
                        )
                      : null,
                  deepseekViaHeadless
                    ? null
                    : h(
                        'details',
                        { className: 'dsh-mm-details' },
                        h('summary', { className: 'dsh-mm-summary' }, t('transport.howto')),
                        h(
                          'ol',
                          { className: 'dsh-mm-steps' },
                          h('li', null, t('transport.step1')),
                          h(
                            'li',
                            null,
                            t('transport.step2'),
                            h(
                              'code',
                              { className: 'dsh-mm-code' },
                          'chrome.exe --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\\dsh-chrome"',
                        ),
                      ),
                      h('li', null, t('deepseekTransport.step3')),
                    ),
                  ),
                ),
              ),
              h(
                'details',
                { className: 'dsh-mm-details' },
                h('summary', { className: 'dsh-mm-summary' }, t('help.summary')),
                h(
                  'ol',
                  { className: 'dsh-mm-steps' },
                  h('li', null, t('help.step1')),
                  h('li', null, t('help.step2')),
                  h('li', null, t('help.step3')),
                  h('li', null, t('help.step4')),
                ),
              ),
            ),
            status.chatgpt
              ? h(
                  'li',
                  { className: 'dsh-mm-card' },
                  h(
                    'div',
                    { className: 'dsh-mm-rowHead' },
                    h('span', {
                      className: `dsh-mm-dot ${chatgptReady ? 'on' : 'off'}`,
                      'aria-hidden': true,
                    }),
                    h('span', { className: 'dsh-mm-name' }, t('chatgpt.title')),
                    h(
                      'span',
                      { className: 'dsh-mm-rowMeta' },
                      status.chatgpt.provider?.active ? t('status.active') : t('status.inactive'),
                    ),
                  ),
                  h(
                    'p',
                    { className: 'dsh-mm-rowDesc' },
                    chatgptViaHeadless
                      ? `${chatgptHeadlessReady ? t('chatgpt.headlessReady') : t('chatgpt.headlessMissing')} · ${t('chatgpt.headlessDesc')}`
                      : chatgptViaCdp
                        ? `${chatgptCdpReady ? t('chatgpt.cdpReady') : t('chatgpt.cdpMissing')} · ${t('chatgpt.descCdp')}`
                        : `${chatgptTokenConfigured ? t('status.configured') : t('status.missing')}${
                            chatgptTokenConfigured && sourceText(status.chatgpt.token)
                              ? ` · ${sourceText(status.chatgpt.token)}`
                              : ''
                          } · ${t('chatgpt.desc')}`,
                  ),
                  status.chatgpt.lastFailure
                    ? h(
                        'p',
                        { className: 'dsh-mm-lastFailure' },
                        `${t('lastFailure.label')}：${status.chatgpt.lastFailure.code} · ${status.chatgpt.lastFailure.message}${
                          formatTime(status.chatgpt.lastFailure.at) ? `（${formatTime(status.chatgpt.lastFailure.at)}）` : ''
                        } — ${t('lastFailure.hint')}`,
                      )
                    : null,
                  h(
                    'div',
                    { className: 'dsh-mm-editor' },
                    h(
                      'label',
                      { className: 'dsh-mm-field', htmlFor: 'dsh-mm-chatgpt-token' },
                      h('span', { className: 'dsh-mm-fieldLabel' }, t('chatgpt.paste')),
                      h('input', {
                        id: 'dsh-mm-chatgpt-token',
                        className: 'dsh-mm-input',
                        type: 'password',
                        autoComplete: 'off',
                        spellCheck: false,
                        value: chatgptToken,
                        placeholder: status.chatgpt.token?.configured
                          ? t('token.placeholder.saved')
                          : t('token.placeholder.empty'),
                        onChange: (event) => setChatgptToken(event.target.value),
                      }),
                    ),
                    h(
                      'div',
                      { className: 'dsh-mm-field' },
                      h(
                        'div',
                        { className: 'dsh-mm-fieldHead' },
                        h('label', { className: 'dsh-mm-fieldLabel', htmlFor: 'dsh-mm-chatgpt-cookie' }, t('cookie.label')),
                        status.chatgpt.cookies?.configured ? h('span', { className: 'dsh-mm-tag' }, t('status.configured')) : null,
                        h('span', { className: 'dsh-mm-spacer' }),
                        status.chatgpt.cookies?.configured
                          ? h(
                              'button',
                              {
                                className: 'dsh-mm-link',
                                type: 'button',
                                disabled: Boolean(busy),
                                onClick: clearChatgptCookie,
                              },
                              t('cookie.clear'),
                            )
                          : null,
                      ),
                      h('textarea', {
                        id: 'dsh-mm-chatgpt-cookie',
                        className: 'dsh-mm-textarea',
                        value: chatgptCookies,
                        placeholder: t('chatgpt.cookie.placeholder'),
                        onChange: (event) => setChatgptCookies(event.target.value),
                      }),
                    ),
                    h(
                      'div',
                      { className: 'dsh-mm-actions even' },
                      h(
                        'button',
                        {
                          className: 'dsh-mm-button primary',
                          type: 'button',
                          disabled: Boolean(busy) || !canSaveChatgpt,
                          onClick: saveChatgpt,
                        },
                        busy === 'chatgptSave' ? t('action.saving') : t('action.save'),
                      ),
                      h(
                        'button',
                        {
                          className: 'dsh-mm-button',
                          type: 'button',
                          disabled: Boolean(busy) || !canTestChatgpt,
                          onClick: testChatgpt,
                        },
                        busy === 'chatgptTest' ? t('action.testing') : t('action.test'),
                      ),
                      h(
                        'button',
                        {
                          className: 'dsh-mm-button danger',
                          type: 'button',
                          disabled:
                            Boolean(busy) ||
                            (!status.chatgpt.token?.configured && !status.chatgpt.cookies?.configured),
                          onClick: clearChatgpt,
                        },
                        busy === 'chatgptClear' ? t('action.clearing') : t('action.clear'),
                      ),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'dsh-mm-field' },
                    h(
                      'div',
                      { className: 'dsh-mm-fieldHead' },
                      h('span', { className: 'dsh-mm-fieldLabel' }, t('transport.label')),
                    ),
                    h(
                      'p',
                      { className: 'dsh-mm-hint' },
                      chatgptViaHeadless ? t('chatgpt.headlessDesc') : t('transport.desc'),
                    ),
                    h(
                      'p',
                      { className: 'dsh-mm-hint' },
                      chatgptViaHeadless ? t('chatgpt.headlessHint') : t('launch.hint'),
                    ),
                    h(
                      'div',
                      { className: 'dsh-mm-actions even' },
                      h(
                        'button',
                        {
                          className: 'dsh-mm-button',
                          type: 'button',
                          disabled: Boolean(busy),
                          onClick: launchChrome,
                        },
                        busy === 'launchChrome' ? t('launch.starting') : t('launch.action'),
                      ),
                      h(
                        'button',
                        {
                          className: 'dsh-mm-button',
                          type: 'button',
                          disabled: Boolean(busy),
                          onClick: startChatgptHeadless,
                        },
                        busy === 'chatgptHeadless'
                          ? t('deepseekLaunch.headlessStarting')
                          : t('deepseekLaunch.headlessAction'),
                      ),
                    ),
                    h(
                      'div',
                      {
                        className: 'dsh-mm-segmented',
                        role: 'group',
                        'aria-label': t('transport.label'),
                      },
                      h(
                        'button',
                        {
                          className: 'dsh-mm-segment',
                          type: 'button',
                          'aria-pressed': !chatgptBrowserMode,
                          disabled: Boolean(busy) || !chatgptBrowserMode,
                          onClick: () => setTransport('node'),
                        },
                        t('transport.node'),
                      ),
                      h(
                        'button',
                        {
                          className: 'dsh-mm-segment',
                          type: 'button',
                          'aria-pressed': chatgptViaCdp,
                          disabled: Boolean(busy) || chatgptViaCdp,
                          onClick: () => setTransport('cdp'),
                        },
                        t('transport.cdp'),
                      ),
                      h(
                        'button',
                        {
                          className: 'dsh-mm-segment',
                          type: 'button',
                          'aria-pressed': chatgptViaHeadless,
                          disabled: Boolean(busy) || chatgptViaHeadless,
                          onClick: () => setTransport('headless'),
                        },
                        t('transport.headless'),
                      ),
                    ),
                    chatgptViaHeadless && status.chatgpt.headless
                      ? h(
                          'p',
                          { className: 'dsh-mm-hint' },
                          `${chatgptHeadlessReady ? t('chatgpt.headlessReady') : t('chatgpt.headlessMissing')} · ` +
                            `pid ${status.chatgpt.headless.pid ?? '?'} · ${status.chatgpt.headless.host}:${status.chatgpt.headless.port}`,
                        )
                      : status.chatgpt.cdp && (chatgptViaCdp || chatgptCdpReady)
                        ? h(
                            'p',
                            { className: 'dsh-mm-hint' },
                            status.chatgpt.cdp.reachable
                              ? `${t('transport.reachable')} · ${status.chatgpt.cdp.browser ?? 'Chromium'} · ${status.chatgpt.cdp.host}:${status.chatgpt.cdp.port}`
                              : `${t('transport.unreachable')} (${status.chatgpt.cdp.host}:${status.chatgpt.cdp.port})`,
                          )
                        : null,
                    h(
                      'details',
                      { className: 'dsh-mm-details' },
                      h('summary', { className: 'dsh-mm-summary' }, t('transport.howto')),
                      h(
                        'ol',
                        { className: 'dsh-mm-steps' },
                        h('li', null, t('transport.step1')),
                        h(
                          'li',
                          null,
                          t('transport.step2'),
                          h(
                            'code',
                            { className: 'dsh-mm-code' },
                            'chrome.exe --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\\dsh-chrome"',
                          ),
                        ),
                        h('li', null, t('transport.step3')),
                      ),
                    ),
                  ),
                  h(
                    'details',
                    { className: 'dsh-mm-details' },
                    h('summary', { className: 'dsh-mm-summary' }, t('chatgpt.help.summary')),
                    h(
                      'ol',
                      { className: 'dsh-mm-steps' },
                      h('li', null, t('chatgpt.help.step1')),
                      h('li', null, t('chatgpt.help.step2')),
                      h('li', null, t('chatgpt.help.step3')),
                      h('li', null, t('chatgpt.help.step4')),
                    ),
                  ),
                )
              : null,
            h(
              'li',
              { className: 'dsh-mm-card' },
              h(
                'div',
                { className: 'dsh-mm-rowHead' },
                h('span', { className: 'dsh-mm-name' }, t('models.title')),
                h('span', { className: 'dsh-mm-tag' }, String(allModels.length)),
              ),
              h('p', { className: 'dsh-mm-rowDesc' }, t('models.note')),
              allModels.length > 0
                ? h(
                    'ul',
                    { className: 'dsh-mm-modelList' },
                    allModels.map((model) =>
                      h(
                        'li',
                        { className: 'dsh-mm-modelRow', key: `${model.provider}:${model.id}` },
                        h('span', {
                          className: `dsh-mm-dot ${model.routable ? 'on' : 'off'}`,
                          'aria-hidden': true,
                        }),
                        h(
                          'div',
                          { style: { minWidth: 0 } },
                          h('div', { className: 'dsh-mm-modelName' }, model.name),
                          h('div', { className: 'dsh-mm-modelDesc' }, model.description),
                          !model.routable ? h('div', { className: 'dsh-mm-modelDesc' }, t('models.unavailable')) : null,
                          status?.defaultSelection?.provider === model.provider &&
                          status?.defaultSelection?.model === model.id
                            ? h('div', { className: 'dsh-mm-modelDesc' }, t('models.currentDefault'))
                            : h(
                                'button',
                                {
                                  className: 'dsh-mm-link',
                                  type: 'button',
                                  disabled: Boolean(busy) || !model.routable,
                                  onClick: () => setDefault(model.id),
                                },
                                t('models.setDefault'),
                              ),
                        ),
                      ),
                    ),
                  )
                : h('p', { className: 'dsh-mm-hint' }, t('models.empty')),
            ),
            status?.fingerprint
              ? h(
                  'li',
                  { className: 'dsh-mm-card' },
                  h(
                    'div',
                    { className: 'dsh-mm-rowHead' },
                    h('span', { className: 'dsh-mm-name' }, t('fingerprint.title')),
                    h(
                      'span',
                      { className: 'dsh-mm-tag' },
                      status.fingerprint.overridden ? t('fingerprint.overridden') : t('fingerprint.defaultTag'),
                    ),
                  ),
                  h('p', { className: 'dsh-mm-rowDesc' }, t('fingerprint.desc')),
                  h(
                    'div',
                    { className: 'dsh-mm-editor' },
                    FINGERPRINT_FIELDS.map((field) =>
                      h(
                        'label',
                        { className: 'dsh-mm-field', htmlFor: `dsh-mm-fp-${field.key}`, key: field.key },
                        h('span', { className: 'dsh-mm-fieldLabel' }, t(field.label)),
                        h('input', {
                          id: `dsh-mm-fp-${field.key}`,
                          className: 'dsh-mm-input',
                          type: 'text',
                          autoComplete: 'off',
                          spellCheck: false,
                          value: fp?.[field.key] ?? '',
                          onChange: (event) =>
                            setFpDraft({ ...(fp ?? status.fingerprint), [field.key]: event.target.value }),
                        }),
                      ),
                    ),
                    h(
                      'div',
                      { className: 'dsh-mm-actions even' },
                      h(
                        'button',
                        {
                          className: 'dsh-mm-button primary',
                          type: 'button',
                          disabled: Boolean(busy) || !fpEditable,
                          onClick: saveFingerprint,
                        },
                        busy === 'fingerprint' ? t('action.saving') : t('fingerprint.save'),
                      ),
                      h(
                        'button',
                        {
                          className: 'dsh-mm-button',
                          type: 'button',
                          disabled: Boolean(busy) || !fpEditable,
                          onClick: resetFingerprint,
                        },
                        t('fingerprint.reset'),
                      ),
                    ),
                    !fpEditable ? h('p', { className: 'dsh-mm-hint' }, t('fingerprint.unavailable')) : null,
                  ),
                )
              : null,
          ),
          h('p', { className: 'dsh-mm-notice' }, t('notice')),
        )
      }
    }

    return {
      name: 'my-model',
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register('my-model', { zh: ZH, 'zh-CN': ZH, en: EN }))
        } catch {
          // A second instance or a hot-reload race must not blank the page.
        }
        const bound = ctx.locale.bind('my-model')
        let activeLocale = 'en'
        try {
          activeLocale = ctx.locale.getLocale().active ?? ctx.locale.getLocale().id ?? 'en'
        } catch {
          activeLocale = 'en'
        }
        const fallback = String(activeLocale).toLowerCase().startsWith('zh') ? ZH : EN
        const t = (key) => {
          const value = bound(key)
          return value === key ? fallback[key] ?? key : value
        }
        const Section = createSection(t)
        if (typeof document !== 'undefined') {
          ctx.effect(() => {
            const style = document.createElement('style')
            style.setAttribute('data-dsh-my-model', 'nav-icon')
            style.textContent = NAV_CSS
            document.head.appendChild(style)
            return () => style.remove()
          })
        }
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'my-model',
              order: 12,
              label: () => renderSectionLabel(t),
            },
            Section,
          ),
        )
      },
    }
  },
})
