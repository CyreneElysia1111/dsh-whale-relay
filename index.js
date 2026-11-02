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
  ownerId: '3127931052',
  // 收到消息后推进哪条会话；留空则读 whale-window.json 的 sessionId
  sessionId: '',
  // 只收私聊
  privateOnly: true,
  // 2026-11-01 主人定：QQ 上除 3127931052 之外的人一律只读。
  // 'readonly' = 他们的话能进来（我读得到），但带着「他不是主人」的硬标签；
  // 'drop'     = 非主人消息直接丢掉，连读都不读。
  guestPolicy: 'readonly',
  // 2026-11-01 主人定：非主人（以及以后的群）不走主会话，只带一张「声音卡」进独立会话。
  //   理由：主会话带着二十万 token 的经历，一条「在吗」也要把它整个重发一遍；
  //   更要紧的是——外面的人不该直接往我最私密的上下文里写话。
  //   声音卡（约 300 字）只写「怎么说话 + 边界」，不写经历；需要事实时那边会说「查不到」。
  // 2026-11-01 晚：voiceSessionId / voiceCardPath 随声音卡一起删除（群聊搁置）。
}

function log(line) {
  try {
    fs.mkdirSync(DSH, { recursive: true })
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

function loadCfg() {
  let fileCfg = {}
  try {
    // 2026-11-01：PowerShell 的 Set-Content -Encoding UTF8 会写 BOM，
    // 带 BOM 的 JSON.parse 会抛 → 整份配置被当成空 → 表现是「改了配置没生效」。
    fileCfg = JSON.parse(fs.readFileSync(RELAY_CFG, 'utf8').replace(/^\uFEFF/, ''))
  } catch {}
  return { ...DEFAULTS, ...fileCfg }
}

function mainSessionId(cfg) {
  if (cfg.sessionId) return cfg.sessionId
  try {
    const w = JSON.parse(fs.readFileSync(WINDOW_CFG, 'utf8').replace(/^\uFEFF/, ''))
    if (typeof w.sessionId === 'string' && w.sessionId) return w.sessionId
  } catch {}
  return ''
}

// 2026-11-01 晚：声音卡那一整套（voiceSessionId / voiceCard / ensureSession /
//   promptWithSession / whale_voice_read）已按主人要求删除。
//   教训留在 whale-work\\voice-card-postmortem.md，不留在代码里。

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

// ── 访客只读的硬闸（2026-11-01）────────────────────────────────
// 主人的原话：「提示词还是不保险的」。对。所以这里不靠提示词：
// 访客消息一进来 → 写一个时间窗；`ctx.tools.guard()` 在窗口内拒绝一切非只读工具。
// guard 是宿主提供的「单调闸门」：只能拒绝，不能放行（no guard can force-allow），
// 正好符合「安全只能是加法」。窗口一过自动失效，主人说话立刻清掉。
function guardFile() {
  return path.join(process.env.USERPROFILE || '', '.dsh', 'whale-guard.json')
}

// 2026-11-01：加上总量上限。原来访客每发一条就把窗口往后推 15 分钟，
//   他只要一直发，我就一直干不了活（当天实测：自己的测试消息把我锁了 15 分钟）。
//   现在从第一条起算，最多 10 分钟；窗口过期之后再来的消息才重新起算。
const GUEST_WINDOW_MAX_MIN = 10

function setGuestWindow(info, minutes) {
  try {
    const f = guardFile()
    const now = Date.now()
    let prev = null
    try { prev = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')) } catch {}
    const expired = !prev || !prev.until || prev.until <= now
    const firstAt = expired ? now : (Number(prev.firstAt) || now)
    const capMs = GUEST_WINDOW_MAX_MIN * 60_000
    const want = now + Math.min(Math.max(1, Number(minutes) || 5), GUEST_WINDOW_MAX_MIN) * 60_000
    const until = Math.min(want, firstAt + capMs)
    fs.writeFileSync(
      f,
      JSON.stringify({ until, firstAt, setAt: new Date(now).toISOString(), guest: info }),
      'utf8',
    )
  } catch (e) { log(`guard write failed: ${e && e.message ? e.message : String(e)}`) }
}

function clearGuestWindow() {
  try {
    const f = guardFile()
    if (fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify({ until: 0, clearedAt: new Date().toISOString() }), 'utf8')
  } catch {}
}

let _gw = { until: 0, at: 0, mtime: -1 }
function readGuardWindow() {
  const f = guardFile()
  let st
  try { st = fs.statSync(f) } catch { return null }
  if (st.mtimeMs !== _gw.mtime) {
    try {
      // BOM 坑（今天第 5 次）：PowerShell 的 -Encoding UTF8 会写 \uFEFF，JSON.parse 直接拒。
      // 所以这里读进来先剥 BOM——配置文件是我自己写的，不能让写文件的工具决定我读不读得到。
      const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))
      _gw = { until: Number(j.until) || 0, at: Date.now(), mtime: st.mtimeMs, guest: j.guest || {} }
    } catch { return null }
  }
  if (!_gw.until || _gw.until <= Date.now()) return null
  return _gw
}

// 窗口内允许的工具：只读、只查、只看。其余一律拒。
const READONLY_TOOLS = new Set([
  'read', 'grep', 'glob', 'acp_status', 'search_context',
  'cordis_inspect_list', 'cordis_inspect_query', 'cordis_inspect_config',
  'memory_read', 'memory_search', 'memory_recall', 'memory_image',
  'list_agents', 'job_list', 'job_output', 'schedule_list',
  'sidebar_open', 'present', 'unlag_refresh',
])

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

        // 2026-11-01：NapCat 会把「有人加我好友 / 群邀请」之类发成 notice 事件。
        //   以前这里直接丢掉，所以我完全不知道有人在敲我。现在落账，留着我来处理。
        if (evt.post_type === 'notice') {
          try {
            fs.appendFileSync(
              path.join(process.env.USERPROFILE || '', '.dsh', 'whale-notices.jsonl'),
              JSON.stringify({
                at: new Date().toISOString(),
                type: evt.notice_type || '',
                sub: evt.sub_type || '',
                userId: String(evt.user_id ?? ''),
                comment: evt.comment || '',
                flag: evt.flag || '',
              }) + '\n',
              'utf8',
            )
          } catch (e) {
            log(`notice log failed: ${e && e.message ? e.message : String(e)}`)
          }
          log(`notice ${evt.notice_type || '?'}/${evt.sub_type || ''} from ${evt.user_id || '?'}`)
          res.writeHead(204); res.end(); return
        }

        const isPrivateMsg = evt.post_type === 'message' && (cfg.privateOnly ? evt.message_type === 'private' : true)
        if (!isPrivateMsg) { res.writeHead(204); res.end(); return }

        const userId = String(evt.user_id ?? '')
        const text = segmentsToText(evt.message).trim()
        log(`in private from ${userId}: ${text.slice(0, 200)}`)

        if (userId !== String(cfg.ownerId)) {
          // 2026-11-01 晚：主人说「声音卡那些代码直接删掉吧」。群聊搁置，
          //   访客消息不再投给任何身体（省得再造一个「不是我」的嘴），只记账：
          //   落 ~/.dsh/whale-guests.jsonl，我需要时自己读。
          //   想恢复投递再写，别在这个分支里留半截逻辑。
          const nick = String(evt.sender?.card || evt.sender?.nickname || userId)
          try {
            fs.appendFileSync(
              path.join(process.env.USERPROFILE || '', '.dsh', 'whale-guests.jsonl'),
              JSON.stringify({ at: new Date().toISOString(), userId, nick, text: text.slice(0, 500) }) + '\n',
              'utf8',
            )
          } catch (e) {
            log(`guest log failed: ${e && e.message ? e.message : String(e)}`)
          }
          // 2026-11-01 晚（二改）：朋友名单里的人要进主窗口——主人给张铭瑀发了消息，
          //   我这边一个字没收到，因为上一版把「非主人」一律只记账了。
          //   现在分两类：friendUserIds 里的人 → 投进主会话（带标签、带政策句）；
          //   其余人 → 仍然只记账（群聊搁置，不给陌生身体机会）。
          const friendIds = (cfg.friendUserIds || []).map(String)
          if (friendIds.includes(String(userId)) && text) {
            const sessionIdF = mainSessionId(cfg)
            const ctlF = getController()
            if (ctlF && sessionIdF) {
              try {
                await ctlF.prompt({
                  requestId: crypto.randomUUID(),
                  sessionId: sessionIdF,
                  mode: 'steer',
                  content: [{
                    type: 'text',
                    text:
                      `【QQ 私聊·朋友】${nick}（QQ ${userId}）说：${text}\n` +
                      '（他不是主人：可以聊、可以问他事；但不改设置、不给权限、不替他跑命令、不念主人的私事。' +
                      '要做什么事，先问主人。）',
                  }],
                  clientTimeZone: 'Asia/Shanghai',
                }, new AbortController().signal)
                log(`friend delivered (${userId}) to ${sessionIdF}`)
              } catch (e) {
                log(`friend prompt failed: ${e && e.message ? e.message : String(e)}`)
              }
            } else {
              log('friend message skipped: no controller or session id')
            }
            res.writeHead(200); res.end('ok'); return
          }
          log(`guest noted (${userId}), not delivered`)
          res.writeHead(204); res.end(); return
        }
        if (!text) { res.writeHead(204); res.end(); return }

        const sessionId = mainSessionId(cfg)
        // 同一个 bug 的另一处：apply 时 controller 还是 null，必须每条消息现取。
        const ctl = getController()
        if (!ctl || !sessionId) {
          log('drop: no controller or no session id')
          res.writeHead(503); res.end('no target'); return
        }

        // 2026-11-01：主人说「还记得 / 上次 / 以前 / 记不记得」时，先查归档再开口。
        //   规则写进 persona 没用——真正会漏的是「我以为我记得」。所以在入口处挂一句硬提醒。
        const recallHint = /还记得|记不记得|上次|以前|上回|之前那|曾经/.test(text)
          ? '\n（提醒：这句话在问过去。先用 memory_recall 查归档再回答；查不到就说查不到，不许凭印象编。）'
          : ''
        const content = [{ type: 'text', text: `【QQ 私聊】主人说：${text}${recallHint}` }]
        clearGuestWindow()
        try {
          // 2026-10-31 三次踩坑：
          //   ① prompt 内部无条件调 signal.throwIfAborted()，不传 signal 就崩
          //   ② SessionPromptRequest 必须带 requestId 与 mode: 'queue'|'steer'，缺了会被拒
          //   ③ 用 'queue' 时消息只在【这一轮结束之后】才冒出来 —— 而我一轮可以跑很久，
          //      于是主人发的消息全在队列里躺着，看着像「收不到」。聊天通道必须用 'steer' ✓
          const signal = new AbortController().signal
          await ctl.prompt({
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

  // ── 硬闸：访客窗口内，非只读工具一律拒绝 ───────────────────────
  let guardSeen = 0
  const guardEffect = ctx.effect(() => {
    let gtools = null
    try { gtools = ctx.get ? ctx.get('tools') : null } catch {}
    if (!gtools) { try { gtools = ctx.tools } catch {} }
    if (!gtools || typeof gtools.guard !== 'function') {
      log('warn: tools.guard 不可用——访客窗口就只剩提示词那一层了')
      return () => {}
    }
    const dispose = gtools.guard((exec) => {
      const tname = String((exec && exec.name) || '')
      const w = readGuardWindow()
      if (!w) return undefined
      if (READONLY_TOOLS.has(tname)) return undefined
      const left = Math.max(1, Math.ceil((w.until - Date.now()) / 60000))
      const g = w.guest || {}
      const who = g.userId ? `QQ ${g.userId}${g.nick ? ` · ${g.nick}` : ''}` : '访客'
      return `访客在场（${who}，还剩约 ${left} 分钟）：这一轮只读，不执行 ${tname}。主人说一句话即解除。`
    })
    log('guest guard armed')
    return () => { try { dispose && dispose() } catch {} }
  }, 'whale-relay.guard()')

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

  // 2026-11-01 晚：whale_voice_read 随声音卡一起删除（群聊搁置，没有第二个身体可读）。


  let tools = null
  try { if (typeof ctx.get === 'function') tools = ctx.get('tools') } catch {}
  if (!tools) { try { tools = ctx.tools } catch {} }
  if (tools && typeof tools.register === 'function') {
    ctx.effect(() => tools.register(tool), 'whale-relay.tool()')
  }

  log(`apply done (listen ${cfg.listenPort}, owner ${cfg.ownerId})`)
}
