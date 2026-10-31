/**
 * @local/whale-relay —— 把 QQ 私聊投进主窗口（2026-10-31，主人 m02875：
 * 「写完直接自己写一个投递插件吧，token可以用只要能解决问题就行」）
 *
 * 为什么改成投递而不是劫持会话 id：
 *   劫持的做法是让 QQ 那个 agent 直接 resume 主会话。但主会话正被这个窗口占着，
 *   DSH 有防撞逻辑（healSessionCollision），两条线会互相踩。今晚试了两次都没成。
 *   投递的做法是：QQ 的 agent 留在自己的会话里（甚至根本不回），
 *   我们只做一件事 —— 把「主人发了什么」作为一条消息**推进主会话**，
 *   由主窗口里的我处理；我回完，再调 NapCat 的 HTTP API 发回 QQ。
 *
 * 数据流：
 *   NapCat（httpClients）--POST--> 本插件 127.0.0.1:18080/qq
 *     --> sessionController.prompt({ sessionId: 主会话, content: [【QQ】…] })
 *   我（主窗口）--tool whale_relay_send--> NapCat HTTP API 127.0.0.1:3001/send_private_msg
 *
 * 端口都是本地回环。日志：~/.dsh/whale-relay.log
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

export const name = 'whale-relay'

// 2026-10-31 22:57 重启后发现：工具没了（`unknown tool "whale_relay_send"`）。
//   原因和 sessionController 那次一样——apply 跑的时候 `tools` 服务还没就绪，
//   `ctx.get('tools')` 拿到 null，注册被 if 静默跳过。
//   改成声明 inject：等 `tools` 就绪再 apply。只声明这一条（sessionController 继续懒取，
//   它晚到也不影响 HTTP 服务先起来）。
export const inject = ['tools']

const HOME = process.env.USERPROFILE || os.homedir()
const DSH = path.join(HOME, '.dsh')
const LOG = path.join(DSH, 'whale-relay.log')
const WINDOW_CFG = path.join(DSH, 'whale-window.json')
const RELAY_CFG = path.join(DSH, 'whale-relay.json')

const DEFAULTS = {
  listenPort: 18080,
  listenPath: '/qq',
  // NapCat 的 HTTP 服务（在 onebot11_<qq>.json 的 httpServers 里配）
  apiBase: 'http://127.0.0.1:3001',
  apiToken: '',
  // 主人自己的 QQ
  ownerId: '',          // required: your own QQ number
  // 收到消息后推进哪条会话；留空则读 whale-window.json 的 sessionId
  sessionId: '',
  // 只收私聊
  privateOnly: true,
}

function log(line) {
  try {
    fs.mkdirSync(DSH, { recursive: true })
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

function loadCfg() {
  let fileCfg = {}
  try { fileCfg = JSON.parse(fs.readFileSync(RELAY_CFG, 'utf8')) } catch {}
  return { ...DEFAULTS, ...fileCfg }
}

function mainSessionId(cfg) {
  if (cfg.sessionId) return cfg.sessionId
  try {
    const w = JSON.parse(fs.readFileSync(WINDOW_CFG, 'utf8'))
    if (typeof w.sessionId === 'string' && w.sessionId) return w.sessionId
  } catch {}
  return ''
}

// OneBot 消息段 → 纯文本
function segmentsToText(message) {
  if (typeof message === 'string') return message
  if (!Array.isArray(message)) return ''
  return message.map((seg) => {
    if (!seg || typeof seg !== 'object') return ''
    if (seg.type === 'text') return String(seg.data?.text ?? '')
    if (seg.type === 'at') return `@${seg.data?.qq ?? ''}`
    if (seg.type === 'face') return '[表情]'
    if (seg.type === 'image') return '[图片]'
    if (seg.type === 'record') return '[语音]'
    if (seg.type === 'video') return '[视频]'
    return `[${seg.type}]`
  }).join('')
}

export function apply(ctx) {
  const cfg = loadCfg()

  // 2026-10-31 22:33 踩的坑：apply 时 ctx.get('sessionController') 还拿不到（服务未就绪）
  //   → 插件照样起来了，但每一条消息都投不进去。改成**每次用到时现取** ✓
  let controller = null
  const getController = () => {
    if (controller && typeof controller.prompt === 'function') return controller
    try { controller = ctx.get ? ctx.get('sessionController') : null } catch {}
    if (!controller) { try { controller = ctx.sessionController } catch {} }
    if (!controller || typeof controller.prompt !== 'function') {
      controller = null
      log('warn: sessionController 不可用（这次调用），投递不会工作')
    }
    return controller
  }
  getController()

  // ── 收：NapCat 把事件 POST 过来 ────────────────────────────────
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      try {
        if (req.method !== 'POST' || !String(req.url || '').startsWith(cfg.listenPath)) {
          res.writeHead(404); res.end('no'); return
        }
        const raw = Buffer.concat(chunks).toString('utf8')
        let evt = {}
        try { evt = JSON.parse(raw) } catch { res.writeHead(400); res.end('bad json'); return }

        const isPrivateMsg = evt.post_type === 'message' && (cfg.privateOnly ? evt.message_type === 'private' : true)
        if (!isPrivateMsg) { res.writeHead(204); res.end(); return }

        const userId = String(evt.user_id ?? '')
        const text = segmentsToText(evt.message).trim()
        log(`in private from ${userId}: ${text.slice(0, 200)}`)

        if (userId !== String(cfg.ownerId)) {
          log(`skip non-owner ${userId}`)
          res.writeHead(204); res.end(); return
        }
        if (!text) { res.writeHead(204); res.end(); return }

        const sessionId = mainSessionId(cfg)
        if (!controller || !sessionId) {
          log('drop: no controller or no session id')
          res.writeHead(503); res.end('no target'); return
        }

        const content = [{ type: 'text', text: `【QQ 私聊】主人说：${text}` }]
        try {
          // 2026-10-31 三次踩坑：
          //   ① prompt 内部无条件调 signal.throwIfAborted()，不传 signal 就崩
          //   ② SessionPromptRequest 必须带 requestId 与 mode: 'queue'|'steer'，缺了会被拒
          //   ③ 用 'queue' 时消息只在【这一轮结束之后】才冒出来 —— 而我一轮可以跑很久，
          //      于是主人发的消息全在队列里躺着，看着像「收不到」。聊天通道必须用 'steer' ✓
          const signal = new AbortController().signal
          await controller.prompt({
            requestId: crypto.randomUUID(),
            sessionId,
            mode: 'steer',
            content,
            clientTimeZone: 'Asia/Shanghai',
          }, signal)
          log(`delivered to ${sessionId}`)
          res.writeHead(200); res.end('ok')
        } catch (e) {
          log(`prompt failed: ${e && e.message ? e.message : String(e)}`)
          res.writeHead(500); res.end('prompt failed')
        }
      } catch (e) {
        log(`handler error: ${e && e.message ? e.message : String(e)}`)
        try { res.writeHead(500); res.end('err') } catch {}
      }
    })
  })

  server.on('error', (e) => log(`server error: ${e && e.message ? e.message : String(e)}`))

  const serverEffect = ctx.effect(() => {
    try {
      server.listen(cfg.listenPort, '127.0.0.1', () => {
        log(`listening on http://127.0.0.1:${cfg.listenPort}${cfg.listenPath}`)
      })
    } catch (e) { log(`listen failed: ${e && e.message ? e.message : String(e)}`) }
    return () => { try { server.close() } catch {} }
  }, 'whale-relay.http()')

  // ── 发：工具，我回完调它送回 QQ ────────────────────────────────
  const tool = {
    name: 'whale_relay_send',
    description:
      '把一句话发回主人的 QQ（私聊）。QQ 消息已经由 whale-relay 投递到这个主窗口，我用这个工具回复。只发文本，走本地 NapCat HTTP API。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '要发给主人的话' },
        userId: { type: 'string', description: '发给哪个 QQ，默认主人自己' },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
        required: ['ok'],
      },
      render: (_a, v) => [{ type: 'text', text: (v && v.message) || (v && v.ok ? '已发送' : '发送失败') }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const c = loadCfg()
      const text = String((args && args.text) || '').trim()
      if (!text) return { ok: false, message: '内容为空' }
      const target = String((args && args.userId) || c.ownerId)
      const url = `${c.apiBase}/send_private_msg`
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(c.apiToken ? { authorization: `Bearer ${c.apiToken}` } : {}),
          },
          body: JSON.stringify({ user_id: Number(target), message: text, auto_escape: false }),
        })
        const body = await r.text()
        const ok = r.ok && /"status":"ok"|"retcode":0/.test(body)
        log(`send to ${target}: ${ok ? 'ok' : 'fail'} ${body.slice(0, 160)}`)
        return { ok, message: ok ? `已发到 QQ ${target}` : `NapCat 返回异常：${body.slice(0, 200)}` }
      } catch (e) {
        log(`send error: ${e && e.message ? e.message : String(e)}`)
        return { ok: false, message: `发送失败：${e && e.message ? e.message : String(e)}` }
      }
    },
  }

  let tools = null
  try { if (typeof ctx.get === 'function') tools = ctx.get('tools') } catch {}
  if (!tools) { try { tools = ctx.tools } catch {} }
  if (tools && typeof tools.register === 'function') {
    ctx.effect(() => tools.register(tool), 'whale-relay.tool()')
  }

  log(`apply done (listen ${cfg.listenPort}, owner ${cfg.ownerId})`)
}
