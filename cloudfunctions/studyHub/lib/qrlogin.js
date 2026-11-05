/**
 * 学习通扫码登录。
 *
 * 流程（全部在云函数里完成，不碰浏览器）：
 *   1. GET  passport2.chaoxing.com/login  → 服务端下发 JSESSIONID，页面里带 uuid / enc
 *   2. GET  passport2.chaoxing.com/createqr?uuid=...  → 真正的二维码 PNG
 *   3. 用户用手机「学习通」App 扫码并在手机上点确认
 *   4. POST passport2.chaoxing.com/getauthstatus/v2  → status=true 时 Set-Cookie 带上登录态
 *
 * 会话本身不需要存数据库：uuid / enc / 临时 cookie 加密成一个 token 交给前端，
 * 轮询时再带回来。云函数是无状态的，冷启动、多实例都不会丢。
 */

const http = require('./http')
const secret = require('./secret')

const BASE = 'https://passport2.chaoxing.com'
const LOGIN_PAGE = BASE + '/login?fid=&refer=http%3A%2F%2Fi.chaoxing.com'
const TTL = 4 * 60 * 1000

/** 从登录页 HTML 里抠出 uuid / enc 两个隐藏字段 */
function extractParams(html) {
  const uuid = http.matchOne(html, /value="([0-9a-zA-Z_-]{16,64})"\s+id="uuid"/)
  const enc = http.matchOne(html, /value="([0-9a-zA-Z_-]{16,64})"\s+id="enc"/)
  return { uuid, enc }
}

/** 判断一张 PNG 是否像二维码（够大、魔数正确） */
function looksLikePng(buf) {
  if (!buf || buf.length < 400) return false
  return buf.slice(0, 4).toString('hex') === '89504e47'
}

/**
 * 第一步：拿二维码。
 * @param {string} openid 会话所有者，防止 token 被换到别的用户身上
 * @returns {{token:string, qr:string, expireAt:number}}
 */
async function start(openid) {
  const jar = new http.CookieJar()
  const res = await http.request(LOGIN_PAGE, { jar, timeout: 15000 })

  if (res.status !== 200) throw new Error('学习通登录页打不开（HTTP ' + res.status + '）')

  const { uuid, enc } = extractParams(res.text)
  if (!uuid || !enc) {
    console.log('[qrStart] 登录页异常, len =', res.text.length, 'head =', res.text.slice(0, 160))
    // 云函数出口 IP 是机房 IP，被风控时会返回验证页而不是登录页
    const blocked = /captcha|验证码|人机验证|安全验证|滑动|重试/.test(res.text)
    throw new Error(
      blocked
        ? '学习通要求人机验证（云函数出口 IP 被风控），扫码登录暂时不可用，请改用 Cookie 方式'
        : '学习通登录页结构变了，没取到二维码参数。可先改用 Cookie 方式登录'
    )
  }

  const qr = await http.requestBinary(
    BASE + '/createqr?uuid=' + encodeURIComponent(uuid) + '&fid=-1',
    { jar, timeout: 15000, headers: { referer: LOGIN_PAGE } }
  )

  if (!looksLikePng(qr.buffer)) {
    const head = qr.buffer.slice(0, 200).toString('utf8')
    throw new Error('二维码图片没拿到（' + qr.status + '）：' + head.replace(/\s+/g, ' ').slice(0, 80))
  }

  const token = secret.encrypt(
    JSON.stringify({ uuid, enc, cookie: jar.header(), t: Date.now(), o: openid || '' })
  )

  return {
    token,
    qr: 'data:image/png;base64,' + qr.buffer.toString('base64'),
    expireAt: Date.now() + TTL
  }
}

/**
 * 登录成功后再走一两跳，把 _uid / _d / uf 等登录态 cookie 补齐。
 * 超星的登录态不是一次 Set-Cookie 给全的，跟着页面跳转才会逐个下发。
 *
 * 同时判断「这个登录态到底有没有被服务端接受」：这些地址在未登录时一律 302 到
 * passport2 登录页，所以只看 cookie 字段齐不齐是不够的，要看有没有被踢回登录页。
 */
async function completeSession(jar) {
  const probes = [
    'https://i.chaoxing.com/base',
    'https://i.mooc.chaoxing.com/space/index',
    'https://mooc1.chaoxing.com/visit/interaction'
  ]
  let alive = false
  const hops = []
  for (let i = 0; i < probes.length; i++) {
    let res = null
    try {
      res = await http.request(probes[i], { jar, timeout: 12000, maxRedirect: 5 })
    } catch (e) {
      hops.push('x')
      continue
    }
    const ok = res.status === 200 && !/passport2?\.chaoxing\.com\/login/i.test(res.url || '')
    hops.push(ok ? 'ok' : 'login')
    if (ok) alive = true
    if (alive && jar.has('_uid') && jar.has('_d') && jar.has('uf')) break
  }
  return {
    cookie: jar.header(),
    ready: jar.has('_uid') && jar.has('_d') && jar.has('uf'),
    alive,
    hops,
    keys: Object.keys(jar.toObject())
  }
}

/**
 * 第二步：轮询扫码状态。
 * @param {string} token start() 返回的 token
 * @param {string} openid 当前用户，必须和发起时一致
 * @returns {{state:'waiting'|'scanned'|'expired'|'error'|'ok', message?:string, cookie?:string, nickname?:string, ready?:boolean}}
 */
async function poll(token, openid) {
  if (!token) throw new Error('缺少会话标识')

  let sess
  try {
    sess = JSON.parse(secret.decrypt(token))
  } catch (e) {
    return { state: 'expired', message: '扫码会话已失效，请点刷新二维码' }
  }
  if (sess.o && openid && sess.o !== openid) {
    return { state: 'error', message: '会话不属于当前用户，请重新获取二维码' }
  }
  if (!sess.uuid || !sess.enc) {
    return { state: 'expired', message: '扫码会话不完整，请点刷新二维码' }
  }
  if (Date.now() - (sess.t || 0) > TTL) {
    return { state: 'expired', message: '二维码已过期，请点刷新' }
  }

  const jar = new http.CookieJar(sess.cookie)
  const body = http.formBody({
    enc: sess.enc,
    uuid: sess.uuid,
    doubleFactorLogin: '0',
    forbidotherlogin: '0'
  })

  const res = await http.request(BASE + '/getauthstatus/v2', {
    method: 'POST',
    jar,
    body,
    timeout: 12000,
    maxRedirect: 0,
    headers: {
      referer: LOGIN_PAGE,
      origin: BASE,
      'x-requested-with': 'XMLHttpRequest',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin'
    }
  })

  let data
  try {
    data = JSON.parse(res.text)
  } catch (e) {
    return { state: 'waiting' }
  }

  // 登录成功
  if (data && data.status) {
    const sess2 = await completeSession(jar)
    return {
      state: 'ok',
      cookie: sess2.cookie,
      ready: sess2.ready,
      alive: sess2.alive,
      hops: sess2.hops,
      keys: sess2.keys,
      nickname: data.nickname || '',
      uid: data.uid || ''
    }
  }

  const type = String(data.type === undefined ? '' : data.type)
  if (type === '4') {
    // 已扫码，等用户在手机上点「确认」
    return { state: 'scanned', nickname: data.nickname || '', uid: data.uid || '' }
  }
  if (type === '2') return { state: 'expired', message: '二维码已失效，请刷新' }
  if (type === '6') return { state: 'expired', message: '手机上取消了登录，请重新扫码' }
  if (type === '7') return { state: 'error', message: data.mes || '登录被拒绝' }
  return { state: 'waiting' }
}

module.exports = { start, poll, TTL }
