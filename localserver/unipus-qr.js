/**
 * U校园（UniPus / 外研社）扫码登录 —— 只有本地代理能跑。
 *
 * 流程（2026-10 逆向 sso.unipus.cn 的前端 login.js 得到）：
 *   1. POST /sso/7.0/sso/code   {deviceId, service}  → rs.content 就是二维码里要放的字符串
 *   2. 用 U校园 App 扫这个码，App 确认后
 *   3. 服务端通过 socket.io（engine.io v4, wss://umcs.unipus.cn/umcs/）推一条
 *      msg_sso 事件：eventType=code 时是状态（7202 已扫码待确认 / 7201 失效 / 7205 取消），
 *      eventType=login 时带 openId / tgt / jwt
 *   4. GET /sso/7.0/sso/add/cookie?openid=&tgt=&jwt=  把 SSO 的登录态写进 cookie
 *   5. 再访问一次 service（u.unipus.cn/user/login），跟 302 拿到 U校园 自己的会话
 *
 * 为什么只能在本机跑：
 *   socket 只允许 websocket（polling 被服务端关掉了），云函数那套老 Node 用不了；
 *   而且整条链路需要长时间保持一条连接。
 *
 * 依赖：ws（websocket 客户端）、qrcode（把字符串画成二维码图片）。
 * 注意：必须关掉 permessage-deflate，否则服务端会在收到第一个包后直接断连。
 */

const crypto = require('crypto')
const path = require('path')

const CF_ROOT = path.join(__dirname, '..', 'cloudfunctions', 'studyHub')
const h = require(path.join(CF_ROOT, 'lib', 'http'))

const SERVICE = 'https://u.unipus.cn/user/login'
const SSO = 'https://sso.unipus.cn'
const ROUTE = '/sso/login?service=' + encodeURIComponent(SERVICE)

function dep(name) {
  try {
    return require(name)
  } catch (e) {
    throw new Error(
      '缺少依赖 ' + name + '，先在 localserver 目录执行：npm install（或者重新双击「启动代理.bat」，它会自动装）'
    )
  }
}

/** token(deviceId) → 会话 */
const pool = new Map()

function log(msg) {
  const d = new Date()
  const t = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
  console.log('[unipus ' + t + '] ' + msg)
}

/** U校园 的 socket 事件状态码 */
const STATUS_TEXT = {
  7202: '已扫码，请在手机上点「确认登录」',
  7201: '二维码过期了，点「刷新二维码」重来',
  7205: '你在手机上取消了登录'
}

async function fetchCode(deviceId, jar) {
  const res = await h.request(SSO + '/sso/7.0/sso/code', {
    method: 'POST',
    jar,
    body: JSON.stringify({ deviceId, service: SERVICE }),
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      accept: 'application/json, text/javascript, */*; q=0.01',
      'x-requested-with': 'XMLHttpRequest',
      referer: SSO + ROUTE,
      origin: SSO
    }
  })
  const data = JSON.parse(String(res.text || '{}'))
  if (data.code !== '0' || !data.rs || !data.rs.content) {
    throw new Error('取二维码失败：' + (data.msg || '返回内容不正常'))
  }
  return data.rs.content
}

/** 抢到登录事件后，把 SSO 的票据换成 U校园 的会话 cookie */
async function completeLogin(sess, payload) {
  const { openId, tgt, jwt } = payload || {}
  if (!openId || !tgt || !jwt) throw new Error('登录回调缺少 openId/tgt/jwt')

  const add = await h.request(
    SSO + '/sso/7.0/sso/add/cookie?openid=' + encodeURIComponent(openId) +
      '&tgt=' + encodeURIComponent(tgt) + '&jwt=' + encodeURIComponent(jwt),
    {
      jar: sess.jar,
      headers: {
        accept: 'application/json, text/javascript, */*; q=0.01',
        'x-requested-with': 'XMLHttpRequest',
        referer: SSO + ROUTE
      }
    }
  )
  const r = JSON.parse(String(add.text || '{}'))
  if (r.code !== '0') throw new Error('写 cookie 失败：' + (r.msg || add.status))

  // 再走一次 service，跟 302 落到 u.unipus.cn，会话才真正建立
  const land = await h.request('https://u.unipus.cn/user/login', {
    jar: sess.jar,
    maxRedirect: 8,
    headers: { referer: SSO + ROUTE }
  })

  const cookie = sess.jar.header()
  return {
    cookie,
    keys: Object.keys(sess.jar.toObject ? sess.jar.toObject() : {}),
    landed: String(land.url || ''),
    status: land.status
  }
}

/**
 * 生成二维码并开始监听扫码。
 * @returns {Promise<{token:string, qr:string, content:string, expireAt:number}>}
 */
async function start() {
  const WebSocket = dep('ws')
  const QRCode = dep('qrcode')

  const deviceId = crypto.randomBytes(16).toString('hex')
  const jar = new h.CookieJar()

  // 登录页先访问一次，拿它那几个基础 cookie
  await h.request(SSO + ROUTE, { jar, maxRedirect: 5 }).catch(() => null)

  const content = await fetchCode(deviceId, jar)
  const qr = await QRCode.toDataURL(content, { margin: 1, width: 320, color: { dark: '#1B1D2A', light: '#FFFFFF' } })

  const sess = {
    deviceId,
    jar,
    content,
    state: 'init',
    message: '用「U校园」App 扫一扫',
    cookie: '',
    at: Date.now(),
    ws: null,
    events: []
  }
  pool.set(deviceId, sess)

  const wsUrl =
    'wss://umcs.unipus.cn/umcs/?EIO=4&transport=websocket' +
    '&devId=' + deviceId + '&appId=1000&openId=sso'

  try {
    const ws = new WebSocket(wsUrl, {
      headers: { Origin: 'https://umcs.unipus.cn', 'User-Agent': h.UA },
      perMessageDeflate: false
    })
    sess.ws = ws

    ws.on('open', () => log('socket 已连接 ' + deviceId.slice(0, 8)))

    ws.on('message', (raw) => {
      const s = String(raw)
      sess.events.push(s.slice(0, 120))
      if (sess.events.length > 40) sess.events.shift()

      if (s.startsWith('0')) {
        // engine.io 握手完成，立刻连默认命名空间
        setTimeout(() => ws.send('40'), 200)
        return
      }
      if (s === '2') {
        ws.send('3')
        return
      }
      if (s.indexOf('42') !== 0) return

      let packet
      try {
        packet = JSON.parse(s.slice(2))
      } catch (e) {
        return
      }
      if (!packet || packet[0] !== 'msg_sso') return
      const ev = packet[1] || {}

      if (ev.eventType === 'code') {
        sess.state = ev.status === '7202' ? 'scanned' : 'expired'
        sess.message = STATUS_TEXT[ev.status] || '等待手机上确认'
        log('扫码状态 ' + ev.status)
        return
      }

      if (ev.eventType === 'login') {
        sess.state = 'landing'
        sess.message = '已确认，正在换取登录态…'
        log('收到登录票据，开始换 cookie')
        completeLogin(sess, ev)
          .then((r) => {
            sess.cookie = r.cookie
            sess.keys = r.keys
            sess.landed = r.landed
            sess.state = 'ok'
            sess.message = '登录成功'
            log('U校园 登录成功，落点 ' + r.landed)
          })
          .catch((e) => {
            sess.state = 'error'
            sess.message = '换登录态失败：' + e.message
            log('换登录态失败：' + e.message)
          })
      }
    })

    ws.on('error', (e) => log('socket 错误 ' + (e && e.message)))
    ws.on('close', (code) => log('socket 关闭 ' + code))
  } catch (e) {
    // socket 起不来不影响二维码展示，只是收不到扫码结果
    sess.message = '二维码已生成，但监听通道没连上：' + e.message
    log(sess.message)
  }

  // 5 分钟没用就清掉
  setTimeout(() => cleanup(deviceId), 5 * 60 * 1000)

  return { token: deviceId, qr, content, expireAt: Date.now() + 5 * 60 * 1000 }
}

function cleanup(token) {
  const s = pool.get(token)
  if (!s) return
  try {
    if (s.ws) s.ws.close()
  } catch (e) {
    /* ignore */
  }
  pool.delete(token)
}

/**
 * 查扫码进度
 * @returns {{state:string, message:string, cookie?:string, keys?:string[], trace?:string[]}}
 */
function poll(token) {
  const s = pool.get(token)
  if (!s) return { state: 'expired', message: '二维码已失效，点「刷新二维码」重来' }
  const out = {
    state: s.state,
    message: s.message,
    trace: s.events.slice(-8)
  }
  if (s.state === 'ok') {
    out.cookie = s.cookie
    out.keys = s.keys || String(s.cookie || '').split(';').map((x) => x.split('=')[0].trim())
  }
  return out
}

module.exports = { start, poll, cleanup, SERVICE }
