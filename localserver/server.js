#!/usr/bin/env node
/**
 * 学习通本地代理服务器（方案 A）。
 *
 * 为什么需要它：
 *   云函数跑在腾讯云机房，出口是机房 IP，超星经常不认这种来源。
 *   这个服务跑在你自己电脑上，用的是你家宽带 / 校园网的出口 IP，
 *   并且 Cookie 全程只存在于服务端内存里，不经过浏览器、不经过小程序。
 *
 * 架构：
 *   小程序 ──HTTP──► 本机服务(127.0.0.1:7788) ──HTTPS──► 学习通
 *                          │
 *                          └── 抓到的任务 ──► 小程序 ──► 云数据库（首页/提醒照旧）
 *
 * 吃到的抓取逻辑全部复用云函数目录里的模块，一份代码两处跑：
 *   ../cloudfunctions/studyHub/lib/qrlogin.js    扫码登录
 *   ../cloudfunctions/studyHub/adapters/chaoxing.js  课程 / 作业 / 任务点解析
 *
 * 启动：
 *   node localserver/server.js
 *   node localserver/server.js --localhost     只监听本机（真机连不上，但更安全）
 *   CX_KEY=123456 node localserver/server.js    加一道口令
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const CF_ROOT = path.join(__dirname, '..', 'cloudfunctions', 'studyHub')
const h = require(path.join(CF_ROOT, 'lib', 'http'))
const qrlogin = require(path.join(CF_ROOT, 'lib', 'qrlogin'))
const chaoxing = require(path.join(CF_ROOT, 'adapters', 'chaoxing'))
const unipusQr = require('./unipus-qr')
const eams = require('./eams')
const cas = require('./cas')

const ARGV = process.argv.slice(2)
const LOCAL_ONLY = ARGV.indexOf('--localhost') > -1
const PORT = Number(process.env.PORT || (ARGV.find((a) => /^\d{2,5}$/.test(a)) || 7788))
const HOST = LOCAL_ONLY ? '127.0.0.1' : '0.0.0.0'
const KEY = process.env.CX_KEY || ''
const SESSION_FILE =
  process.env.CX_SESSION_FILE || path.join(__dirname, 'session.json')
const VERSION = '1.0.0'

/* ------------------------------------------------------------------ */
/* 会话池：cookie 只落在本机内存 + 本机磁盘，永远不上云                  */
/* ------------------------------------------------------------------ */

const sessions = new Map() // sid -> { cookie, nickname, uid, at }

function loadSessions() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'))
    Object.keys(raw || {}).forEach((k) => sessions.set(k, raw[k]))
    if (sessions.size) log('已恢复 ' + sessions.size + ' 个本地会话')
  } catch (e) {
    /* 没有存档就是首次启动，正常 */
  }
}

function saveSessions() {
  const obj = {}
  sessions.forEach((v, k) => (obj[k] = v))
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(obj, null, 2), 'utf8')
  } catch (e) {
    log('会话存档失败：' + e.message)
  }
}

function newSid() {
  return crypto.randomBytes(9).toString('hex')
}

/** 从请求体里取 cookie：优先 sid（会话池），其次直接用传进来的 cookie 串 */
function resolveCookie(body) {
  if (body && body.cookie) {
    return { cookie: String(body.cookie), from: '请求参数' }
  }
  const sid = body && body.sid
  if (sid) {
    const s = sessions.get(sid)
    if (s && s.cookie) return { cookie: s.cookie, from: '本地会话' }
    throw new Error('本地会话不存在或已失效，请重新扫码')
  }
  // 只有一个会话时直接用它，省得前端还记 sid
  if (sessions.size === 1) {
    const only = sessions.values().next().value
    if (only && only.cookie) return { cookie: only.cookie, from: '本地会话（唯一）' }
  }
  throw new Error('还没有本地登录态，请先扫码登录')
}

function cookieKeysOf(cookieStr) {
  return String(cookieStr || '')
    .split(';')
    .map((x) => x.trim().split('=')[0])
    .filter(Boolean)
    .join(',')
}

/* ------------------------------------------------------------------ */
/* 各个动作                                                           */
/* ------------------------------------------------------------------ */

async function actQrStart() {
  const r = await qrlogin.start('local')
  return { token: r.token, qr: r.qr, expireAt: r.expireAt }
}

async function actQrPoll(body) {
  const r = await qrlogin.poll(body.token, 'local')
  if (r.state === 'ok') {
    const sid = newSid()
    sessions.set(sid, {
      cookie: r.cookie,
      nickname: r.nickname || '',
      uid: r.uid || '',
      at: Date.now()
    })
    saveSessions()
    log('扫码成功，本地会话已建立 ' + sid + '（字段：' + cookieKeysOf(r.cookie) + '）')
    return Object.assign({}, r, {
      sid,
      keys: cookieKeysOf(r.cookie).split(',')
    })
  }
  return r
}

/** 只抓课程列表：最快能验证「登录态到底认不认」 */
async function actCourses(body) {
  const { cookie, from } = resolveCookie(body)
  const jar = new h.CookieJar(cookie)
  const trace = []
  const list = await chaoxing._internal.fetchCourses(jar, trace, false)

  // 顺手验一下登录态是不是真的活着（未登录时这些地址会 302 到 login）
  let alive = null
  try {
    const probe = await h.request('https://i.chaoxing.com/base', {
      jar: new h.CookieJar(cookie),
      timeout: 12000,
      maxRedirect: 5
    })
    alive = !/passport2?\.chaoxing\.com\/login/i.test(probe.url || '')
  } catch (e) {
    alive = null
  }

  const compact = []
  trace.forEach((t) => {
    const last = compact[compact.length - 1]
    if (last && last.text === t) last.n++
    else compact.push({ text: t, n: 1 })
  })

  log('抓课程：来源=' + from + '，得到 ' + ((list && list.length) || 0) + ' 门，登录态存活=' + alive)

  return {
    count: (list && list.length) || 0,
    courses: (list || []).map((c) => ({
      name: c.name,
      courseId: c.courseId,
      clazzId: c.clazzId,
      cpi: c.cpi
    })),
    alive,
    cookieKeys: cookieKeysOf(cookie),
    trace: compact.map((x) => (x.n > 1 ? x.text + '×' + x.n : x.text)).join('；')
  }
}

/** 抓全部任务（慢，可能几十秒） */
async function actSync(body) {
  const { cookie, from } = resolveCookie(body)
  const limit = Math.max(1, Math.min(60, Number((body && body.limit) || 12)))
  const t0 = Date.now()
  const r = await chaoxing.sync(
    {
      mode: 'cookie',
      cookie,
      username: (body && body.username) || 'local'
    },
    { limit }
  )
  log(
    '抓任务：来源=' + from + '，上限 ' + limit + ' 门，' + r.tasks.length + ' 项，耗时 ' +
      Math.round((Date.now() - t0) / 1000) + 's'
  )
  if (r.errors && r.errors.length) log('部分课程失败：' + r.errors.join('；'))
  return {
    count: r.tasks.length,
    tasks: r.tasks,
    debug: r.debug,
    errors: r.errors || [],
    limit
  }
}

async function actStatus() {
  const list = []
  sessions.forEach((v, k) => {
    list.push({
      sid: k,
      nickname: v.nickname,
      uid: v.uid,
      at: v.at,
      keys: cookieKeysOf(v.cookie).split(',')
    })
  })
  return { sessions: list, version: VERSION }
}

/* ------------------------------------------------------------------ */
/* 教务系统（EAMS）课表导入                                             */
/* ------------------------------------------------------------------ */

/**
 * 单用户本地服务，教务登录态就一份放内存里。
 * 教务系统的 Cookie 比学习通更敏感（能看成绩、能选课），所以绝不落盘。
 */
const jw = { jar: null, probe: null, base: '', at: 0 }

function jwBase(body) {
  return String((body && body.base) || jw.base || '').trim() || eams.DEFAULT_BASE
}

function jwOut(r) {
  return {
    count: (r.items || []).length,
    items: (r.items || []).map((x) => ({
      day: x.day,
      start: x.start,
      end: x.end,
      name: x.name,
      place: x.place || '',
      weeks: x.weeks || null
    })),
    semesterId: r.semesterId || '',
    semesterName: r.semesterName || '',
    semesters: r.semesters || [],
    termStart: r.termStart || '',
    via: r.via || '',
    tries: r.tries || [],
    message: r.message || ''
  }
}

/** 探测：这台机器能不能进教务系统、登录页要不要验证码 */
async function actJwProbe(body) {
  const base = jwBase(body)
  const jar = new h.CookieJar()
  const p = await eams.probe(base, jar)
  jw.jar = jar
  jw.probe = p
  jw.base = base
  jw.at = Date.now()
  log(
    '教务探测 ' + base + '：可达=' + p.reachable +
      (p.needCaptcha ? ' 需验证码' : '') +
      (p.cas ? ' 仅统一认证' : '') +
      (p.error ? ' 错误=' + p.error : '')
  )
  return {
    reachable: p.reachable,
    base: p.base,
    loginUrl: p.loginUrl,
    needCaptcha: p.needCaptcha,
    cas: p.cas,
    fields: p.fields || {},
    formSnippet: p.formSnippet || '',
    error: p.error,
    hint: p.hint
  }
}

/** 取一张验证码图（base64），前端直接显示 */
async function actJwCaptcha(body) {
  if (!jw.jar || !jw.probe) throw new Error('先点「检测教务系统」，让程序拿到登录页会话')
  const dataUrl = await eams.captchaImage(jw.jar, jw.probe)
  return { img: dataUrl }
}

/** 账号密码登录；有验证码就带上用户填的那串 */
async function actJwLogin(body) {
  const base = jwBase(body)
  if (!jw.probe || jw.probe.base !== base) {
    const jar = new h.CookieJar()
    jw.probe = await eams.probe(base, jar)
    jw.jar = jar
    jw.base = base
  }
  if (!jw.probe.reachable) {
    throw new Error(jw.probe.hint || jw.probe.error || '教务系统不可达')
  }

  const r = await eams.login({
    base,
    username: (body && body.username) || '',
    password: (body && body.password) || '',
    captcha: (body && body.captcha) || '',
    jar: jw.jar,
    p: jw.probe
  })
  jw.jar = r.jar || jw.jar
  jw.at = Date.now()
  log('教务登录 ' + (r.ok ? '成功' : '失败：' + r.message))

  let captchaImg = ''
  if (!r.ok && (r.needCaptcha || jw.probe.needCaptcha)) {
    // 失败一次验证码就废了，顺手换一张新的
    captchaImg = await eams.captchaImage(jw.jar, jw.probe).catch(() => '')
  }
  return {
    ok2: r.ok,
    success: !!r.ok,
    needCaptcha: !!(r.needCaptcha || jw.probe.needCaptcha),
    message: r.message || '',
    captchaImg
  }
}

/** 登录态下抓课表（也供 cookie 模式复用） */
async function runJwSchedule(jar, base, opt) {
  const p = jw.probe && jw.probe.base === base ? jw.probe : { base, prefix: '/eams', reachable: true }
  const r = await eams.fetchTable(jar, p, opt || {})
  log(
    '教务课表：' + (r.ok ? r.via + ' 抓到 ' + r.items.length + ' 节' : '失败 ' + (r.message || '')) +
      (r.tries && r.tries.length ? '｜探测轨迹 ' + r.tries.join(' / ') : '')
  )
  return Object.assign({ success: !!r.ok }, jwOut(r))
}

async function actJwSchedule(body) {
  if (!jw.jar) throw new Error('还没登录教务系统')
  const base = jwBase(body)
  return runJwSchedule(jw.jar, base, {
    semesterId: (body && body.semesterId) || '',
    studentId: (body && body.studentId) || ''
  })
}

/**
 * 一步到位：拿账号密码直接「探测 → 登录 → 抓课表」。
 * 小程序「登录设置」里填一次学号密码，点一下就走这里，用户不用碰电脑上的网页。
 *
 * 有验证码时返回 needCaptcha + captchaImg（base64），小程序显示出来让用户填，
 * 再带着 captcha 调一次。jar 留在 jw 里，所以刷验证码用的是同一个会话。
 */
async function actJwAuto(body) {
  const base = jwBase(body)
  const username = String((body && body.username) || '').trim()
  const password = String((body && body.password) || '')
  const captcha = String((body && body.captcha) || '')
  if (!username || !password) throw new Error('学号和密码都要填')

  // 已经登录过同一个地址就别重复登录了，直接抓（省一次验证码）
  if (jw.jar && jw.base === base && jw.at && Date.now() - jw.at < 30 * 60 * 1000) {
    const r = await runJwSchedule(jw.jar, base, {})
    if (r.success) return Object.assign({ stage: 'cached', loggedIn: true }, r)
  }

  const jar = new h.CookieJar()
  const p = await eams.probe(base, jar)
  jw.jar = jar
  jw.probe = p
  jw.base = base

  if (!p.reachable) {
    return {
      success: false,
      stage: 'probe',
      loggedIn: false,
      needCaptcha: false,
      message: (p.hint || p.error || '教务系统连不上') + ''
    }
  }
  if (p.cas) {
    return {
      success: false,
      stage: 'probe',
      loggedIn: false,
      needCaptcha: false,
      message: '这个入口只支持统一身份认证（要短信验证码），程序代不了。用「Cookie / 源码」那条路。'
    }
  }

  const lg = await eams.login({ base, username, password, captcha, jar, p })
  jw.jar = lg.jar || jar
  jw.at = Date.now()
  log('教务自动登录 ' + username + ' → ' + (lg.ok ? '成功' : '失败：' + lg.message))

  if (!lg.ok) {
    let img = ''
    if (lg.needCaptcha || p.needCaptcha) {
      img = await eams.captchaImage(jw.jar, p).catch(() => '')
    }
    return {
      success: false,
      stage: 'login',
      loggedIn: false,
      needCaptcha: !!(lg.needCaptcha || p.needCaptcha),
      captchaImg: img,
      message: lg.message || '账号或密码没通过'
    }
  }

  const r = await runJwSchedule(jw.jar, base, {})
  return Object.assign({ stage: 'table', loggedIn: true }, r)
}

/** 用 Cookie 抓课表 */
async function actJwCookie(body) {
  const cookie = String((body && body.cookie) || '').trim()
  if (!cookie) throw new Error('Cookie 是空的')
  const base = jwBase(body)
  const jar = new h.CookieJar(cookie)
  const r = await runJwSchedule(jar, base, { semesterId: (body && body.semesterId) || '' })
  if (r.success) {
    jw.jar = jar // 顺手接过来，后面抓别的学期不用重贴
    jw.base = base
    jw.probe = jw.probe || { base, prefix: '/eams', reachable: true }
  }
  return r
}

/** 完全离线：把课表页 HTML 或选中的文字粘进来，直接解析 */
async function actJwParse(body) {
  let html = String((body && body.html) || '')
  let text = String((body && body.text) || '')
  // 粘进来的其实是纯文字（没有标签）时，直接当文本走
  if (!text && html && !/<t[dh]|<div|<p\b|<span/i.test(html)) {
    text = html
    html = ''
  }
  let items = []
  let via = ''
  if (html && /<t[dh]/i.test(html)) {
    items = eams.parseTableHtml(html)
    via = 'HTML'
  }
  if (!items.length && text) {
    items = eams.parseText(text)
    via = '文本'
  }
  log('教务离线解析（' + via + '）：' + items.length + ' 节')
  return Object.assign({}, jwOut({ items }), { success: items.length > 0, via, message: items.length ? '' : '这段内容里没认出课程' })
}

/* ------------------------------------------------------------------ */
/* 统一身份认证（CAS）→ 门户课表                                        */
/* ------------------------------------------------------------------ */

/** 门户登录态：只放内存，不落盘（token 等价于门户里所有权限） */
const casState = { token: '', at: 0, name: '', identity: '', org: '', chain: [] }
const CAS_TTL = 2 * 60 * 60 * 1000 // 门户 session 一般两小时，过期就重登

function casAlive() {
  return !!(casState.token && casState.at && Date.now() - casState.at < CAS_TTL)
}

function casOut(r) {
  // 每条都带原始 JSON 会把响应撑爆（几十条 × 一堆字段），只留结构化的那几个
  const items = (r.items || []).map((it) => ({
    id: it.id,
    day: it.day,
    start: it.start,
    end: it.end,
    name: it.name,
    place: it.place,
    weeks: it.weeks
  }))
  return {
    success: !!r.success,
    count: r.count || 0,
    items,
    range: r.range || null,
    semesterName: r.semesterName || '',
    termStart: r.termStart || '',
    meta: r.meta || null,
    raw: r.raw || undefined,
    message: r.message || '',
    needLogin: !!r.needLogin
  }
}

/** 探测：统一认证 / 门户能不能从这台机器连上（外网应该都能） */
async function actCasProbe() {
  const p = await cas.probe()
  log(
    '统一认证探测：CAS=' + (p.casReachable ? '通' : '不通') +
      ' 门户=' + (p.portalReachable ? '通' : '不通') +
      (p.mfa ? ' 双因子=开(' + p.mfaTypes.join('/') + ')' : '') +
      (p.error ? ' 错误=' + p.error : '')
  )
  return p
}

/**
 * 登录。三种进法：
 *   ① 学号 + 密码（普通情况）
 *   ② 学号 + 密码 + captcha（错 5 次后 CAS 会要图形码）
 *   ③ 只给 CASTGC（浏览器信任过的设备，绕开双因子）
 */
async function actCasLogin(body) {
  const b = body || {}
  const r = await cas.login({
    username: String(b.username || '').trim(),
    password: String(b.password || ''),
    captcha: String(b.captcha || ''),
    tgc: String(b.tgc || b.castgc || '').trim()
  })

  if (!r.success) {
    log('统一认证登录失败：' + (r.error || ''))
    return Object.assign({ loggedIn: false }, r)
  }

  casState.token = r.token
  casState.at = Date.now()
  casState.name = r.name || ''
  casState.identity = r.identity || ''
  casState.org = r.org || ''
  casState.chain = r.chain || []
  log('统一认证登录成功' + (casState.name ? '：' + casState.name : '') + '（' + (r.identity || '未知身份') + '）')

  // 顺手摸一下教学周，拿到就用来校准开学日
  let week = null
  try {
    week = await cas.weekOfTeaching(casState.token)
  } catch (e) {
    week = null
  }

  return {
    success: true,
    loggedIn: true,
    name: casState.name,
    identity: casState.identity,
    org: casState.org,
    week,
    chain: casState.chain
  }
}

/** 拉课表：有 token 就直接拉 */
async function actCasSchedule(body) {
  const b = body || {}
  if (!casAlive()) {
    return { success: false, needLogin: true, message: '门户登录态没了，重新登录一次', items: [] }
  }
  const r = await cas.fetchSchedule({
    token: casState.token,
    from: b.from || '',
    to: b.to || ''
  })
  log('门户课表：' + (r.success ? r.count + ' 节（' + (r.range ? r.range.from + '~' + r.range.to : '') + '）' : '失败 ' + (r.message || r.error || '')))
  return casOut(r)
}

/** 一步到位：登录 + 拉课表（小程序点一下就走完） */
async function actCasAuto(body) {
  const b = body || {}
  const hasCred = !!(String(b.username || '').trim() && String(b.password || '')) || !!String(b.tgc || '').trim()

  if (!casAlive() && hasCred) {
    const lg = await actCasLogin(b)
    if (!lg.success) return Object.assign({ stage: 'login' }, lg)
  }
  if (!casAlive()) {
    return { success: false, stage: 'login', needLogin: true, loggedIn: false, items: [], message: '还没登录统一身份认证' }
  }
  const r = await actCasSchedule(b)
  return Object.assign({ stage: 'table', loggedIn: true }, r)
}

/* ------------------------------------------------------------------ */
/* HTTP 层                                                            */
/* ------------------------------------------------------------------ */

const ROUTES = {
  '/ping': { method: 'GET', run: async () => ({ pong: true, version: VERSION }) },
  '/status': { method: 'GET', run: actStatus },
  '/cx/qr/start': { method: 'POST', run: actQrStart },
  '/cx/qr/poll': { method: 'POST', run: actQrPoll },
  '/cx/courses': { method: 'POST', run: actCourses },
  '/cx/sync': { method: 'POST', run: actSync },
  /* U校园 扫码（websocket 长连接，只能在本地跑） */
  '/up/qr/start': { method: 'POST', run: async () => unipusQr.start() },
  '/up/qr/poll': {
    method: 'POST',
    run: async (body) => {
      if (!body || !body.token) return { state: 'expired', message: '缺少 token' }
      return unipusQr.poll(String(body.token))
    }
  },
  /* 教务系统（EAMS）课表导入 */
  '/jw/probe': { method: 'POST', run: actJwProbe },
  '/jw/captcha': { method: 'POST', run: actJwCaptcha },
  '/jw/login': { method: 'POST', run: actJwLogin },
  '/jw/auto': { method: 'POST', run: actJwAuto },
  '/jw/schedule': { method: 'POST', run: actJwSchedule },
  '/jw/cookie': { method: 'POST', run: actJwCookie },
  '/jw/parse': { method: 'POST', run: actJwParse },
  '/jw/status': {
    method: 'GET',
    run: async () => ({
      loggedIn: !!(jw.jar && jw.at && Date.now() - jw.at < 30 * 60 * 1000),
      base: jw.base || '',
      at: jw.at || 0,
      needCaptcha: !!(jw.probe && jw.probe.needCaptcha)
    })
  },
  '/jw/logout': {
    method: 'POST',
    run: async () => {
      jw.jar = null
      jw.probe = null
      jw.at = 0
      log('教务登录态已清除')
      return { cleared: true }
    }
  },
  /* 统一身份认证 → 门户课表（外网可用） */
  '/cas/probe': { method: 'POST', run: actCasProbe },
  '/cas/captcha': {
    method: 'POST',
    run: async () => ({ img: await cas.captchaImage() })
  },
  '/cas/login': { method: 'POST', run: actCasLogin },
  '/cas/auto': { method: 'POST', run: actCasAuto },
  '/cas/schedule': { method: 'POST', run: actCasSchedule },
  '/cas/status': {
    method: 'GET',
    run: async () => ({
      loggedIn: casAlive(),
      name: casState.name,
      identity: casState.identity,
      org: casState.org,
      at: casState.at || 0,
      ttl: CAS_TTL
    })
  },
  '/cas/logout': {
    method: 'POST',
    run: async () => {
      casState.token = ''
      casState.at = 0
      casState.name = ''
      casState.identity = ''
      casState.org = ''
      log('门户登录态已清除')
      return { cleared: true }
    }
  }
}

function log(msg) {
  const d = new Date()
  const t = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
  console.log('[' + t + '] ' + msg)
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 2 * 1024 * 1024) req.destroy()
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (e) {
        resolve({ _raw: raw })
      }
    })
    req.on('error', () => resolve({}))
  })
}

function send(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Local-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function lanIps() {
  const out = []
  const nets = os.networkInterfaces()
  Object.keys(nets).forEach((name) => {
    ;(nets[name] || []).forEach((n) => {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address)
    })
  })
  return out
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://' + (req.headers.host || 'localhost'))
  const pathname = parsed.pathname

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Local-Key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    })
    return res.end()
  }

  // 浏览器控制台
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(CONSOLE_HTML)
  }

  const route = ROUTES[pathname]
  if (!route) return send(res, 404, { ok: false, error: '没有这个接口：' + pathname })

  // 可选口令
  if (KEY && req.headers['x-local-key'] !== KEY) {
    return send(res, 401, { ok: false, error: '本机口令不对（启动时设置过 CX_KEY）' })
  }

  const body = req.method === 'POST' ? await readBody(req) : {}
  try {
    const data = await route.run(body)
    send(res, 200, Object.assign({ ok: true }, data))
  } catch (e) {
    const msg = (e && e.message) || String(e)
    log('接口 ' + pathname + ' 失败：' + msg)
    send(res, 200, { ok: false, error: msg })
  }
})

/* ------------------------------------------------------------------ */

loadSessions()

server.listen(PORT, HOST, () => {
  const ips = lanIps()
  console.log('')
  console.log('  学习通本地代理  v' + VERSION)
  console.log('  ─────────────────────────────────────────────')
  console.log('  控制台    http://127.0.0.1:' + PORT + '/')
  console.log('  小程序    http://127.0.0.1:' + PORT + '  （开发者工具）')
  if (!LOCAL_ONLY && ips.length) {
    ips.forEach((ip) => console.log('  真机      http://' + ip + ':' + PORT + '  （手机需同一 WiFi）'))
  }
  if (KEY) console.log('  口令      ' + KEY)
  console.log('  ─────────────────────────────────────────────')
  console.log('  登录态只存在本机，不经过云端。用完按 Ctrl+C 关闭。')
  console.log('')
  console.log('  ▶ 现在用浏览器打开上面那个「控制台」地址，可以在网页里直接扫码。')
  console.log('')
})

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('\n端口 ' + PORT + ' 被占用了。')
    console.error('  如果浏览器能打开 http://127.0.0.1:' + PORT + '/ ，说明代理已经在跑，不用重复启动。')
    console.error('  否则换个端口：node localserver/server.js 7799\n')
  } else {
    console.error('\n启动失败：' + e.message + '\n')
  }
  process.exit(1)
})

/* ------------------------------------------------------------------ */
/* 浏览器控制台（纯静态，不依赖构建工具）                               */
/* ------------------------------------------------------------------ */

const CONSOLE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>学习通本地代理</title>
<style>
  :root{
    --bg:#f6f7f9; --panel:#fff; --line:#e6e8eb; --text:#1a1d21; --dim:#6b7280;
    --brand:#2f6fed; --ok:#12a150; --warn:#d97706; --err:#dc2626;
  }
  @media (prefers-color-scheme:dark){
    :root{ --bg:#15171a; --panel:#1d2024; --line:#2b3036; --text:#e8eaed; --dim:#9aa3ad;
           --brand:#5b8ff9; --ok:#31c27c; --warn:#e5a13a; --err:#f0706b; }
  }
  *{box-sizing:border-box}
  body{margin:0;padding:24px 16px 60px;background:var(--bg);color:var(--text);
       font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:820px;margin:0 auto}
  h1{font-size:19px;margin:0 0 4px;font-weight:650}
  .sub{color:var(--dim);font-size:13px;margin-bottom:20px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:14px}
  .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  button{font:inherit;padding:9px 16px;border-radius:9px;border:1px solid var(--line);
         background:var(--panel);color:var(--text);cursor:pointer;transition:.15s}
  button:hover:not(:disabled){border-color:var(--brand);color:var(--brand)}
  button:disabled{opacity:.45;cursor:not-allowed}
  button.primary{background:var(--brand);border-color:var(--brand);color:#fff}
  button.primary:hover:not(:disabled){filter:brightness(1.08);color:#fff}
  .qrbox{display:none;text-align:center;margin-top:16px}
  .qrbox img{width:200px;height:200px;border:1px solid var(--line);border-radius:10px;background:#fff}
  .state{font-size:13px;color:var(--dim);margin-top:10px;min-height:20px}
  .state.ok{color:var(--ok)} .state.err{color:var(--err)} .state.warn{color:var(--warn)}
  pre{background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:12px;
      overflow:auto;max-height:340px;font-size:12.5px;line-height:1.55;margin:10px 0 0;
      white-space:pre-wrap;word-break:break-word}
  .tag{display:inline-block;font-size:12px;padding:2px 8px;border-radius:20px;
       border:1px solid var(--line);color:var(--dim);margin-right:6px}
  .tag.on{color:var(--ok);border-color:var(--ok)}
  h2{font-size:14px;margin:0 0 10px;font-weight:600}
  .hint{font-size:12.5px;color:var(--dim);margin-top:8px}
  input,textarea{font:inherit;font-size:14px;padding:9px 12px;border-radius:9px;
                 border:1px solid var(--line);background:var(--bg);color:var(--text);width:100%}
  input{flex:1;min-width:110px}
  textarea{height:76px;margin-top:10px;font-size:12.5px;line-height:1.5;resize:vertical;
           font-family:ui-monospace,Menlo,Consolas,monospace}
  #jwCap,#casCap{height:40px;width:110px;border:1px solid var(--line);border-radius:6px;
         background:#fff;cursor:pointer;object-fit:contain}
  details summary{outline:none}
  .badge{display:inline-block;font-size:11.5px;padding:1px 7px;border-radius:6px;
         background:var(--bg);border:1px solid var(--line);color:var(--dim);margin-left:6px}
</style>
</head>
<body>
<div class="wrap">
  <h1>学习通本地代理</h1>
  <div class="sub">登录态只存在这台电脑上，不经过云端。用它自己的网络出口访问学习通。</div>

  <div class="card">
    <h2>1. 扫码登录</h2>
    <div class="row">
      <button class="primary" id="btnQr">生成二维码</button>
      <button id="btnStatus">查看会话</button>
      <span id="liveTag" class="tag">未登录</span>
    </div>
    <div class="qrbox" id="qrbox">
      <img id="qrimg" alt="二维码">
      <div class="state" id="qrstate">请用学习通 App 扫码</div>
    </div>
  </div>

  <div class="card">
    <h2>2. 验证链路（先测这个，只抓课程列表，几秒钟）</h2>
    <div class="row">
      <button class="primary" id="btnCourses">抓课程列表</button>
      <button id="btnSync">抓全部任务</button>
    </div>
    <div class="hint">如果「抓课程列表」能返回课程，说明登录态被超星认可，链路就通了。</div>
    <pre id="out" style="display:none"></pre>
  </div>

  <div class="card">
    <h2>3. 统一身份认证 → 门户课表<span class="badge">外网可用</span></h2>
    <div class="hint">
      学校教务系统（jw.v.zzu.edu.cn）公网进不去，但统一身份认证和综合信息门户是公网可用的，
      门户的「我的日程」里已经有教务同步过来的课表。所以这条路在宿舍、家里、手机流量下都能跑。
      登录态只留在这台电脑的内存里，关掉窗口就没了。
    </div>
    <div class="row" style="margin-top:12px">
      <input id="casUser" placeholder="学号，例如 202515020339">
      <input id="casPass" type="password" placeholder="统一身份认证密码">
    </div>
    <div class="row" id="casCapRow" style="display:none;margin-top:10px">
      <img id="casCap" alt="验证码" title="看不清点一下换一张">
      <input id="casCapInput" placeholder="看图填验证码" style="flex:0 0 150px">
    </div>
    <div class="row" style="margin-top:12px">
      <button class="primary" id="btnCasLogin">登录并抓课表</button>
      <button id="btnCasProbe">先测连通</button>
      <span class="state" id="casState" style="margin:0"></span>
    </div>

    <details style="margin-top:14px">
      <summary>被短信验证码拦住？用这条法（一次管 14 天）</summary>
      <div class="hint">
        学校开了双因子：新设备第一次登录会要短信码。在自己浏览器里登录一次并勾「记住我」，
        然后 F12 → Application → Cookies → <b>cas.s.zzu.edu.cn</b> → 复制 <b>CASTGC</b> 的值贴到下面。
        有了它就不用密码、不碰短信，直接换课表。
      </div>
      <textarea id="casTgc" placeholder="粘贴 CASTGC 的值（一长串，通常 TGT- 开头）"></textarea>
      <div class="row"><button id="btnCasTgc">用 CASTGC 登录并抓课表</button></div>
    </details>

    <div class="row" style="margin-top:14px">
      <button id="btnCasCopy" disabled>复制导入文本 → 粘到小程序</button>
      <span class="hint" style="margin:0">小程序「课表 → 🏫 教务导入」一键拉也行</span>
    </div>

    <pre id="casOut" style="display:none"></pre>
  </div>

  <div class="card">
    <h2>4. 教务系统直连<span class="badge">郑州大学 · EAMS · 仅校园网</span></h2>
    <div class="hint">教务系统一般只对校园网开放，先连 ZZU-WLAN 或学校 VPN。登录态只留在这台电脑的内存里，不落盘、不上云。</div>
    <div class="row" style="margin-top:12px">
      <input id="jwBase" value="https://jw.v.zzu.edu.cn" placeholder="教务系统地址">
      <button id="btnJwProbe" style="flex:0 0 auto">检测教务系统</button>
    </div>

    <div class="row" style="margin-top:10px">
      <input id="jwUser" placeholder="学号">
      <input id="jwPass" type="password" placeholder="密码">
    </div>
    <div class="row" id="jwCapRow" style="display:none;margin-top:10px">
      <img id="jwCap" alt="验证码" title="看不清点一下换一张">
      <input id="jwCapInput" placeholder="看图填验证码" style="flex:0 0 150px">
    </div>
    <div class="row" style="margin-top:12px">
      <button class="primary" id="btnJwLogin">登录并抓课表</button>
      <span class="state" id="jwState" style="margin:0"></span>
    </div>

    <details style="margin-top:14px">
      <summary>登录不上？走这两条兜底路</summary>
      <div class="hint">① <b>Cookie</b>：浏览器里正常登录教务系统 → F12 → Network → 随便点一个请求 → 复制 Request Headers 里的 Cookie 整串。</div>
      <textarea id="jwCookie" placeholder="粘贴 Cookie 整串，例如 JSESSIONID=xxx; route=yyy"></textarea>
      <div class="row"><button id="btnJwCookie">用 Cookie 抓课表</button></div>
      <div class="hint">② <b>源码</b>：浏览器里打开课表页 → 右键「查看网页源代码」→ Ctrl+A Ctrl+C → 粘到下面。完全离线解析，不经过网络。</div>
      <textarea id="jwHtml" placeholder="粘贴课表页 HTML 源码，或者从页面上选中的文字"></textarea>
      <div class="row"><button id="btnJwParse">离线解析这段</button></div>
    </details>

    <div class="row" style="margin-top:14px">
      <button id="btnJwCopy" disabled>复制导入文本 → 粘到小程序</button>
      <span class="hint" style="margin:0">小程序「课表 → 导入课表」把它粘进去就行，格式一样</span>
    </div>

    <pre id="jwOut" style="display:none"></pre>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id)
let timer = null

function show(text, cls) {
  const out = $('out')
  out.style.display = 'block'
  out.textContent = typeof text === 'string' ? text : JSON.stringify(text, null, 2)
  out.className = cls || ''
}
function setState(text, cls) {
  const el = $('qrstate')
  el.textContent = text
  el.className = 'state ' + (cls || '')
}

async function api(path, body) {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  return r.json()
}

$('btnQr').onclick = async () => {
  clearInterval(timer)
  $('btnQr').disabled = true
  if (timer) clearInterval(timer)
  $('qrbox').style.display = 'block'
  setState('正在生成二维码…')
  try {
    const r = await api('/cx/qr/start', {})
    if (!r.ok) throw new Error(r.error)
    $('qrimg').src = r.qr
    setState('请用学习通 App 扫码')
    pollLoop(r.token)
  } catch (e) {
    setState('生成失败：' + e.message, 'err')
    $('btnQr').disabled = false
  }
}

function pollLoop(token) {
  let tries = 0
  timer = setInterval(async () => {
    tries++
    if (tries > 80) {
      clearInterval(timer)
      setState('超时了，点「生成二维码」重来', 'err')
      $('btnQr').disabled = false
      return
    }
    try {
      const r = await api('/cx/qr/poll', { token })
      if (!r.ok) throw new Error(r.error)
      if (r.state === 'scanned') setState('已扫码，请在手机上点「确认登录」', 'warn')
      else if (r.state === 'expired' || r.state === 'error') {
        clearInterval(timer)
        setState(r.message || '二维码失效', 'err')
        $('btnQr').disabled = false
      } else if (r.state === 'ok') {
        clearInterval(timer)
        $('btnQr').disabled = false
        $('liveTag').textContent = '已登录 ' + (r.nickname || '')
        $('liveTag').className = 'tag on'
        setState('登录成功（字段：' + (r.keys || []).join(',') + '）', 'ok')
        show({ 登录成功: true, 昵称: r.nickname, 字段: r.keys })
      }
    } catch (e) {
      /* 单次轮询失败不打断 */
    }
  }, 2500)
}

$('btnStatus').onclick = async () => {
  try {
    const r = await api('/status')
    if (!r.ok) throw new Error(r.error)
    if (!r.sessions.length) {
      $('liveTag').textContent = '未登录'
      $('liveTag').className = 'tag'
    } else {
      $('liveTag').textContent = '已登录 ' + (r.sessions[0].nickname || '')
      $('liveTag').className = 'tag on'
    }
    show(r)
  } catch (e) {
    show('失败：' + e.message)
  }
}

$('btnCourses').onclick = async () => {
  $('btnCourses').disabled = true
  show('正在抓课程列表…')
  try {
    const r = await api('/cx/courses', {})
    if (!r.ok) throw new Error(r.error)
    let text = '课程数：' + r.count + '\\n登录态存活：' + r.alive +
               '\\nCookie 字段：' + r.cookieKeys + '\\n轨迹：' + r.trace + '\\n\\n'
    if (r.count) text += r.courses.map((c,i) => (i+1) + '. ' + c.name + '  [' + c.courseId + ']').join('\\n')
    show(text)
  } catch (e) {
    show('失败：' + e.message)
  }
  $('btnCourses').disabled = false
}

$('btnSync').onclick = async () => {
  $('btnSync').disabled = true
  show('正在抓全部任务，可能要几十秒…')
  try {
    const r = await api('/cx/sync', {})
    if (!r.ok) throw new Error(r.error)
    const todo = r.tasks.filter(t => t.status !== 'done')
    let text = '共 ' + r.count + ' 项，其中未完成 ' + todo.length + ' 项\\n\\n'
    text += todo.slice(0, 40).map(t => '· [' + (t.courseName||'') + '] ' + t.title).join('\\n')
    if (todo.length > 40) text += '\\n…还有 ' + (todo.length - 40) + ' 项'
    text += '\\n\\n抓取明细：\\n' + (r.debug || []).join('\\n')
    show(text)
  } catch (e) {
    show('失败：' + e.message)
  }
  $('btnSync').disabled = false
}

/* ---------------- 教务课表 ---------------- */

const DAY_CN = ['一', '二', '三', '四', '五', '六', '日']
let jwLast = null

function jwShow(text, cls) {
  const el = $('jwOut')
  el.style.display = 'block'
  el.textContent = typeof text === 'string' ? text : JSON.stringify(text, null, 2)
  el.className = cls || ''
}
function jwState(text, cls) {
  const el = $('jwState')
  el.textContent = text
  el.className = 'state ' + (cls || '')
}
function jwWeeks(w) {
  if (!w) return '每周'
  const body = w.from === w.to ? w.from + '周' : w.from + '-' + w.to + '周'
  return body + (w.parity === 1 ? '(单)' : w.parity === 2 ? '(双)' : '')
}
function renderJw(r) {
  jwLast = r && r.items && r.items.length ? r : null
  $('btnJwCopy').disabled = !jwLast
  if (!r.success) {
    let t = '没抓到：' + (r.message || '未知原因') + '\\n'
    if (r.tries && r.tries.length) t += '\\n探测轨迹：\\n' + r.tries.map(x => '· ' + x).join('\\n')
    return t
  }
  let t = '学期    ' + (r.semesterName || '(没识别出来，用当前学期)') + '\\n'
  t += '开学日  ' + (r.termStart || '(页面里没写，导入后在小程序里设一次)') + '\\n'
  t += '接口    ' + r.via + '\\n'
  t += '结果    ' + r.count + ' 节\\n\\n'
  t += r.items.slice(0, 60).map(it =>
    '周' + DAY_CN[it.day - 1] + ' ' + it.start + '-' + it.end + '节  ' +
    it.name + (it.place ? '  @' + it.place : '') + '  [' + jwWeeks(it.weeks) + ']'
  ).join('\\n')
  if (r.count > 60) t += '\\n…还有 ' + (r.count - 60) + ' 节'
  return t
}

/* ---------------- 统一身份认证 → 门户课表 ---------------- */

let casLast = null

function casShow(text) {
  const el = $('casOut')
  el.style.display = 'block'
  el.textContent = typeof text === 'string' ? text : JSON.stringify(text, null, 2)
}
function casState(text, cls) {
  const el = $('casState')
  el.textContent = text
  el.className = 'state ' + (cls || '')
}
function casWeeks(w) {
  if (!w) return '每周'
  const body = w.from === w.to ? w.from + '周' : w.from + '-' + w.to + '周'
  const odd = w.odd || w.parity === 1
  const even = w.even || w.parity === 2
  return body + (odd ? '(单)' : even ? '(双)' : '')
}
function renderCas(r) {
  casLast = r && r.items && r.items.length ? r : null
  $('btnCasCopy').disabled = !casLast
  if (!r.success) {
    let t = '没抓到：' + (r.message || r.error || '未知原因') + '\\n'
    if (r.range) t += '\\n取数范围：' + r.range.from + ' ~ ' + r.range.to + '\\n'
    if (r.raw) t += '\\n门户原样返回（发我看，我照着补字段）：\\n' + JSON.stringify(r.raw, null, 2).slice(0, 4000)
    if (r.meta && r.meta.sampleKeys && r.meta.sampleKeys.length) {
      t += '\\n\\n第一条的字段名：' + r.meta.sampleKeys.join(', ')
    }
    return t
  }
  let t = '学期    ' + (r.semesterName || '(默认按当前学期)') + '\\n'
  t += '范围    ' + (r.range ? r.range.from + ' ~ ' + r.range.to : '') + '\\n'
  t += '结果    ' + r.count + ' 节\\n\\n'
  t += r.items.slice(0, 60).map(it =>
    '周' + DAY_CN[it.day - 1] + ' ' + it.start + '-' + it.end + '节  ' +
    it.name + (it.place ? '  @' + it.place : '') + '  [' + casWeeks(it.weeks) + ']'
  ).join('\\n')
  if (r.count > 60) t += '\\n…还有 ' + (r.count - 60) + ' 节'
  return t
}

async function loadCasCap() {
  try {
    const r = await api('/cas/captcha', {})
    if (r.ok && r.img) {
      $('casCap').src = r.img
      $('casCapRow').style.display = 'flex'
    }
  } catch (e) { /* 没图就算了 */ }
}
$('casCap').onclick = () => loadCasCap()

async function doCasLogin(payload) {
  const btn = $('btnCasLogin')
  btn.disabled = true
  casState('正在登录统一认证…（要连跳几下手，十几秒）')
  try {
    const r = await api('/cas/auto', payload)
    if (!r.ok) {
      casState('出错了', 'err')
      casShow(r.error || '未知错误')
      return
    }
    if (r.needCaptcha) {
      if (r.captchaImg) {
        $('casCap').src = r.captchaImg
        $('casCapRow').style.display = 'flex'
      } else {
        await loadCasCap()
      }
      casState('填一下验证码', '')
      casShow(
        (r.error || '') + '\n\n' +
          '统一认证每次登录都要图形验证码：照着图填进去，直接再点「登录并抓课表」。\n' +
          '登录态会一直留到代理关掉为止，不用反复填。'
      )
      return
    }
    if (r.needMfa) {
      casState('被双因子拦住了', 'err')
      casShow((r.error || '') + '\\n\\n' + (r.hint || ''))
      return
    }
    if (!r.success) {
      casState('没成功', 'err')
      casShow(renderCas(r))
      return
    }
    casState('已抓到 ' + (r.count || 0) + ' 节' + (r.name ? '（' + r.name + '）' : ''), 'ok')
    casShow(renderCas(r))
  } catch (e) {
    casState('出错了', 'err')
    casShow(String((e && e.message) || e))
  } finally {
    btn.disabled = false
  }
}

$('btnCasLogin').onclick = () =>
  doCasLogin({
    username: $('casUser').value.trim(),
    password: $('casPass').value,
    captcha: $('casCapInput').value.trim()
  })

$('btnCasTgc').onclick = () => {
  const tgc = $('casTgc').value.trim()
  if (!tgc) {
    casState('先粘 CASTGC', 'err')
    return
  }
  doCasLogin({ tgc })
}

$('btnCasProbe').onclick = async () => {
  const btn = $('btnCasProbe')
  btn.disabled = true
  casState('正在探测…')
  try {
    const r = await api('/cas/probe', {})
    if (!r.ok) throw new Error(r.error || '探测失败')
    casState(r.casReachable && r.portalReachable ? '都通' : '有不通的', r.casReachable && r.portalReachable ? 'ok' : 'err')
    casShow(
      '统一认证  ' + (r.casReachable ? '通' : '不通') + '\\n' +
      '门户接口  ' + (r.portalReachable ? '通' : '不通') + '\\n' +
      '双因子    ' + (r.mfa ? '开（' + r.mfaTypes.join(' / ') + '）' : '关') + '\\n' +
      '图形码    ' + (r.needCaptcha ? '这次要' : '不要') + '\\n\\n' +
      (r.hint || r.error || '')
    )
  } catch (e) {
    casState('探测失败', 'err')
    casShow(String((e && e.message) || e))
  } finally {
    btn.disabled = false
  }
}

$('btnCasCopy').onclick = async () => {
  if (!casLast) return
  const text = casLast.items.map(it => {
    const w = casWeeks(it.weeks)
    return '周' + DAY_CN[it.day - 1] + ' ' + it.start + '-' + it.end + '节 ' + it.name +
      (it.place ? ' ' + it.place : '') + ' ' + (w === '每周' ? '' : w)
  }).join('\\n')
  try {
    await navigator.clipboard.writeText(text)
    casState('已复制 ' + casLast.items.length + ' 节', 'ok')
    casShow('去小程序「课表 → 粘贴导入」粘进去：\\n\\n' + text)
  } catch (e) {
    casShow(text)
    casState('浏览器不让自动复制，手动选中下面这段', 'err')
  }
}

async function loadJwCap() {
  try {
    const r = await api('/jw/captcha', {})
    if (r.ok && r.img) {
      $('jwCap').src = r.img
      $('jwCapRow').style.display = 'flex'
    }
  } catch (e) { /* 没图就算了，可能是这个版本没有验证码 */ }
}

$('jwCap').onclick = () => loadJwCap()

$('btnJwProbe').onclick = async () => {
  const btn = $('btnJwProbe')
  btn.disabled = true
  jwState('正在探测…（连不上会等十几秒）')
  try {
    const r = await api('/jw/probe', { base: $('jwBase').value.trim() })
    if (!r.ok) throw new Error(r.error)
    if (!r.reachable) {
      jwState('进不去教务系统', 'err')
      jwShow('地址  ' + r.base + '\\n错误  ' + (r.error || '') + '\\n\\n' + (r.hint || ''))
      return
    }
    jwState('能连上' + (r.needCaptcha ? '，有验证码' : '') + (r.cas ? '，只支持统一认证' : ''), 'ok')
    let t = '登录页  ' + r.loginUrl + '\\n'
    t += '验证码  ' + (r.needCaptcha ? '需要，登录时会把图显示出来' : '不需要') + '\\n'
    t += '认证    ' + (r.cas ? '只走统一身份认证（程序代不了短信验证码）' : '有本地账号表单，可以自动登录') + '\\n'
    const f = r.fields || {}
    t += '表单    ' + (f.username || '?') + ' / ' + (f.password || '?') +
         (r.needCaptcha ? ' / ' + (f.captcha || '?') : '') + (f.md5 ? '（密码走 MD5）' : '') + '\\n'
    if (r.formSnippet) t += '\\n登录表单原文（字段识别不准时看这个）：\\n' + r.formSnippet
    jwShow(t)
    if (r.needCaptcha) loadJwCap()
  } catch (e) {
    jwState('探测失败', 'err')
    jwShow('失败：' + e.message)
  }
  btn.disabled = false
}

$('btnJwLogin').onclick = async () => {
  const btn = $('btnJwLogin')
  const base = $('jwBase').value.trim()
  const username = $('jwUser').value.trim()
  const password = $('jwPass').value
  const captcha = $('jwCapInput').value.trim()
  if (!username || !password) {
    jwState('学号、密码都要填', 'err')
    return
  }
  btn.disabled = true
  jwState('登录中…')
  try {
    const r = await api('/jw/login', { base, username, password, captcha })
    if (!r.ok) throw new Error(r.error)
    if (!r.success) {
      jwState(r.message || '登录没通过', 'err')
      if (r.captchaImg) {
        $('jwCap').src = r.captchaImg
        $('jwCapRow').style.display = 'flex'
        $('jwCapInput').value = ''
      }
      jwShow('登录没通过：' + (r.message || '账号密码或验证码不对') +
             '\\n\\n还可以试：展开下面的兜底区，用 Cookie 或直接粘课表页源码。')
      return
    }
    jwState('登录成功，正在抓课表…', 'ok')
    const s = await api('/jw/schedule', { base })
    if (!s.ok) throw new Error(s.error)
    jwState(s.success ? '抓到 ' + s.count + ' 节' : '登录成功，但课表结构没认出来', s.success ? 'ok' : 'warn')
    jwShow(renderJw(s))
  } catch (e) {
    jwState('出错了', 'err')
    jwShow('失败：' + e.message)
  }
  btn.disabled = false
}

$('btnJwCookie').onclick = async () => {
  const btn = $('btnJwCookie')
  const cookie = $('jwCookie').value.trim()
  if (!cookie) { jwShow('先把 Cookie 粘进来'); return }
  btn.disabled = true
  jwState('用 Cookie 抓课表…')
  try {
    const r = await api('/jw/cookie', { base: $('jwBase').value.trim(), cookie })
    if (!r.ok) throw new Error(r.error)
    jwState(r.success ? '抓到 ' + r.count + ' 节' : 'Cookie 没被认', r.success ? 'ok' : 'warn')
    jwShow(renderJw(r))
  } catch (e) {
    jwShow('失败：' + e.message)
  }
  btn.disabled = false
}

$('btnJwParse').onclick = async () => {
  const btn = $('btnJwParse')
  const html = $('jwHtml').value
  if (!html.trim()) { jwShow('先粘点东西进来'); return }
  btn.disabled = true
  try {
    const r = await api('/jw/parse', { html })
    if (!r.ok) throw new Error(r.error)
    jwState(r.success ? '离线解析出 ' + r.count + ' 节' : '这段里没认出课', r.success ? 'ok' : 'warn')
    jwShow(renderJw(r))
  } catch (e) {
    jwShow('失败：' + e.message)
  }
  btn.disabled = false
}

$('btnJwCopy').onclick = async () => {
  if (!jwLast) return
  const text = jwLast.items.map(it => {
    const w = it.weeks
      ? (it.weeks.from === it.weeks.to ? it.weeks.from + '周' : it.weeks.from + '-' + it.weeks.to + '周') +
        (it.weeks.parity === 1 ? '(单)' : it.weeks.parity === 2 ? '(双)' : '')
      : ''
    return '周' + DAY_CN[it.day - 1] + ' ' + it.start + '-' + it.end + '节 ' + it.name +
           (it.place ? ' ' + it.place : '') + (w ? ' ' + w : '')
  }).join('\\n')
  try {
    await navigator.clipboard.writeText(text)
    jwShow('已复制 ' + jwLast.items.length + ' 节。去小程序「课表 → 导入课表」粘贴即可。\\n\\n' + text)
  } catch (e) {
    jwShow('浏览器不让自动复制，下面这段手动全选复制：\\n\\n' + text)
  }
}

$('btnStatus').click()
</script>
</body>
</html>`
