window.__ModuleLoader__.load({
  id: '@local/dsh-my-model',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ZH = {
      'section.label': '我的模型',
      title: '我的模型',
      intro: '使用你自己的 DeepSeek 网页版账号，在 Harness 中调用 chat.deepseek.com 的免费网页模型。',
      'account.title': 'DeepSeek 网页版账号',
      'account.desc': '凭据保存在 Harness 本地凭据库，不会写入配置文件。',
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
      notice: '这不是 DeepSeek 官方 API。它使用网页版登录态和网页版配额，受 DeepSeek 服务条款约束；接口变化或风控可能导致失效。请勿分享 Token。',
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
      intro: 'Use your own DeepSeek web account to call the free chat.deepseek.com models from Harness.',
      'account.title': 'DeepSeek web account',
      'account.desc': 'Credentials are stored in the local Harness credential store, not in a config file.',
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
      notice: 'This is not the official DeepSeek API. It uses your web login and web quota, subject to DeepSeek’s terms; upstream changes or anti-bot checks can break it. Never share your token.',
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
    // 720px column, 16/24 section title, 12px-radius row cards, pill buttons,
    // 8px state dots, and the same alias tokens for light/dark themes.
    const CSS = `
.dsh-mm-section{max-width:720px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.dsh-mm-title{margin:0;font-size:16px;font-weight:500;line-height:24px}
.dsh-mm-intro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:22px}
.dsh-mm-rows{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.dsh-mm-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;display:flex;flex-direction:column;gap:12px;padding:12px 14px}
.dsh-mm-rowHead{display:flex;align-items:center;gap:10px;min-height:22px}
.dsh-mm-name{font-size:14px;font-weight:500;line-height:22px}
.dsh-mm-rowMeta{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-align:right}
.dsh-mm-tag{border:1px solid var(--dsw-alias-border-l3);border-radius:4px;color:var(--dsw-alias-label-secondary);flex:none;padding:1px 6px;font-size:11px;line-height:16px}
.dsh-mm-dot{background:var(--dsw-alias-label-dimmed);border-radius:50%;flex:none;width:8px;height:8px}
.dsh-mm-dot.on{background:var(--dsw-alias-state-success-primary)}
.dsh-mm-dot.off{background:var(--dsw-alias-state-error-primary)}
.dsh-mm-rowDesc{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsh-mm-editor{background:var(--dsw-alias-bg-module-platform);border-radius:12px;display:flex;flex-direction:column;gap:14px;padding:14px 16px}
.dsh-mm-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.dsh-mm-fieldHead{display:flex;align-items:center;gap:8px}
.dsh-mm-fieldLabel{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}
.dsh-mm-spacer{flex:1}
.dsh-mm-input{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-sizing:border-box;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;height:32px;line-height:22px;padding:0 10px;width:100%}
.dsh-mm-input::placeholder{color:var(--dsw-alias-label-dimmed)}
.dsh-mm-input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}
.dsh-mm-input:disabled{opacity:.6;cursor:default}
.dsh-mm-textarea{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-sizing:border-box;color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;min-height:64px;padding:6px 10px;resize:vertical;width:100%}
.dsh-mm-textarea::placeholder{color:var(--dsw-alias-label-dimmed)}
.dsh-mm-textarea:focus{border-color:var(--dsw-alias-brand-primary);outline:none}
.dsh-mm-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
/* One control system for every button on the page. The shared base fixes the
   box model, kills inherited transforms/filters/animation, and limits motion to
   colour only — so no state can ever resize or nudge a control. */
.dsh-mm-button,.dsh-mm-link{-webkit-appearance:none;appearance:none;box-sizing:border-box;margin:0;border:1px solid transparent;background-color:transparent;background-image:none;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap;text-align:center;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;transform:none;filter:none;animation:none;will-change:auto;transition:background-color .12s ease,border-color .12s ease,color .12s ease,opacity .12s ease}
.dsh-mm-button{height:36px;padding:0 16px;border-radius:18px;border-color:var(--dsw-alias-border-l2);gap:6px;font-size:14px;font-weight:500;line-height:20px}
.dsh-mm-button:hover:not(:disabled){background-color:var(--dsw-alias-interactive-bg-hover-solid)}
.dsh-mm-button:active:not(:disabled){background-color:var(--dsw-alias-interactive-bg-hover-solid)}
.dsh-mm-button.primary{background-color:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
.dsh-mm-button.primary:hover:not(:disabled),.dsh-mm-button.primary:active:not(:disabled){background-color:var(--dsw-alias-button-primary-hover)}
.dsh-mm-button.danger{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-state-error-primary)}
.dsh-mm-button.danger:hover:not(:disabled),.dsh-mm-button.danger:active:not(:disabled){background-color:var(--dsw-alias-interactive-bg-hover-danger)}
.dsh-mm-button:disabled{cursor:default;opacity:.4}
.dsh-mm-link{height:24px;padding:0 8px;border-radius:6px;gap:4px;color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:500;line-height:18px}
.dsh-mm-link:hover:not(:disabled){background-color:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsh-mm-link:disabled{cursor:default;opacity:.4}
.dsh-mm-button:focus-visible,.dsh-mm-link:focus-visible,.dsh-mm-summary:focus-visible{box-shadow:none;outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
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
.dsh-mm-section .dsh-mm-summary,
.dsh-mm-section .dsh-mm-summary:hover{transform:none;filter:none;animation:none;will-change:auto}
.dsh-mm-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsh-mm-details{border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px}
.dsh-mm-summary{align-items:center;border:1px solid transparent;border-radius:6px;color:var(--dsw-alias-label-secondary);cursor:pointer;display:flex;font-size:12px;font-weight:500;gap:6px;line-height:18px;list-style:none;margin-left:-6px;padding:2px 6px;width:fit-content;transform:none;filter:none;animation:none;transition:background-color .12s ease,color .12s ease}
.dsh-mm-summary::-webkit-details-marker{display:none}
.dsh-mm-summary::before{border-bottom:1.5px solid;border-right:1.5px solid;content:"";height:5px;transform:rotate(-45deg) translate(-1px,-1px);transition:transform .12s;width:5px}
.dsh-mm-details[open]>.dsh-mm-summary::before{transform:rotate(45deg) translate(-1px,-1px)}
.dsh-mm-summary:hover{background-color:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-mm-steps{color:var(--dsw-alias-label-tertiary);display:flex;flex-direction:column;font-size:12px;gap:4px;line-height:18px;margin:8px 0 0;padding-left:18px}
.dsh-mm-modelList{display:flex;flex-direction:column;gap:6px;list-style:none;margin:0;padding:0}
.dsh-mm-modelRow{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;display:grid;gap:10px;grid-template-columns:8px minmax(0,1fr);padding:8px 10px}
.dsh-mm-modelRow>.dsh-mm-dot{margin-top:7px}
.dsh-mm-modelName{font-size:13px;font-weight:500;line-height:20px}
.dsh-mm-modelDesc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsh-mm-savedNotice{color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px;margin:0}
.dsh-mm-lastFailure{color:var(--dsw-alias-state-warn-label);font-size:12px;line-height:18px;margin:0}
.dsh-mm-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin:0}
.dsh-mm-messageLine{align-items:center;display:flex;flex-wrap:wrap;gap:4px}
.dsh-mm-notice{color:var(--dsw-alias-state-warn-label);font-size:12px;line-height:18px;margin:0}
@media (max-width:560px){.dsh-mm-card{padding:12px}.dsh-mm-editor{padding:12px}.dsh-mm-rowMeta{display:none}}
@media (prefers-reduced-motion:reduce){.dsh-mm-summary::before{transition:none}}
`

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
        const models = Array.isArray(status?.models) ? status.models : []
        const fp = fpDraft ?? status?.fingerprint ?? null
        const fpEditable = status?.fingerprint?.persistable === true
        const canSave = Boolean(token.trim() || cookies.trim())
        const canTest = tokenConfigured || Boolean(token.trim())
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
                  className: `dsh-mm-dot ${tokenConfigured ? 'on' : 'off'}`,
                  'aria-hidden': true,
                }),
                h('span', { className: 'dsh-mm-name' }, t('account.title')),
                h('span', { className: 'dsh-mm-rowMeta' }, active ? t('status.active') : t('status.inactive')),
              ),
              h(
                'p',
                { className: 'dsh-mm-rowDesc' },
                `${tokenConfigured ? t('status.configured') : t('status.missing')}${
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
                  { className: 'dsh-mm-actions' },
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
            h(
              'li',
              { className: 'dsh-mm-card' },
              h(
                'div',
                { className: 'dsh-mm-rowHead' },
                h('span', { className: 'dsh-mm-name' }, t('models.title')),
                h('span', { className: 'dsh-mm-tag' }, String(models.length)),
              ),
              h('p', { className: 'dsh-mm-rowDesc' }, t('models.note')),
              models.length > 0
                ? h(
                    'ul',
                    { className: 'dsh-mm-modelList' },
                    models.map((model) =>
                      h(
                        'li',
                        { className: 'dsh-mm-modelRow', key: model.id },
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
                          status?.defaultSelection?.provider === status?.provider?.id &&
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
                      { className: 'dsh-mm-actions' },
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
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'my-model',
              order: 12,
              label: () => t('section.label'),
            },
            Section,
          ),
        )
      },
    }
  },
})
