#!/usr/bin/env node
/**
 * 郑州大学统一身份认证（CAS）+ 综合信息门户 —— 课表导入
 *
 * 为什么换成这条路（2026-10 实测结论）：
 *   ① 教务系统 EAMS `jw.v.zzu.edu.cn`（222.22.63.83）的 443 端口只对校园网开放，
 *      公网 TCP 直接超时，云函数更不可能连上；
 *   ② 但 `cas.s.zzu.edu.cn` 和 `info.s.zzu.edu.cn`（222.22.63.65）公网可直连 ——
 *      用户在手机流量 / 家里 WiFi 都能登录；
 *   ③ 门户（苏亚星 supwisdom 系统）自带「我的日程」聚合服务，服务端已经把教务课表
 *      同步过来了：`portal-api/v1/calendar/share/schedule/getEvents`。
 *
 * 所以链路是：
 *   学号 + 密码 → CAS 登录 → 拿到 ticket(JWT) → 拿 X-Id-Token 调门户课表接口
 * 全程不需要校园网，也不需要碰 EAMS。
 *
 * 鉴权细节（从门户前端 bundle 里读出来的）：
 *   - 门户所有接口都带 `X-Id-Token`，值就是 CAS 回跳 URL 里的 `ticket`；
 *     这个 ticket 本身是 JWT，payload 里有 `idToken` / `identityTypeCode` / `organizationName`。
 *   - 登录页密码用 RSA(PKCS#1 v1.5) 加密，公钥取自 `GET /cas/jwt/publicKey`，
 *     密文前加前缀 `__RSA__`。
 *   - 第一轮不弹图形验证码（`captchaSkipN=5`，错 5 次才要），所以正常一次就能过。
 *   - 学校开了双因子（`mfaEnabled=true`，方式含短信 / 扫码）。新设备首次登录可能要被拦，
 *     所以这里额外支持「粘 CASTGC」——浏览器里信任过一次，14 天内直接换 ticket，不再问密码。
 */

const path = require('path')
const crypto = require('crypto')

const HTTP = require(path.join(__dirname, '..', 'cloudfunctions', 'studyHub', 'lib', 'http'))
const S = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'schedule'))
const SEM = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'semester'))

const CAS_BASE = 'https://cas.s.zzu.edu.cn'
const PORTAL_BASE = 'https://info.s.zzu.edu.cn'
const PORTAL_API = PORTAL_BASE + '/portal-api/'

/** CAS 登录成功后要回跳的门户地址（和浏览器里点登录时一致） */
const SERVICE =
  'https://info.s.zzu.edu.cn/?path=https%3A%2F%2Finfo.s.zzu.edu.cn%2Fmain.html%23%2F'

/** 郑大作息：钟点 → 节次。遇到只给时间的日程，用它换算 */
const PERIODS = [
  { p: 1, from: '08:00', to: '08:45' },
  { p: 2, from: '08:55', to: '09:40' },
  { p: 3, from: '10:00', to: '10:45' },
  { p: 4, from: '10:55', to: '11:40' },
  { p: 5, from: '14:00', to: '14:45' },
  { p: 6, from: '14:55', to: '15:40' },
  { p: 7, from: '16:00', to: '16:45' },
  { p: 8, from: '16:55', to: '17:40' },
  { p: 9, from: '19:00', to: '19:45' },
  { p: 10, from: '19:55', to: '20:40' },
  { p: 11, from: '20:50', to: '21:35' },
  { p: 12, from: '21:45', to: '22:30' }
]

const DAY_CN = ['一', '二', '三', '四', '五', '六', '日']

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const ENT = {
  nbsp: ' ', ensp: ' ', emsp: ' ', amp: '&', lt: '<', gt: '>',
  quot: '"', apos: "'", '#39': "'", '#160': ' '
}

function decodeEntities(s) {
  return String(s || '').replace(/&(#?[a-z0-9]+);/gi, (m, k) => {
    const key = String(k).toLowerCase()
    return Object.prototype.hasOwnProperty.call(ENT, key) ? ENT[key] : m
  })
}

function stripTags(s) {
  return decodeEntities(
    String(s || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** RSA 加密密码，和浏览器里 JSEncrypt 的行为一致：PKCS#1 v1.5 + base64 */
function rsaEncrypt(plain, publicKeyPem) {
  return crypto
    .publicEncrypt(
      { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(String(plain), 'utf8')
    )
    .toString('base64')
}

/** JWT 中间段解出来（不验签，只为了读 idToken / 身份 / 学校） */
function jwtPayload(token) {
  const parts = String(token || '').split('.')
  if (parts.length < 2) return null
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    return JSON.parse(Buffer.from(pad, 'base64').toString('utf8'))
  } catch (e) {
    return null
  }
}

/** 从一串 URL 里挑出 CAS 发回的 ticket */
function findTicket(url) {
  const m = /[?&#]ticket=([^&#]+)/.exec(String(url || ''))
  return m ? decodeURIComponent(m[1]) : ''
}

function findQuery(url, key) {
  const m = new RegExp('[?&#]' + key + '=([^&#]+)').exec(String(url || ''))
  return m ? decodeURIComponent(m[1]) : ''
}

/* ------------------------------------------------------------------ */
/* 登录页解析                                                          */
/* ------------------------------------------------------------------ */

function parseLoginPage(html) {
  html = String(html || '')
  const out = {
    ok: false,
    execution: '',
    captcha: false, // 系统支持图形验证码（页面上有这个输入框）
    captchaShown: false, // 这一次真的要求填（由 failN 决定，默认不要）
    mfa: false,
    mfaTypes: [],
    err: ''
  }

  // 有些部署直接吐 JSON 错误，先认一下
  if (/^\s*\{/.test(html)) {
    try {
      const j = JSON.parse(html)
      out.err = j.message || j.msg || ''
    } catch (e) {
      /* 忽略 */
    }
    return out
  }

  const exec =
    /name="execution"[^>]*value="([^"]*)"/i.exec(html) ||
    /id="execution"[^>]*value="([^"]*)"/i.exec(html)
  if (exec) out.execution = decodeEntities(exec[1])

  // 登录表单本身在不在（在 = 还没登录）
  out.ok = /id="fm1"/i.test(html) || !!out.execution

  // 图形验证码：页面上永远有这个输入框，是否「这次要填」由 failN 控制。
  // 默认不显示（captchaSkipN=5，错 5 次才开始要），所以这里分开记两个状态。
  out.captcha = /name="captcha"/i.test(html) && /CaptchaEnabled\s*=\s*"?true"?/i.test(html)
  out.captchaShown = /casServerCaptchaShow\s*=\s*true/.test(html)

  out.mfa = /var\s+mfaEnabled\s*=\s*"?true"?/i.test(html)
  const types = ['SecurePhone', 'AppPush', 'SecureEmail', 'QrCode', 'Otp', 'FaceVerify']
  types.forEach((t) => {
    const re = new RegExp('mfaType' + t + '\\s*=\\s*"?true"?', 'i')
    if (re.test(html)) out.mfaTypes.push(t)
  })

  // 明确已经报错的情况（下次再跑能给出人话提示）
  if (/用户名或密码错误|密码错误|账号或密码/.test(html)) out.err = '账号或密码错误'
  if (/验证码错误|验证码不正确/.test(html)) out.err = '验证码错误'

  return out
}

/* ------------------------------------------------------------------ */
/* 会话（登录页的 jar 要复用，否则验证码图和服务端对不上）                */
/* ------------------------------------------------------------------ */

let liveJar = null
let liveJarAt = 0

function getJar() {
  if (!liveJar || Date.now() - liveJarAt > 10 * 60 * 1000) liveJar = new HTTP.CookieJar()
  liveJarAt = Date.now()
  return liveJar
}

/** 取一张 CAS 图形验证码（只有连续输错 5 次后才会被要求） */
async function captchaImage() {
  const jar = getJar()
  const r = await HTTP.requestBinary(CAS_BASE + '/cas/captcha.jpg?r=' + Date.now(), {
    jar,
    timeout: 12000,
    headers: { referer: CAS_BASE + '/cas/a/login' }
  })
  const buf = r && r.buffer
  if (!buf || !buf.length) return ''
  // CAS 返回的就是 JPEG；万一给的是 HTML 错误页，别当成图显示
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return ''
  return 'data:image/jpeg;base64,' + Buffer.from(buf).toString('base64')
}

/* ------------------------------------------------------------------ */
/* 探测                                                                */
/* ------------------------------------------------------------------ */

async function probe() {
  const out = {
    casReachable: false,
    portalReachable: false,
    casUrl: CAS_BASE + '/cas/login',
    portalApi: PORTAL_API,
    needCaptcha: false,
    mfa: false,
    mfaTypes: [],
    error: '',
    hint: ''
  }

  try {
    const r = await HTTP.request(CAS_BASE + '/cas/login?service=' + encodeURIComponent(SERVICE), {
      timeout: 15000,
      maxRedirect: 4
    })
    if (r.status === 200) {
      out.casReachable = true
      const p = parseLoginPage(r.text)
      out.needCaptcha = p.captchaShown
      out.captchaSupported = p.captcha
      out.mfa = p.mfa
      out.mfaTypes = p.mfaTypes
      out.casUrl = r.url
    } else {
      out.error = '统一认证返回 HTTP ' + r.status
    }
  } catch (e) {
    out.error = String((e && e.message) || e)
    out.hint = /ENOTFOUND|EAI_AGAIN/i.test(out.error)
      ? '域名解析失败，先确认这台电脑能上网。'
      : '连不上统一身份认证，检查网络或代理设置。'
  }

  try {
    const r = await HTTP.request(
      PORTAL_API + 'v1/cms/Column/getColumnList',
      { timeout: 12000, maxRedirect: 2 }
    )
    out.portalReachable = r.status === 200 && /"code"\s*:\s*0/.test(r.text)
  } catch (e) {
    if (!out.error) out.error = String((e && e.message) || e)
  }

  if (out.casReachable && out.portalReachable) {
    out.hint = out.mfa
      ? '公网可达。学校开了双因子，新设备首次可能要短信验证 —— 被拦就改用「粘 CASTGC」。'
      : '公网可达，可以直接学号密码登录。'
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 登录                                                                */
/* ------------------------------------------------------------------ */

/**
 * 上一次登录页的状态（execution + 页面地址）。
 * 验证码是绑在会话上的：图是在哪个会话里取的，就必须用同一份 execution 提交，
 * 否则「填完验证码又说不匹配」——这是这套 CAS 最容易踩的坑。
 */
let lastForm = { execution: '', pageUrl: '', at: 0 }

function rememberForm(pageUrl, html) {
  const p = parseLoginPage(html)
  if (p.execution) lastForm = { execution: p.execution, pageUrl, at: Date.now() }
  return p
}

function formFresh() {
  return !!(lastForm.execution && Date.now() - lastForm.at < 5 * 60 * 1000)
}

/** 把表单里的 action="login" 解析成绝对地址（真实地址是 /cas/a/login，不是 /cas/login） */
function formAction(pageUrl) {
  return new URL('login', pageUrl || CAS_BASE + '/cas/a/login').toString()
}

/**
 * 走一遍 CAS。三种进法：
 *   ① 学号 + 密码
 *   ② 学号 + 密码 + 图形验证码（郑大这边首次也会要，失败一次后前端把图显示出来）
 *   ③ 只给 CASTGC（浏览器里信任过的设备，直接换 ticket，绕开密码和短信）
 *
 * @param {{username?:string,password?:string,captcha?:string,tgc?:string,jar?:object}} o
 * @returns {Promise<{success:boolean,ticket?:string,token?:string,chain?:string[],needCaptcha?:boolean,captchaImg?:string,needMfa?:boolean,error?:string,hint?:string}>}
 */
async function login(o) {
  o = o || {}
  const jar = o.jar || getJar()
  const chain = []
  const svcUrl = CAS_BASE + '/cas/login?service=' + encodeURIComponent(SERVICE)

  // 已经信任过的设备：把 CASTGC 塞进 jar，一次跳转就能拿到 ticket
  const tgc = String(o.tgc || '').trim()
  if (tgc) jar.setFromHeader('CASTGC=' + tgc.replace(/^CASTGC=/i, '') + '; Path=/cas/')

  // 复用上一次的登录页（验证码是绑会话的，重新拉页面会把图冲掉）
  let page = null
  let parsed = null
  const reuse = !tgc && formFresh()

  // 先取验证码：CAS 是在「取验证码」这一步才建 SESSION 的，验证码就绑在这个会话上。
  // 顺序反了会出现「图明明填对了也不认」——这是实测踩出来的坑。
  let capImg = ''
  if (!tgc && !o.captcha) capImg = await captchaImage().catch(() => '')

  if (!reuse) {
    try {
      page = await HTTP.request(svcUrl, { jar, timeout: 15000, maxRedirect: 4 })
    } catch (e) {
      return { success: false, error: '连不上统一认证：' + String((e && e.message) || e) }
    }
    chain.push(page.status + ' ' + page.url)

    // 有 CASTGC 且还有效：直接就被跳走，ticket 在地址里
    const t0 = findTicket(page.url)
    if (t0) return finishWithTicket(t0, jar, chain)

    parsed = rememberForm(page.url, page.text)
    if (!parsed.ok) {
      return {
        success: false,
        error: parsed.err || '没认出登录表单，可能页面改版了',
        hint: '把这一页的 HTML 存下来发我，我照着改字段。'
      }
    }
  }

  // 第一轮：只把验证码图拿给用户，不提交（郑大这边每次登录都要验证码，
  // 空着提交必然白丢一次，还会把 failN 往上顶，错的次数多了要锁账号）
  if (!tgc && !o.captcha) {
    return {
      success: false,
      needCredentials: !(o.username && o.password),
      needCaptcha: !!capImg,
      captchaImg: capImg,
      mfa: parsed ? parsed.mfa : false,
      mfaTypes: parsed ? parsed.mfaTypes : [],
      error: capImg ? '照图填一次验证码' : '没取到验证码图',
      hint: capImg ? '统一认证每次登录都要图形验证码，填完直接再点。' : '刷新一下页面再试。'
    }
  }

  if (!o.username || !o.password) {
    return {
      success: false,
      needCredentials: true,
      needCaptcha: true,
      mfa: parsed ? parsed.mfa : false,
      mfaTypes: parsed ? parsed.mfaTypes : [],
      error: '需要学号和密码'
    }
  }

  // 公钥（成本很低，每次重取）
  let pem = ''
  try {
    const k = await HTTP.request(CAS_BASE + '/cas/jwt/publicKey', { jar, timeout: 10000, maxRedirect: 2 })
    pem = String(k.text || '').trim()
  } catch (e) {
    return { success: false, error: '取加密公钥失败：' + String((e && e.message) || e) }
  }
  if (!/BEGIN PUBLIC KEY/.test(pem)) return { success: false, error: '公钥格式不认识，CAS 可能改版了' }

  const encrypted = '__RSA__' + rsaEncrypt(o.password, pem)
  const execution = parsed ? parsed.execution : lastForm.execution
  const pageUrl = page ? page.url : lastForm.pageUrl

  const form = [
    'username=' + encodeURIComponent(o.username),
    'password=' + encodeURIComponent(encrypted),
    'captcha=' + encodeURIComponent(o.captcha || ''),
    'mfaState=',
    'currentMenu=1',
    'failN=-1',
    'rememberMe=on',
    '_eventId=submit',
    'execution=' + encodeURIComponent(execution)
  ].join('&')

  const postUrl = formAction(pageUrl)
  let r
  try {
    r = await HTTP.request(postUrl, {
      method: 'POST',
      jar,
      body: form,
      timeout: 20000,
      maxRedirect: 0,
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }
    })
  } catch (e) {
    return { success: false, error: '提交登录失败：' + String((e && e.message) || e) }
  }
  chain.push(r.status + ' POST ' + postUrl)

  // 跟着跳转链走，直到出现 ticket
  let url = r.url
  let status = r.status
  let loc = r.headers.get('location') || ''
  let lastHtml = r.text || ''
  let guard = 0

  while (guard++ < 12) {
    const t = findTicket(loc) || findTicket(url)
    if (t) {
      chain.push('→ ' + (loc || url))
      return finishWithTicket(t, jar, chain)
    }
    if (status >= 300 && status < 400 && loc) {
      url = new URL(loc, url).toString()
      chain.push('→ ' + url)
      const nx = await HTTP.request(url, { jar, timeout: 20000, maxRedirect: 0 })
      status = nx.status
      url = nx.url
      loc = nx.headers.get('location') || ''
      lastHtml = nx.text || ''
      continue
    }
    break
  }

  // 没拿到 ticket：分清是「要二次验证」还是「验证码/密码不对」。
  // 注意不能用页面里的 showGuardDialog 判断 —— 那段弹窗 HTML 是常驻的，
  // 每次都会匹配上（踩过）。只能看服务端到底把人往哪跳。
  const failed = rememberForm(url, lastHtml)
  const hitMfa = /\/cas\/mfa|\/mfa\//i.test(url) || /\/cas\/mfa/i.test(loc)

  if (hitMfa) {
    return {
      success: false,
      needMfa: true,
      mfaTypes: failed.mfaTypes,
      error: '密码过了，但要短信/扫码二次验证',
      hint: '在自己浏览器里登录一次并勾「记住我」，再把 CASTGC 贴过来（一次管 14 天）。',
      chain
    }
  }

  const img = await captchaImage().catch(() => '')
  return {
    success: false,
    needCaptcha: !!img,
    captchaImg: img,
    error: failed.err || '验证码或密码不对',
    hint: '换张新图再填一次。连续错 5 次，账号会被锁 5 分钟。',
    chain
  }
}

/** 有了 ticket 就等于有了门户口令 */
function finishWithTicket(ticket, jar, chain) {
  const payload = jwtPayload(ticket) || {}
  // 门户前端就是把 ticket 当 X-Id-Token 用的；payload 里的 idToken 作备用
  const token = ticket
  return {
    success: true,
    ticket,
    token,
    altToken: payload.idToken || '',
    name: payload.name || payload.userName || payload.accountName || '',
    identity: payload.identityTypeCode || '',
    org: payload.organizationName || '',
    chain
  }
}

/* ------------------------------------------------------------------ */
/* 门户接口                                                            */
/* ------------------------------------------------------------------ */

function portalHeaders(token) {
  return {
    'x-id-token': token,
    'x-device-info': 'PC',
    'x-terminal-info': 'PC',
    accept: 'application/json, text/plain, */*',
    referer: PORTAL_BASE + '/main.html'
  }
}

async function portalGet(p, token, timeout) {
  const r = await HTTP.request(PORTAL_API + p, {
    timeout: timeout || 20000,
    maxRedirect: 2,
    headers: portalHeaders(token)
  })
  let json = null
  try {
    json = JSON.parse(r.text)
  } catch (e) {
    json = null
  }
  return { status: r.status, json, text: r.text }
}

/**
 * 钟点 → 节次。只给时间的日程靠它定位。
 *   mode='start' 拿上课时间比（08:00 → 第 1 节）
 *   mode='end'   拿下课时间比（09:40 → 第 2 节；这一步必须分开比，
 *                否则 09:40 离「第 3 节 10:00」更近，会被算成第 3 节）
 */
function timeToPeriod(hhmm, mode) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim())
  if (!m) return 0
  const mins = Number(m[1]) * 60 + Number(m[2])
  const field = mode === 'end' ? 'to' : 'from'
  let best = 0
  let diff = 1e9
  PERIODS.forEach((x) => {
    const [fh, fm] = x[field].split(':').map(Number)
    const d = Math.abs(fh * 60 + fm - mins)
    if (d < diff) {
      diff = d
      best = x.p
    }
  })
  return diff <= 45 ? best : 0
}

/** 从一堆可能的名字里挑第一个有值的 */
function pick(obj, keys) {
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k]
  }
  return ''
}

function dayFromDate(s) {
  const t = Date.parse(String(s || '').replace(/\//g, '-'))
  if (isNaN(t)) return 0
  const d = new Date(t).getDay()
  return d === 0 ? 7 : d
}

function normTime(s) {
  const m = /(\d{1,2}):(\d{2})/.exec(String(s || ''))
  return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : ''
}

/**
 * 把门户日程 JSON 拍平成课表条目。
 * 门户是聚合服务，字段名各校不一样，所以这里做「多名字兜底」而不是死认一套。
 */
function parseEvents(json) {
  const items = []
  const meta = { total: 0, shape: '', sampleKeys: [] }
  if (!json || json.code !== 0 || !json.data) return { items, meta }

  let list = json.data
  if (!Array.isArray(list)) {
    const cand = ['events', 'eventList', 'list', 'records', 'rows', 'scheduleList', 'data']
    for (let i = 0; i < cand.length; i++) {
      if (Array.isArray(json.data[cand[i]])) {
        list = json.data[cand[i]]
        meta.shape = cand[i]
        break
      }
    }
  }
  if (!Array.isArray(list)) {
    meta.shape = 'object:' + Object.keys(json.data).join(',')
    return { items, meta }
  }

  meta.total = list.length
  if (list.length) meta.sampleKeys = Object.keys(list[0]).slice(0, 30)

  list.forEach((ev) => {
    if (!ev || typeof ev !== 'object') return

    const title = String(
      pick(ev, ['title', 'name', 'courseName', 'summary', 'subject', 'eventName', 'course_name'])
    ).trim()
    if (!title) return

    const place = String(pick(ev, ['location', 'place', 'room', 'address', 'classroom', 'roomName'])).trim()

    // 星期：优先明确字段，其次从日期推
    let day = Number(pick(ev, ['weekDay', 'dayOfWeek', 'weekday', 'day', 'week']))
    if (!(day >= 1 && day <= 7)) {
      day = dayFromDate(pick(ev, ['startDate', 'date', 'start', 'startTime', 'beginTime']))
    }
    if (!(day >= 1 && day <= 7)) return

    // 节次：优先明确字段，其次按时间换算
    let start = Number(pick(ev, ['startSection', 'startPeriod', 'sectionStart', 'startNode', 'section']))
    let end = Number(pick(ev, ['endSection', 'endPeriod', 'sectionEnd', 'endNode']))
    if (!(start >= 1)) {
      const st = normTime(pick(ev, ['startTime', 'beginTime', 'start', 'startDate']))
      const et = normTime(pick(ev, ['endTime', 'finishTime', 'end']))
      start = timeToPeriod(st)
      end = timeToPeriod(et, 'end')
      if (!(start >= 1)) return
      if (!(end >= start)) end = start
    }
    if (!(end >= start)) end = start
    if (end > 12) end = 12

    // 周次：有就带上，没有就是不限。
    // 注意小程序那边的约定是 parity（1 单 / 2 双），不是 odd/even ——
    // 字段名对不上，界面就不会按单双周过滤。
    let weeks = null
    const ws = Number(pick(ev, ['startWeek', 'weekStart', 'fromWeek']))
    const we = Number(pick(ev, ['endWeek', 'weekEnd', 'toWeek']))
    const oddEven = String(pick(ev, ['weekType', 'oddEven', 'weekFlag']))
    const parity = /单|odd/i.test(oddEven) ? 1 : /双|even/i.test(oddEven) ? 2 : 0
    if (ws >= 1 && we >= ws) {
      weeks = { from: ws, to: we }
      if (parity) weeks.parity = parity
    } else if (parity) {
      // 只说了单/双、没说起止周：按整学期算（和课表页 parseWeeks 的兜底一致）
      weeks = { from: 1, to: 30, parity }
    }

    items.push({
      id: [day, start, end, title].join('|'),
      day,
      start,
      end,
      name: title,
      place,
      weeks,
      raw: ev
    })
  })

  return { items, meta }
}

/** 本学期大致范围：8 月 1 日 ~ 次年 2 月底（跨半年，足够覆盖秋春两学期） */
function defaultRange(now) {
  const d = now ? new Date(now) : new Date()
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  const startYear = m >= 8 ? y : m === 1 ? y - 1 : y - 1
  const from = startYear + '-08-01'
  const to = startYear + 1 + '-03-31'
  return { from, to }
}

/** 把门户拿到的课表整体导出成「小程序课表」需要的结构 */
async function fetchSchedule(o) {
  o = o || {}
  const token = o.token || o.ticket || ''
  if (!token) return { success: false, error: '没有门户登录态，先登录' }

  const range = o.from && o.to ? { from: o.from, to: o.to } : defaultRange()

  let res
  try {
    res = await portalGet(
      'v1/calendar/share/schedule/getEvents?startDate=' + range.from + '&endDate=' + range.to,
      token
    )
  } catch (e) {
    return { success: false, error: '调门户课表接口失败：' + String((e && e.message) || e) }
  }

  if (!res.json) {
    return { success: false, error: '门户返回的不是 JSON', raw: String(res.text || '').slice(0, 500) }
  }
  if (res.json.code !== 0) {
    return {
      success: false,
      error: res.json.message || '门户拒绝了这次请求',
      needLogin: res.json.code === -1
    }
  }

  const parsed = parseEvents(res.json)
  const semName = SEM.current()
  return {
    success: parsed.items.length > 0,
    count: parsed.items.length,
    items: parsed.items,
    raw: parsed.items.length ? undefined : res.json,
    meta: parsed.meta,
    range,
    semesterName: semName ? semName.label : '',
    message: parsed.items.length
      ? '已从门户拉取 ' + parsed.items.length + ' 节'
      : '门户返回了数据但没解析出课程，把 raw 发我看下'
  }
}

/** 教学周：门户能告诉我们「现在是第几周」，拿到就顺手校准开学日 */
async function weekOfTeaching(token) {
  try {
    const r = await portalGet('v1/calendar/share/schedule/getWeekOfTeaching', token, 12000)
    return (r.json && r.json.data) || null
  } catch (e) {
    return null
  }
}

module.exports = {
  CAS_BASE,
  PORTAL_BASE,
  PORTAL_API,
  SERVICE,
  probe,
  login,
  captchaImage,
  fetchSchedule,
  weekOfTeaching,
  _internal: {
    rsaEncrypt,
    jwtPayload,
    findTicket,
    findQuery,
    parseLoginPage,
    parseEvents,
    timeToPeriod,
    defaultRange,
    PORTAL_API,
    SERVICE
  }
}
