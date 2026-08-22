/**
 * ============================================================================
 * dsh-shutup 宿主半侧（host half）—— 思考链回填注入（方案 A 宿主侧）
 * ============================================================================
 * 职责（配合浏览器半侧）：
 *   1. 接收 POST /shutup/backfill { sessionId, text }：暂存一条"一次性上下文回填"。
 *   2. 通过 systemPrompt.context 注册全局上下文贡献：下一次该会话的
 *      提示词组装（pre-step assemble）时把回填文本注入**当前运行时上下文**
 *      ——官方机制会把它物化为会话里的持久化 user-role 上下文消息，
 *      聊天 UI 以"可折叠/可展开的上下文行"展示：折叠时只有一行摘要，
 *      展开看到全文；模型在下一步完整读到回填内容。
 *   3. 一次性语义：匹配到目标会话的组装即取走并清除；60s TTL 防泄漏；
 *      其它会话组装时返回空串、不消费。
 * ============================================================================
 */

// 插件行 id（与 cordis.patch.yml 一致）
const name = 'shutup'
/** webServer：/shutup 前缀路由；systemPrompt：一次性上下文回填 */
const inject = ['webServer', 'systemPrompt']

/** 回填 TTL：60s 内未消费自动作废 */
const BACKFILL_TTL_MS = 60 * 1000
/** 回填文本上限（防误传超大内容） */
const BACKFILL_MAX_CHARS = 20 * 1000

function apply(ctx, config) {
  // sessionId -> { text, at }；一次性：被该会话的组装消费即删
  const pending = new Map()

  // 全局上下文贡献：每个会话的每次组装都会调用本 provider，
  // 只对 pending 里的目标会话返回回填文本（并取走），其余返回 ''。
  // 注册方式与 dsh-super-injector 相同：inject: ['systemPrompt'] + 直接调用 + 容忍重复注册。
  try {
    ctx.systemPrompt.context({
      name: 'shutup-backfill',
      order: 400,
      text: (asmCtx) => {
        try {
          const agent = asmCtx && asmCtx.agent;
          const id = agent && typeof agent.id === 'string' ? agent.id : null;
          if (id === null) return '';
          const rec = pending.get(id);
          if (rec === undefined) return '';
          if (Date.now() - rec.at > BACKFILL_TTL_MS) {
            pending.delete(id);
            return '';
          }
          pending.delete(id);   // 一次性：只注入这一次组装
          return rec.text;
        } catch (e) {
          return '';
        }
      },
    });
  } catch (e) {
    /* 重复注册等：容忍，功能退化为无回填（客户端会退回全文直发） */
  }

  // ---- HTTP 接口（浏览器半侧消费） ----
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        data += chunk
        if (data.length > 64 * 1024) {
          reject(new Error('请求体过大'))
          req.destroy()
        }
      })
      req.on('end', () => {
        if (data.length === 0) { resolve({}); return }
        try { resolve(JSON.parse(data)) } catch (e) { reject(new Error('请求体不是合法 JSON')) }
      })
      req.on('error', reject)
    })
  }
  function send(res, code, payload) {
    try {
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.writeHead(code)
      res.end(JSON.stringify(payload))
    } catch (e) { /* 客户端已断开 */ }
  }

  /** 从会话日志读最后一条 interrupted 消息（0.1.1 官方中断落盘 = 权威源）。 */
  async function readLastInterrupted(sessionId) {
    try {
      const sessionQuery = ctx.get('sessionQuery')
      if (!sessionQuery || typeof sessionQuery.load !== 'function') return null
      const snap = await sessionQuery.load(sessionId, AbortSignal.timeout(8000))
      const events = snap && Array.isArray(snap.events) ? snap.events : null
      if (!events) return null
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (e && e.type === 'assistant/message' && e.data && e.data.interrupted === true) {
          const blocks = Array.isArray(e.data.message?.content) ? e.data.message.content : []
          let reasoning = ''
          let text = ''
          for (const b of blocks) {
            if (b && b.type === 'reasoning' && typeof b.text === 'string') reasoning += b.text
            if (b && b.type === 'text' && typeof b.text === 'string') text += b.text
          }
          return {
            reasoning,
            text,
            usage: e.data.usage ?? null,
          }
        }
      }
      return null
    } catch (e) {
      return null
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/shutup',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      try {
        if (req.method === 'POST' && url.pathname === '/shutup/backfill') {
          const body = await readBody(req)
          if (typeof body.sessionId !== 'string' || body.sessionId.length === 0 ||
              typeof body.text !== 'string' || body.text.length === 0) {
            return send(res, 400, { ok: false, error: 'sessionId 与 text 必填' })
          }
          if (body.text.length > BACKFILL_MAX_CHARS) {
            return send(res, 400, { ok: false, error: 'text 超过 ' + BACKFILL_MAX_CHARS + ' 字符上限' })
          }
          pending.set(body.sessionId, { text: body.text, at: Date.now() })
          return send(res, 200, { ok: true })
        }
        if (req.method === 'GET' && (url.pathname === '/shutup/interrupted' || url.pathname === '/shutup/interrupted/last')) {
          const sessionId = url.searchParams.get('sessionId')
          if (typeof sessionId !== 'string' || sessionId.length === 0) {
            return send(res, 400, { ok: false, error: 'sessionId 必填' })
          }
          const hit = await readLastInterrupted(sessionId)
          return send(res, 200, { ok: true, interrupted: hit })
        }
        return send(res, 404, { ok: false, error: '未知接口: ' + url.pathname })
      } catch (e) {
        return send(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
      }
    },
  }), 'dsh-shutup: /shutup backfill 路由')
}

export { apply, inject, name }
