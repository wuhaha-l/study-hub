/**
 * 希冀平台「校园内网直连」客户端。
 *
 * 为什么不在云函数里做：
 *   学校内网地址（如 http://10.67.4.14）是 RFC1918 私有地址，
 *   腾讯云机房的云函数永远访问不到它。只有连在校园网里的手机才能连。
 *   所以这个平台的抓取必须在客户端完成，抓完再把结果推给云端存库。
 *
 * 登录方式：学号 + 密码 + 验证码（不需要用户去浏览器复制 Cookie）
 *
 *   早先的版本让你把浏览器里的 Cookie 整串粘进来，说是因为「wx.request 拿不到
 *   Set-Cookie」——那个说法是错的。小程序确实不会自动保存 Cookie，但
 *   `res.header['Set-Cookie']` 是能读到的，只要自己存下来、后续请求手动带上
 *   就行。所以现在改成：
 *
 *     1. GET /                     → 服务器下发 educg_session
 *     2. GET /cgjiaoyan            → 验证码图片（绑定在上面那个会话上）
 *     3. POST /login/loginproc.jsp → 学号 + 加密后的密码 + 验证码
 *     4. 之后所有请求带上 educg_session
 *
 *   密码不是明文提交的：页面里的 CryptoJS 会先 AES-128-ECB 加密再提交
 *   （key = 'Client8Sess!06ID'，见 utils/aes.js），这里做同样的事。
 *
 * 使用前提：
 *   1. 手机/电脑连着校园网（或学校 VPN）
 *   2. 绕过微信的「合法域名」校验（因为用的是 http + IP，不在白名单里）：
 *      - 电脑开发者工具：详情 → 本地设置 → 勾选「不校验合法域名…」
 *      - 手机真机：右上角「···」→「开发调试」打开调试模式
 *        （只有开发版 / 体验版能开，正式版打不开，这是微信的限制）
 *      小程序启动时不会再自动开调试（那样所有人右下角都挂个 vConsole），
 *      改成用户第一次点「登录」时弹一次「在哪开」的引导，见 pages/accounts。
 */

const api = require('./api')
const SEM = require('./semester')
const AES = require('./aes')

const KEY = 'educoder'
// 直连模块的构建号：卡片上会显示，用来分辨「手机上跑的是不是刚编译的这一版」
const BUILD = '20261028.15'
const CFG_KEY = 'edu_intranet_cfg'
const DEFAULT_BASE = 'http://10.67.4.14'
const AES_KEY = 'Client8Sess!06ID'
const LOGIN_PATH = '/login/loginproc.jsp'
const CAPTCHA_PATH = '/cgjiaoyan'
/** 登录状态看这个页面：未登录时它会把登录表单吐回来 */
const HOME_PATHS = ['/indexcs/simple.jsp', '/index.jsp', '/']
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/* ---------------- 密码混淆（不是加密，只是别让密码明文躺在 storage 里） ---------------- */

const XOR = 'studyhub-edu'

function mask(s) {
  const src = String(s || '')
  let out = ''
  for (let i = 0; i < src.length; i++) {
    out += String.fromCharCode(src.charCodeAt(i) ^ XOR.charCodeAt(i % XOR.length))
  }
  try {
    return AES.base64(new Uint8Array(Array.from(out).map((c) => c.charCodeAt(0) & 0xff)))
  } catch (e) {
    return out
  }
}

function unmask(s) {
  const raw = String(s || '')
  let buf = raw
  try {
    const arr = base64ToBytes(raw)
    if (arr.length) {
      let str = ''
      for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i])
      buf = str
    }
  } catch (e) {
    buf = raw
  }
  let out = ''
  for (let i = 0; i < buf.length; i++) {
    out += String.fromCharCode(buf.charCodeAt(i) ^ XOR.charCodeAt(i % XOR.length))
  }
  return out
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64ToBytes(str) {
  const s = String(str || '').replace(/[^A-Za-z0-9+/]/g, '')
  const out = []
  for (let i = 0; i < s.length; i += 4) {
    const n =
      (B64.indexOf(s[i]) << 18) |
      (B64.indexOf(s[i + 1]) << 12) |
      ((B64.indexOf(s[i + 2]) & 63) << 6) |
      (B64.indexOf(s[i + 3]) & 63)
    out.push((n >> 16) & 0xff)
    if (s[i + 2] !== undefined && s[i + 2] !== '') out.push((n >> 8) & 0xff)
    if (s[i + 3] !== undefined && s[i + 3] !== '') out.push(n & 0xff)
  }
  return new Uint8Array(out)
}

/* ---------------- 配置（只存本机，不传云端） ---------------- */

function getCfg() {
  let c = {}
  try {
    c = wx.getStorageSync(CFG_KEY) || {}
  } catch (e) {
    c = {}
  }
  return {
    base: String(c.base || DEFAULT_BASE).replace(/\/+$/, ''),
    cookie: c.cookie || '',
    stid: c.stid || '',
    password: unmask(c.pw || ''),
    loginAt: c.loginAt || 0,
    lastSync: c.lastSync || 0
  }
}

function saveCfg(patch) {
  const cur = getCfg()
  const next = Object.assign({}, cur, patch || {})
  // 落库的字段名跟对外的不一样：密码永远是混淆后的
  const payload = {
    base: String(next.base || DEFAULT_BASE).replace(/\/+$/, ''),
    cookie: next.cookie || '',
    stid: next.stid || '',
    pw: mask(next.password || ''),
    loginAt: next.loginAt || 0,
    lastSync: next.lastSync || 0
  }
  try {
    wx.setStorageSync(CFG_KEY, payload)
  } catch (e) {
    /* 存储失败不影响本次使用 */
  }
  return getCfg()
}

/* ---------------- Cookie ---------------- */

/**
 * 把 Set-Cookie 头拆成一条条。
 *
 * 微信把多个 Set-Cookie 用逗号拼成一个字符串（官方行为），而 Expires 里本身
 * 就带逗号（`Expires=Mon, 26 Oct 2026 09:29:39 GMT`），直接 split(',') 会切坏。
 * 所以按「看起来像 name=value 才算新的一条」来切。
 */
function splitSetCookie(raw) {
  const parts = String(raw || '').split(',')
  const out = []
  const looksCookie = /^[^=;,\s]+\s*=/
  parts.forEach((seg) => {
    if (!out.length || looksCookie.test(seg)) out.push(seg)
    else out[out.length - 1] += ',' + seg
  })
  return out
}

function parseCookie(cookie) {
  const map = {}
  String(cookie || '')
    .split(';')
    .forEach((kv) => {
      const i = kv.indexOf('=')
      if (i <= 0) return
      const k = kv.slice(0, i).trim()
      const v = kv.slice(i + 1).trim()
      if (k) map[k] = v
    })
  return map
}

function stringifyCookie(map) {
  return Object.keys(map)
    .map((k) => k + '=' + map[k])
    .join('; ')
}

/** 把响应里的 Set-Cookie 并进已有 Cookie，返回新的整串。
 *  第二个参数既可以是响应头对象，也可以直接是 Set-Cookie 那串原文。 */
function mergeCookie(prev, header) {
  const map = parseCookie(prev)
  const raw =
    typeof header === 'string'
      ? header
      : (header && (header['Set-Cookie'] || header['set-cookie'])) || ''
  if (!raw) return stringifyCookie(map)
  splitSetCookie(raw).forEach((line) => {
    const seg = line.split(';')[0]
    const i = seg.indexOf('=')
    if (i <= 0) return
    const k = seg.slice(0, i).trim()
    const v = seg.slice(i + 1).trim()
    if (!k) return
    // 服务器删 Cookie 时会发一个空值 + 过期的，照样以最新为准
    map[k] = v
  })
  return stringifyCookie(map)
}

/* ---------------- 请求 ---------------- */

function request(path, opts) {
  opts = opts || {}
  const cfg = getCfg()
  // 相对路径拼 base 时，若不以 / 开头会拼成 `http://hostindex.jsp`（缺斜杠），
  // 导致 request:fail。这里统一补上（绝对 http(s) 与以 / 开头的原样不动）。
  const p = String(path || '')
  const url = /^https?:\/\//i.test(p) ? p : cfg.base + (p.charAt(0) === '/' ? p : '/' + p)

  return new Promise((resolve, reject) => {
    const header = Object.assign(
      {
        'User-Agent': UA,
        Accept: opts.accept || 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: cfg.base + '/'
      },
      cfg.cookie ? { Cookie: cfg.cookie } : {},
      opts.header || {}
    )

    wx.request({
      url,
      method: opts.method || 'GET',
      data: opts.body === undefined ? undefined : opts.body,
      timeout: opts.timeout || 15000,
      // 文本 / 二进制两种：验证码要 arraybuffer
      dataType: opts.binary ? 'other' : 'text',
      responseType: opts.binary ? 'arraybuffer' : 'text',
      header,
      success: (r) => {
        const resHeader = r.header || {}
        // 关键一步：把服务器下发的 Cookie 存下来，下次请求带回去
        const merged = mergeCookie(cfg.cookie, resHeader)
        if (merged && merged !== cfg.cookie) {
          try {
            const c = getCfg()
            wx.setStorageSync(CFG_KEY, {
              base: c.base,
              cookie: merged,
              stid: c.stid,
              pw: mask(c.password),
              loginAt: c.loginAt,
              lastSync: c.lastSync
            })
          } catch (e) {
            /* ignore */
          }
        }
        let raw = ''
        if (typeof r.data === 'string') raw = r.data
        else if (r.data && r.data.byteLength !== undefined) raw = ''
        else raw = JSON.stringify(r.data || '')
        resolve({ status: r.statusCode, raw, header: resHeader, url, data: r.data })
      },
      fail: (e) => {
        const msg = (e && e.errMsg) || '请求失败'
        if (/timeout/i.test(msg)) {
          reject(new Error('连不上 ' + cfg.base + '（请求超时）。请确认已连校园网'))
        } else if (/domain/i.test(msg)) {
          reject(
            new Error(
              '微信拦了这个内网地址（http + IP 不在合法域名白名单里）。' +
                '电脑上：开发者工具「详情 → 本地设置」勾选「不校验合法域名」；' +
                '手机上：点右上角「···」→「开发调试」打开调试模式（仅开发版/体验版有效）。'
            )
          )
        } else {
          reject(new Error(msg))
        }
      }
    })
  })
}

function formBody(obj) {
  return Object.keys(obj)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k] == null ? '' : obj[k]))
    .join('&')
}

function tryJson(raw) {
  try {
    return JSON.parse(raw)
  } catch (e) {
    return null
  }
}

/** 页面里还有登录表单 → 没登录 / 登录被踢了 */
function isLoginPage(res) {
  const raw = (res && res.raw) || ''
  const url = (res && res.url) || ''
  // 学校自建 JSP 版（educg）
  if (/name="captchaCode"|id="captchaCode"/.test(raw)) return true
  if (/\/login\/loginproc\.jsp/.test(raw) && /stid/.test(raw)) return true
  // 头歌公网版（Rails）
  if (/\/users\/sign_in/.test(url)) return true
  if (/name="user\[password\]"|id="new_user"/.test(raw)) return true
  return false
}

/**
 * 保留标签的截断（`squeeze` 会把标签剥掉，而诊断「作业号写在哪个属性上」时
 * 恰恰要看标签本身）。
 */
function clip(t, n) {
  return String(t || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n || 200)
}

function squeeze(t, n) {
  return String(t || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n || 100)
}

function titleOf(html) {
  const m = String(html || '').match(/<title>([\s\S]*?)<\/title>/i)
  return m ? squeeze(m[1], 60) : ''
}

/** 页面上的错误提示（「验证码错误！」这类） */
function errorText(html) {
  const m = String(html || '').match(
    /[^<>"\n]{0,20}(?:验证码|密码|学号|账号|用户)[^<>"\n]{0,24}(?:错误|不正确|不存在|无效|失效|过期)[^<>"\n]{0,10}/
  )
  return m ? squeeze(m[0], 40) : ''
}

/* ---------------- 登录 ---------------- */

/** 确保手里有一个会话（验证码是绑会话的，没有会话换验证码没意义） */
async function ensureSession() {
  const cfg = getCfg()
  if (cfg.cookie) return cfg
  await request('/', { accept: 'text/html' })
  return getCfg()
}

/**
 * 验证码是 gif，宽高写在文件头第 6~9 字节（小端）。
 * 拿到比例就能让图片框按图片本身的形状撑开——固定尺寸的框套 aspectFit
 * 会在上下留一大片白，字被缩得很小，看着像「图片糊了」。
 * 不是 gif 或读不出来就返回 0，界面回落到固定宽度。
 */
function gifRatio(bytes) {
  if (!bytes || bytes.length < 10) return 0
  if (bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) return 0 // "GIF"
  const w = bytes[6] | (bytes[7] << 8)
  const h = bytes[8] | (bytes[9] << 8)
  if (!w || !h) return 0
  return w / h
}

/**
 * 换一张验证码。
 * 返回 { img: 'data:image/gif;base64,…', bytes, ratio, cookieLen }
 */
async function captcha() {
  await ensureSession()
  const res = await request(CAPTCHA_PATH + '?t=' + Date.now(), { binary: true })
  const bytes = res.data ? new Uint8Array(res.data) : new Uint8Array(0)
  const ct = (res.header['Content-Type'] || res.header['content-type'] || 'image/gif').split(';')[0]
  if (!bytes.length) {
    throw new Error('验证码没拿到（' + res.status + '），确认地址是 ' + getCfg().base)
  }
  if (bytes.length > 300000) throw new Error('验证码返回的不是图片')
  return {
    img: 'data:' + ct + ';base64,' + AES.base64(bytes),
    bytes: bytes.length,
    ratio: gifRatio(bytes),
    cookieLen: getCfg().cookie.length
  }
}

/**
 * 登录。成功返回 { stid, cookie, home }
 * 失败抛错，错误信息直接就是页面上那句提示。
 */
async function login(payload) {
  const p = payload || {}
  const stid = String(p.stid || '').trim()
  const password = String(p.password || '')
  const code = String(p.code || '').trim()
  if (!stid) throw new Error('先填学号')
  if (!password) throw new Error('先填密码')
  if (!code) throw new Error('先填验证码')

  saveCfg({ base: p.base, stid: stid })
  await ensureSession()

  const body = formBody({
    IndexStyle: '1',
    stid: stid,
    // 页面里 CryptoJS 做的事：AES-128-ECB + Pkcs7 + base64
    pwd: AES.encryptEcb(password, AES_KEY),
    captchaCode: code
  })

  const res = await request(LOGIN_PATH, {
    method: 'POST',
    body: body,
    accept: 'text/html',
    header: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }
  })

  if (isLoginPage(res)) {
    // 服务器用 loginErr 给错因：6 = 验证码错，11 = 学号或密码错。
    // 页面文案不一定有（有的部署只写个隐藏域靠 JS 弹），所以两个都看：
    // 先认 loginErr，再认页面上的中文提示，最后才给「学号或密码不对」的默认判断。
    const codeM = String(res.raw || '').match(/loginErr\s*[=:]\s*['"]?(\d+)/i)
    const errCode = codeM ? codeM[1] : ''
    if (errCode === '6') {
      throw new Error('验证码不对（服务器判的 loginErr=6）。验证码是一次性的，重新取一张再填')
    }
    const msg = errorText(res.raw)
    if (msg) throw new Error(msg + (errCode ? '（loginErr=' + errCode + '）' : ''))
    if (errCode === '11') {
      throw new Error('学号或密码不对（loginErr=11，验证码这关已经过了）。注意用的是希冀平台的密码，不是统一认证那个；确定没错就重新取一张验证码再试一次')
    }
    throw new Error('学号或密码不对（验证码这关已经过了）。注意用的是希冀平台的密码，不是统一认证那个；确定没错就重新取一张验证码再试一次')
  }

  // 再确认一次：拿个需要登录的页面看看，别被「假成功」骗了
  const home = await openHome()
  if (!home) {
    throw new Error('登录没通过：学号或密码不对。验证码是一次性的，重新取一张再试')
  }

  saveCfg({ password: password, loginAt: Date.now() })
  return { stid: stid, cookie: getCfg().cookie, homeTitle: titleOf(home.raw), size: home.raw.length }
}

/** 挨个试学生首页，返回第一个「不是登录页」的响应 */
async function openHome() {
  for (let i = 0; i < HOME_PATHS.length; i++) {
    let res
    try {
      res = await request(HOME_PATHS[i], { accept: 'text/html' })
    } catch (e) {
      continue
    }
    if (!isLoginPage(res) && res.status < 400) return res
  }
  return null
}

/** 登录态还在不在 */
async function status() {
  const cfg = getCfg()
  if (!cfg.cookie) return { logged: false, reason: '还没登录' }
  let home = null
  try {
    home = await openHome()
  } catch (e) {
    return { logged: false, reason: e.message }
  }
  if (!home) return { logged: false, reason: '登录已失效，重新登录一次' }
  return {
    logged: true,
    stid: cfg.stid,
    title: titleOf(home.raw),
    size: home.raw.length,
    loginAt: cfg.loginAt
  }
}

/** 退出：只清本机会话，不动学校那边的账号 */
function logout() {
  const cfg = getCfg()
  saveCfg({ cookie: '', loginAt: 0 })
  return cfg.stid
}

/* ---------------- 探测 ---------------- */

/** 页面上的链接清单（写解析器就靠它摸清 URL 规律） */
function linksFromPage(html, limit) {
  const out = []
  const seen = new Set()
  const re = /<a\b[^>]*href="([^"']+)"[^>]*>([\s\S]{0,120}?)<\/a>/gi
  let m
  let guard = 0
  while ((m = re.exec(String(html || ''))) && guard++ < 600) {
    let href = m[1].trim()
    const text = squeeze(m[2], 40)
    if (!href || /^(javascript:|#|mailto:)/i.test(href)) continue
    if (/\.(css|js|png|jpg|gif|svg|ico)(\?|$)/i.test(href)) continue
    if (/logout|exit|signout/i.test(href)) continue
    if (seen.has(href)) continue
    seen.add(href)
    out.push((text || '（无文字）') + ' → ' + href)
    if (out.length >= (limit || 30)) break
  }
  return out
}

const PROBES = [
  { name: '站点首页', path: '/', kind: 'html' },
  { name: '学生首页', path: '/indexcs/simple.jsp', kind: 'html' },
  { name: '登录页', path: '/login/loginproc.jsp', kind: 'html' },
  { name: 'token 接口', path: '/api', kind: 'json' }
]

/**
 * 一次性把「连得上吗 / 登录了吗 / 页面上有什么链接」都摸清。
 * 返回可直接展示、复制的文本行。
 */
/* ---------------- 相对链接怎么拼 ---------------- */

/** 去掉域名只留路径（`http://h/a/b.jsp` → `/a/b.jsp`） */
function pathOf(u) {
  const s = String(u || '')
  const m = /^https?:\/\/[^/]+(\/.*)?$/i.exec(s)
  if (!m) return s || '/'
  return m[1] || '/'
}

/** 目录（`/indexcs/simple.jsp` → `/indexcs/`；`/a` → `/`） */
function dirOf(p) {
  const clean = String(p || '/').split('?')[0].split('#')[0]
  const j = clean.lastIndexOf('/')
  return j < 0 ? '/' : clean.slice(0, j + 1)
}

/** 把相对地址贴到目录上，处理 ./ 和 ../ */
function joinPath(dir, rel) {
  let p = String(rel || '')
  let q = ''
  const qi = p.indexOf('?')
  if (qi > -1) {
    q = p.slice(qi)
    p = p.slice(0, qi)
  }
  const hi = p.indexOf('#')
  if (hi > -1) p = p.slice(0, hi)
  const out = []
  String(dir || '/')
    .split('/')
    .concat(p.split('/'))
    .forEach((seg) => {
      if (!seg || seg === '.') return
      if (seg === '..') {
        out.pop()
        return
      }
      out.push(seg)
    })
  return '/' + out.join('/') + q
}

/** `<base href>`：老 JSP 站常见，有它就该按它算相对地址 */
function baseTagOf(html) {
  const m = /<base\b[^>]*href="([^"]*)"/i.exec(String(html || ''))
  return m ? m[1] : ''
}

/**
 * 一个相对链接可能有好几种拼法，全给出来：
 * 先按页面里的 `<base href>`，再按当前页所在目录，最后按根目录 / `/indexcs/`。
 * 真机上就是这一步一律拼成 `/indexcs/` 才整排 404 的。
 */
function candidateUrls(href, docPath, baseHref) {
  const out = []
  const push = (u) => {
    if (u && out.indexOf(u) < 0) out.push(u)
  }
  const h = String(href || '').trim()
  if (!h) return out
  if (/^https?:\/\//i.test(h)) {
    push(h)
    return out
  }
  if (h.charAt(0) === '/') {
    push(h)
    return out
  }
  if (baseHref) push(joinPath(dirOf(baseHref), h))
  push(joinPath(dirOf(docPath), h))
  push(joinPath('/', h))
  if (dirOf(docPath) !== '/indexcs/') push(joinPath('/indexcs/', h))
  return out
}

/** 表格 / 列表规模，用来判断「这是不是一个列表页」 */
function listSize(html) {
  const s = String(html || '')
  return {
    tr: (s.match(/<tr\b/gi) || []).length,
    td: (s.match(/<td\b/gi) || []).length,
    li: (s.match(/<li\b/gi) || []).length
  }
}

/** iframe / frame / form 的地址：框架页的线索 */
function framesOf(html) {
  const out = []
  const re = /<(iframe|frame|form)\b[^>]*(?:src|action)="([^"]*)"/gi
  let m
  while ((m = re.exec(String(html || ''))) && out.length < 4) out.push(m[1] + ' ' + m[2])
  return out
}

/* ---------------- 找课程：首页是框架页时往下摸一层 ---------------- */

/** 这几种地址一看就不是课程页：保活、退出、帮助文档、静态资源 */
function isNoisePath(u) {
  return /stayalive|logout|signout|exit|\.(css|js|png|jpe?g|gif|svg|ico)(\?|$)|docs\.educg|educg\.net/i.test(
    String(u || '')
  )
}

/** iframe / frame / form 的目标地址（框架页的课程就在这里面） */
function targetsOf(html) {
  const out = []
  const seen = {}
  const re = /<(iframe|frame|form)\b([^>]*)>/gi
  let m
  while ((m = re.exec(String(html || '')))) {
    const attrs = m[2] || ''
    const um = /\b(?:src|action)\s*=\s*"([^"]*)"/i.exec(attrs)
    const u = um ? um[1].trim() : ''
    if (!u || isNoisePath(u)) continue
    if (seen[u]) continue
    seen[u] = 1
    out.push({ tag: m[1].toLowerCase(), url: u })
    if (out.length >= 8) break
  }
  return out
}

/** 页面里出现过的 .jsp 地址（菜单常由 JS 拼出来，不在 <a> 里） */
function jspPathsOf(html) {
  const out = []
  const seen = {}
  const re = /["'(]([^"'()\s]*\.jsp(?:\?[^"'()\s]*)?)/gi
  let m
  while ((m = re.exec(String(html || '')))) {
    // 页面里的地址常是拼出来的：`'/includes/redirect.jsp?tab=-2&courseID='+v`，
    // 抓到的是半截（尾巴是个空参数）。把空参数掐掉，留下能直接读的那部分
    let u = m[1].trim().replace(/[?&][^?&=]*=$/, '').replace(/[?&=]+$/, '')
    if (!u || u.length > 200) continue
    if (isNoisePath(u)) continue
    if (seen[u]) continue
    seen[u] = 1
    out.push(u)
    if (out.length >= 14) break
  }
  return out
}

/** 页面里真正能点、像「课程 / 作业 / 栏目」的锚链接（爬下一层用） */
function anchorsOf(html) {
  const out = []
  const seen = {}
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi
  let m
  let guard = 0
  while ((m = re.exec(String(html || ''))) && guard++ < 600) {
    const href = m[1].trim()
    if (!href || /^(javascript:|#|mailto:|https?:\/\/)/i.test(href)) continue
    if (isNoisePath(href)) continue
    if (!LINK_LIKE.test(href)) continue
    if (seen[href]) continue
    seen[href] = 1
    out.push(href)
    if (out.length >= 10) break
  }
  return out
}

/**
 * 页面里的「课程引用」：`courseID=40` 这种。
 *
 * 真机上学生首页是个外壳页，课程列表由 form / iframe 或者 JS 填进去，
 * 光看 `<a href>` 一门都认不出来；但课程号本身一般还是在页面里的。
 *
 * 带 `assignID` 的链接**不是课程**，是作业（`index.jsp?courseID=124&assignID=802`
 * 这种在「在线作业」页里一行一条），交给 assignRows 处理。
 */
function courseRefs(html) {
  const s = String(html || '')
  const out = []
  const seen = {}
  const pushRef = (id, name, href) => {
    const key = String(id)
    if (!key || seen[key]) return
    seen[key] = 1
    out.push({
      id: key,
      name: name || '课程 ' + key,
      href: href || 'courselist.jsp?courseID=' + key
    })
  }

  // 1) 锚里的链接带课程号：课程名取「这一行里最长的那段有意义的文字」——
  //    真机上课程列表常见 `<td>离散数学</td><td><a>进入</a></td>`，
  //    锚文字只是「进入」，真正的课程名在旁边的 td 里
  const re = /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]{0,160}?)<\/a>/gi
  let m
  let guard = 0
  while ((m = re.exec(s)) && guard++ < 400) {
    const cm = /(?:course_?id|cid)\s*=\s*(\d+)/i.exec(m[1])
    if (!cm) continue
    if (ASSIGN_ANY.test(m[1])) continue
    const anchorText = squeeze(m[2].replace(/<[^>]+>/g, ' '), 40)
    let name = anchorText
    // 锚文字是「进入/查看/详情」这类动作词时，说明课程名在别处。
    // 只在「这一行 <tr>」里找（只认 <td>，不认 <th>——表头「课程名称/操作」不是课程名），
    // 不能跨行抓，否则会把上一行的课程名张冠李戴
    if (!name || /^(\u8fdb\u5165|\u67e5\u770b|\u8be6\u60c5|\u6253\u5f00|\u8fdb\u53bb|\u4f5c\u7b54|\u67e5\u8be2|\u8bbf\u95ee|\u70b9\u51fb|\u94fe\u63a5)$/.test(name)) {
      const before = s.slice(0, m.index)
      const trStart = before.lastIndexOf('<tr')
      const rowSeg = trStart >= 0 ? before.slice(trStart) : before.slice(Math.max(0, before.length - 1200))
      const cells = rowSeg.match(/<td\b[^>]*>([\s\S]{0,160}?)<\/td>/gi) || []
      const cands = []
      cells.forEach((x) => {
        const t = titleOf2(x)
        if (t && !/^(\u8fdb\u5165|\u67e5\u770b|\u8be6\u60c5|\u6253\u5f00|\u4f5c\u7b54|\u67e5\u8be2|\u70b9\u51fb)$/.test(t)) cands.push(t)
      })
      if (cands.length) {
        cands.sort((a, b) => b.length - a.length)
        name = cands[0]
      }
    }
    pushRef(cm[1], name, m[1])
  }

  // 2) 锚里没有、但正文/JS 里有课程号：名字就近取上一个锚文字
  if (!out.length) {
    const re2 = /(?:course_?id|cid)\s*=\s*(\d+)/gi
    let m2
    while ((m2 = re2.exec(s)) && out.length < 30) {
      const id = m2[1]
      if (seen[id]) continue
      // 只看这一处的上下文，别把作业号当课程
      const around = s.slice(Math.max(0, m2.index - 60), m2.index + 60)
      if (ASSIGN_ANY.test(around)) continue
      const before = s.slice(Math.max(0, m2.index - 800), m2.index)
      const anchors = before.match(/<a\b[^>]*>([\s\S]{0,80}?)<\/a>/gi) || []
      let name = ''
      if (anchors.length) {
        name = squeeze(String(anchors[anchors.length - 1]).replace(/<[^>]+>/g, ' '), 40)
      }
      pushRef(id, name, '')
    }
  }

  // 3) 课程号藏在 JS 调用里：`openCourse(40)` / `switchCourse('40')` / `selCourse(40)`
  if (!out.length) {
    const re3 = /(?:open|switch|select|goto|sel|enter|load)\s*[Cc]ourse\s*\(\s*["']?(\d{1,6})["']?/g
    let m3
    while ((m3 = re3.exec(s)) && out.length < 30) {
      pushRef(m3[1], '', '')
    }
  }
  return out
}

/**
 * 作业号出现在什么写法上都认：`assignID=802`、`assign_id=802`、
 * `data-assign="802"`、`assign:802`。真机上这一行到底写在哪个属性上，
 * 光看文字是看不出来的，所以判据放宽，别再因为「写法不同」整页丢数据。
 */
const ASSIGN_ANY = /(?:assign_?id|data-assign|assign)\s*[=:]\s*["']?(\d+)/i
const ASSIGN_ANY_G = /(?:assign_?id|data-assign|assign)\s*[=:]\s*["']?(\d+)/gi

/** 这一段里到底有几条**不同的**作业（同一作业号重复出现只算一条） */
function assignIdsIn(seg) {
  const seen = {}
  const re = new RegExp(ASSIGN_ANY_G.source, 'gi')
  const s = String(seg || '')
  let m
  while ((m = re.exec(s))) seen[m[1]] = 1
  return Object.keys(seen)
}

/**
 * 给一个锚找「它所在的那一行」。
 *
 * 为什么必须这一步：列表页的截止时间和状态，几乎从不写在 `<a>` 里面，
 * 而是锚的**兄弟节点**（`<li><a>作业名</a><span>2026-11-30 23:59</span></li>`）。
 * 只拿 `<a …>…</a>` 这一段去解析，永远只能得到标题，日期恒为 0 ——
 * 这就是「希冀任务全都没有截止时间」的头号原因。
 *
 * 取「能装下这个锚、且里面**正好只有 1 条作业**的最大容器」：
 *  · 只有 1 条 → 不会把两条作业的日期串到一起
 *  · 尽量大   → 日期那格多半就在里面
 *  · 不超过 3000 字 → 防止一路兜到整页
 * 找不到合格容器就返回空串，调用方仍旧只拿锚自己（行为与以前一致）。
 */
function containerOf(s, at, len) {
  const TAGS = ['li', 'tr', 'dd', 'dt', 'p', 'div']
  let best = ''
  TAGS.forEach((tag) => {
    // 祖先可能有好几层（div.list > div.row > div.t > a），
    // 只取最近的那层只能切到 div.t，日期在隔壁的 div.d 里，还是看不到。
    // 所以每一层的开标签都试一遍，取「合格且最大」的那个。
    openPositionsBefore(s, tag, at).forEach((open) => {
      const closeAt = closeOf(s, tag, open)
      if (closeAt < 0 || closeAt < at || closeAt < open) return
      const seg = s.slice(open, closeAt + tag.length + 3)
      if (seg.length > 3000) return
      if (assignIdsIn(seg).length !== 1) return
      if (seg.length > best.length) best = seg
    })
  })
  return best
}

/** 位置 at 之前所有 <tag 的开标签位置（`<pre` 不算 `<p`） */
function openPositionsBefore(s, tag, at) {
  const re = new RegExp('<' + tag + '\\b', 'gi')
  const out = []
  let m
  while ((m = re.exec(s))) {
    if (m.index >= at) break
    out.push(m.index)
  }
  return out
}

/** 从 open 处的 <tag 开始数层数，找它真正对应的 </tag> */
function closeOf(s, tag, open) {
  const re = new RegExp('<(/?)' + tag + '\\b', 'gi')
  re.lastIndex = open
  let depth = 0
  let m
  while ((m = re.exec(s))) {
    if (m[1]) {
      depth--
      if (depth === 0) return m.index
    } else {
      depth++
    }
  }
  return -1
}

/**
 * 诊断用：把一个列表页的「第一条作业」原样吐出来。
 *
 * 日期到底写没写在页面上、写在哪个标签里，只有看原文才知道。
 * 让人一次把这段复制过来，好过再来回猜三轮。
 */
function rowProbe(html) {
  const s = String(html || '')
  const anchors = s.match(/<a\b[^>]*assign_?id\s*=\s*["']?\d+[^>]*>[\s\S]{0,300}?<\/a>/gi) || []
  if (!anchors.length) return '（这页没有带作业号的锚）'
  const a = anchors[0]
  const at = s.indexOf(a)
  const wide = containerOf(s, at, a.length)
  const inTr = (() => {
    const before = s.slice(0, at)
    const open = before.lastIndexOf('<tr')
    const close = before.lastIndexOf('</tr>')
    return !(open === -1 || close > open)
  })()
  // 全页出现过几处「年-月-日」：0 处就是硬证据——这一版页面根本没把日期发下来，
  // 别再怀疑解析器了，只能去详情页/接口取
  const dm = s.match(new RegExp(DATE_RE.source, 'g')) || []
  // 有日期却解析不到，最可能的原因是它不在作业行里（在 JS 变量、表头、别的区块）。
  // 把每一处连同前后文带出来，一眼能看出该去哪儿取。
  const spots = []
  const dg = new RegExp(DATE_RE.source, 'g')
  let dmm
  while ((dmm = dg.exec(s)) && spots.length < 3) {
    spots.push('…' + clip(s.slice(Math.max(0, dmm.index - 70), dmm.index + 60), 130))
  }
  return (
    '首行：' + (wide.length ? '容器 ' + wide.length + ' 字' : '只有锚 ' + a.length + ' 字') +
    '，在 tr 内：' + (inTr ? '是' : '否') +
    '，全页日期痕迹 ' + dm.length + ' 处' +
    '，锚原文：' + clip(a, 160) +
    // 没有容器时把锚**前后**也带上：日期如果就写在旁边（但没包在同一个标签里），
    // 只看锚本身永远发现不了，得靠这段原文判断
    (wide.length ? '；容器原文：' + clip(wide, 420) : '；锚前后原文：' + clip(s.slice(Math.max(0, at - 260), at + 620), 520)) +
    (spots.length ? '；日期出现在：' + spots.join(' ／ ') : '')
  )
}

/** 这页有几条作业号的链接（>0 说明它是「在线作业」这种列表页） */
function assignCount(html) {
  const s = String(html || '')
  const seen = {}
  let n = 0
  ASSIGN_ANY_G.lastIndex = 0
  let m
  while ((m = ASSIGN_ANY_G.exec(s))) {
    if (seen[m[1]]) continue
    seen[m[1]] = 1
    n++
    if (n > 60) break
  }
  return n
}

/**
 * 从一段 HTML（一个表格行 / 一个列表项 / 一个锚）里抠出一条作业。
 *
 * 真机上的教训：这个平台的作业行**不一定**把作业号放在 `href` 里——常见写法是
 * `href="javascript:;"` 加上 `onclick="openAssign(802)"`，或者干脆列在 `data-*`
 * 上。所以判据是「这一块 HTML 里出现了 `assignID=802`」，而不是「锚的 href 里有」。
 */
/**
 * 把一块 HTML 里「值是人能看的内容」的属性拼成一串。
 *
 * 为什么要这一手：这套平台的作业行经常长这样——
 *   <td title="截止时间：2026-12-20 23:59">…</td>
 *   <input type="hidden" name="endTime" value="2026-12-20 23:59:00">
 * 日期全在属性里，`replace(/<[^>]+>/g,' ')` 一过就没了，解析出来当然「没有截止时间」。
 * 不捞 href：URL 里的数字不是日期，只会添乱。
 */
function attrText(seg) {
  const out = []
  const re = /(?:title|value|alt|data-[\w-]+|onclick)\s*=\s*["']([^"']{0,200})["']/gi
  const s = String(seg || '')
  let m
  while ((m = re.exec(s))) out.push(m[1])
  return out.join(' ')
}

/** DATE_RE 的匹配结果 → 毫秒时间戳；没写时分就按当天 23:59（截止都算到当天最后一分钟） */
function dmToTs(dm) {
  if (!dm) return 0
  const iso =
    dm[1] + '-' + ('0' + dm[2]).slice(-2) + '-' + ('0' + dm[3]).slice(-2) +
    'T' + (dm[4] ? ('0' + dm[4]).slice(-2) + ':' + dm[5] : '23:59') + ':00'
  return toTs(iso)
}

/**
 * 「12-20 23:59」「12月20日」这种不带年份的写法。
 *
 * 这套平台的作业列表常常只显示月日（默认当年），DATE_RE 要求 4 位年份，
 * 一条都匹配不上，任务就全变成「无截止时间」——这是希冀任务没日期的头号原因。
 * 年份按当前年补：跨年边界可能差一年，但那是极少数，比整平台没日期好得多。
 */
const SHORT_DATE = /(^|[^\d/.-])(\d{1,2})[-/\u6708](\d{1,2})\u65e5?(?:[\sT]+(\d{1,2}):(\d{2}))?/

function shortDateTs(text, nowTs) {
  const m = SHORT_DATE.exec(String(text || ''))
  if (!m) return 0
  const mo = Number(m[2])
  const d = Number(m[3])
  const hh = m[4] === undefined ? 23 : Number(m[4])
  const mi = m[5] === undefined ? 59 : Number(m[5])
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59) return 0
  const base = new Date(nowTs || Date.now())
  return new Date(base.getFullYear(), mo - 1, d, hh, mi, 0).getTime()
}

/**
 * @param {string} seg  一行（或一块）HTML
 * @param {string} [hint] 已知的标题片段（通常是锚自己的文字）。给了就用它，
 *   不再「取最长候选」——把锚扩成整行以后，块里混进了状态、时间、按钮，
 *   取最长会挑到导航文字上去。
 */
function readAssignBlock(seg, hint) {
  const am = ASSIGN_ANY.exec(seg)
  if (!am) return null
  const assignId = am[1]
  const cm = /course_?id\s*=\s*(\d+)/i.exec(seg)
  // 1000 而不是 400：整行扩出来以后（标题 + 时间 + 状态 + 按钮），
  // 日期常排在偏后，截断在 400 会把日期切掉，任务又变「无截止」
  const text = squeeze(String(seg).replace(/<[^>]+>/g, ' '), 1000)

  // 标题：这块里所有「像标题的文字」都当候选——这套平台的作业名常常是纯文本，
  // 链接反而只有「进入作业」四个字。取最长的那个（最长的通常就是作业名）。
  const anchors = String(seg).match(/<a\b[\s\S]{0,500}?<\/a>/gi) || []
  // 单元格 / 卡片里的文字块都算候选（这套平台的行有时是 div 卡片，不是表格）
  const cells = []
  ;['td', 'th', 'span', 'label', 'strong', 'b', 'i', 'em', 'h3', 'h4', 'p'].forEach((tag) => {
    const re = new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?</' + tag + '>', 'gi')
    ;(String(seg).match(re) || []).forEach((x) => cells.push(x))
  })
  const assignAnchors = anchors.filter((a) => ASSIGN_ANY.test(a))
  const realHref = (a) => {
    const hm = /href\s*=\s*["']([^"']+)["']/i.exec(a)
    const h = hm ? hm[1].trim() : ''
    return h && !/^(javascript:|#|mailto:)/i.test(h) ? h : ''
  }
  let href = ''
  for (let i = 0; i < assignAnchors.length && !href; i++) href = realHref(assignAnchors[i])

  const cands = []
  assignAnchors.concat(anchors, cells).forEach((x) => {
    const t = titleOf2(x)
    if (t && cands.indexOf(t) < 0) cands.push(t)
  })
  // 标题：优先用调用方给的线索（锚自己的文字），这是最准的作业名；
  // 没有线索时才退到「取最长候选」
  let title = hint ? titleOf2(hint) : ''
  if (!title) {
    cands.forEach((t) => {
      if (t.length > title.length) title = t
    })
  }
  // 实在没有结构：从整块文字里切掉「截止时间」「状态」那几段再取
  if (!title) title = titleOf2(text.split(/\u622a\u6b62|\u65f6\u95f4\s*[:\uff1a]|\u72b6\u6001\s*[:\uff1a]/)[0])
  if (!title) return null

  // 链接是 javascript: / 空的时候，按这平台的固定格式拼一个（作业号本身就是地址的一部分）
  if (!href || /^(javascript:|#|mailto:)/i.test(href)) {
    href = 'index.jsp' + (cm ? '?courseID=' + cm[1] + '&' : '?') + 'assignID=' + assignId
  }

  let deadline = 0
  // 日期可能只在属性里（title / data-* / value / onclick 参数）——老 JSP 页面
  // 很爱这么写，去掉标签后文本里就什么都没有了，这才是「希冀任务没有截止时间」
  // 最常见的成因。文本找不到就再去属性里捞一遍。
  const dm = DATE_RE.exec(text) || DATE_RE.exec(attrText(seg))
  if (dm) deadline = dmToTs(dm)
  // 只有「12-20 23:59」这种没年份的：当年作业列表默认这么显示
  if (!deadline) deadline = shortDateTs(text)

  return {
    assignId: assignId,
    courseId: cm ? cm[1] : '',
    title: title,
    href: href,
    deadline: deadline,
    done: DONE_RE.test(text),
    text: text
  }
}

/** 日期片段（清洗标题用） */
const DATE_LOOSE = /\d{4}\s*[-/\u5e74]\s*\d{1,2}\s*[-/\u6708]\s*\d{1,2}\s*\u65e5?(?:\s*\d{1,2}:\d{2})?/g

/** 这一格 / 这个锚，能不能当作业名（不能就给空字符串） */
function titleOf2(raw) {
  let t = squeeze(raw, 120)
  if (!t) return ''
  // 去掉行号、「截止」这类前缀，别把表头当作业
  t = t.replace(/^\d+[.)]\s*/, '')
  if (NOISE_TITLE.test(t)) return ''
  if (NOISE_PREFIX.test(t)) return ''
  // 只有日期的格子（截止时间那一列）不是标题
  const rest = t.replace(DATE_LOOSE, ' ').replace(/[\s\u622a\u6b62\u65e5\u671f\u65f6\u95f4\u9650:：\-—/()（）]+/g, '')
  if (rest.length < 2) return ''
  return t.slice(0, 80)
}

/** 导航词不算作业标题（整页兜底解析时容易把菜单当成作业） */
const NOISE_TITLE = /^(\u5728\u7ebf\u4f5c\u4e1a|\u5728\u7ebf\u8003\u8bd5|\u8bfe\u7a0b\u4fe1\u606f|\u5728\u7ebf\u7b54\u7591|\u66f4\u591a|\u4e2a\u4eba\u4fe1\u606f|\u9000\u51fa\u767b\u5f55|\u9996\u9875|GitLab|\u5207\u6362\u8bfe\u7a0b|\u4e0b\u4e00\u9875|\u4e0a\u4e00\u9875)$/i

/** 表头与动作词：它们出现在同一行里，但不是作业名 */
const NOISE_PREFIX = /^(\u622a\u6b62|\u65f6\u95f4|\u72b6\u6001|\u64cd\u4f5c|\u8fdb\u5165|\u67e5\u770b|\u8be6\u60c5|\u4f5c\u7b54|\u63d0\u4ea4|\u4e0b\u8f7d|\u5f00\u59cb|\u7ee7\u7eed|\u5df2\u5b8c\u6210|\u5df2\u63d0\u4ea4|\u672a\u63d0\u4ea4|\u5f97\u5206|\u6210\u7ee9|\u7f16\u53f7|\u5e8f\u53f7)/

/**
 * 把一页作业列表变成任务行。
 *
 * 先在「表格行 / 列表项」里找带作业号的块（日期和提交状态就在同一块里，
 * 最完整）；一块都没有时，退到「锚里带作业号」的最小粒度。
 */
function assignRows(html) {
  const s = String(html || '')
  const out = []
  const seen = {}

  const push = (seg, hint) => {
    const r = readAssignBlock(seg, hint)
    if (!r || seen[r.assignId]) return
    seen[r.assignId] = 1
    out.push(r)
  }

  // 希冀「在线作业」页分「当前作业 / 历史作业」两个区块（官方学生手册 V7.2）：
  //   当前作业 = 还没到期（未完成），历史作业 = 已截止/已交（已完成）。
  // 列表锚本身不带「已提交」字样，所以「是否完成」得看它在哪个区块里。
  // 找「历史作业」区块标题的位置（容忍空格/标签分隔）。
  const histM = /历史\s*作\s*业/i.exec(s)
  const histIdx = histM ? histM.index : -1

  // 把落在「历史作业」区块里的行补成已完成，同时记下每行在哪个区。
  // 用作业号在整页 HTML 里反查位置：位置在「历史作业」标题之后 = 历史区，之前 = 当前区。
  // 「在当前区」这个信息很重要：平台只把还没截止的作业放在当前区，所以这条的截止
  // 不可能在过去——后面补日期时用它挡掉串到别的作业身上的过期日期（用户报过
  // 「集合的概念截止 176 天」，就是被塞了一个半年多以前的日期）。
  const markHist = () => {
    if (histIdx < 0) return
    out.forEach((r) => {
      if (!r.assignId) return
      const re = new RegExp('(?:assign_?id|data-assign|assign)\\s*[=:]\\s*["\']?' + r.assignId + '\\b', 'i')
      const m = re.exec(s)
      if (!m) return
      const hist = m.index > histIdx
      r.inCurrent = !hist
      // 只补 true、不撤 false（表格行里已抓到的「已提交」不能被误清掉）
      if (hist && !r.done) r.done = true
    })
  }

  // 0) 锚列表：这套平台真正的作业列表常见写法是
  //    `<div class="list-group"><a href="index.jsp?courseID=40&assignID=861">…</a> …</div>`，
  //    一个锚就是一条作业（作业号直接写在 href 里）。这种结构不在 <tr>/<li> 里，
  //    老逻辑用 tr 切块只能刮到 1 条就提前收工，剩下全丢。
  //    判据：锚**不在任何 <tr> 里**。表格行的锚（<tr><td><a…>）日期/状态在同行 td 里，
  //    得留给下面的 tr 切块；锚列表的锚是独立的，才在这里一条条收。
  const assignAnchors = s.match(/<a\b[^>]*assign_?id\s*=\s*["']?\d+[^>]*>[\s\S]{0,300}?<\/a>/gi) || []
  const freeAnchors = assignAnchors.filter((a) => {
    const at = s.indexOf(a)
    // 锚前面最近的一个 <tr> 和 </tr>：若 <tr> 在 </tr> 之后，说明锚还在某个 <tr> 里面
    const before = s.slice(0, at)
    const open = before.lastIndexOf('<tr')
    const close = before.lastIndexOf('</tr>')
    return open === -1 || close > open
  })
  if (freeAnchors.length >= 2) {
    freeAnchors.forEach((a) => {
      // 只解析 <a> 的话永远是「有标题、没日期」；把锚扩成它所在的整行，
      // 日期和状态才在视野里（标题仍用锚自己的文字，不会被导航带偏）
      const at = s.indexOf(a)
      const wide = containerOf(s, at, a.length)
      const r = readAssignBlock(wide || a, a)
      if (!r) return
      if (seen[r.assignId]) return
      seen[r.assignId] = 1
      out.push(r)
    })
    if (out.length >= 2) {
      markHist()
      return out
    }
  }

  // 一行 / 一条 / 一段：块越完整，截止时间和提交状态越不容易丢
  const tags = ['tr', 'li', 'dd', 'p', 'div']
  for (let i = 0; i < tags.length && !out.length; i++) {
    const tag = tags[i]
    const blocks = s.split(new RegExp('<' + tag + '\\b', 'i')).slice(1)
    for (let k = 0; k < blocks.length; k++) {
      // split 把 `<tr` / `<div` 自己吃掉了，剩下的是属性尾巴，掐掉到第一个 `>`
      const seg = (blocks[k].split(new RegExp('</' + tag + '>', 'i'))[0] || blocks[k]).replace(/^[^>]*>/, '')
      if (!ASSIGN_ANY.test(seg)) continue
      // div 会套娃：只有「一块里正好一条作业、且不算太长」才当一行，
      // 否则一整页套在一个 div 里会被误当成同一条作业
      if (tag === 'div') {
        const n = (seg.match(/(?:assign_?id|data-assign|assign)\s*[=:]\s*["']?\d+/gi) || []).length
        if (n !== 1 || seg.length > 4000) continue
      }
      push(seg)
    }
  }

  // 兜底：作业号只出现在锚上（href 是 javascript:，地址在 onclick 里）
  if (!out.length) {
    const anchors = s.match(/<a\b[^>]*(?:assign|data-assign)\b[^>]*>[\s\S]{0,240}?<\/a>/gi) || []
    anchors.forEach((x) => push(x))
  }

  // 无论走哪条路径解析出来的行，最后统一补「历史作业区 → 已完成」
  markHist()

  return out
}

/** 实在摸不到时的备选栏目页：这套 JSP 平台常见的位置 */
const CRAWL_SEEDS = [
  '/main.jsp',
  '/indexcs/main.jsp',
  '/indexcs/index.jsp',
  '/index.jsp',
  '/indexcs/courselist.jsp',
  '/courselist.jsp'
]

/**
 * 从学生首页一路摸到底。
 *
 * 真机上的结论：这套平台是「外壳 + 服务端渲染 tab 页」——
 * `form /main.jsp`、`/index.jsp`、`/includes/redirect.jsp?tab=0` 全都返回**同一个
 * 20852 字节外壳**，课程/作业页点进去也只有外壳（内容靠 JS 填）；
 * 而 `/includes/redirect.jsp?tab=-2`（在线作业）是实打实 22623 字节、带
 * `index.jsp?courseID=124&assignID=802` 这种行的页面。
 *
 * 所以这里不「找到一门课就停」，而是把预算内的页面全摸一遍，分别收：
 *   · courses  —— 课程引用（`courselist.jsp?courseID=N` 这类，进去解析作业表）
 *   · lists    —— 作业列表页（页面里有 `assignID=`），留着 HTML 直接解析
 * 顺带记一份 `nameById`（课程号 → 课程名），给作业行补课程名。
 *
 * 返回的 `docPath` 是「发现内容的那个页面」，后面的相对地址要按它算。
 */
async function collectCourses(home, trace) {
  const traceLines = trace || []
  const docPath = home && home.url ? pathOf(home.url) : '/'
  const baseHref = home ? baseTagOf(home.raw) : ''
  const out = []
  const lists = []
  const nameById = {}
  const options = []
  const seenId = {}

  const add = (refs, pagePath, from) => {
    refs.forEach((r) => {
      if (r.name && !/^课程 \d+$/.test(r.name) && r.id) nameById[r.id] = r.name
      if (seenId[r.id]) return
      seenId[r.id] = 1
      out.push({ id: r.id, name: r.name, href: r.href, docPath: pagePath, from: from })
    })
  }

  // 课程切换下拉框也是课程清单（`<option value="40">离散数学</option>`），
  // 这种页面上一门课都认不出来时它就是唯一的线索
  const noteOptions = (html) => {
    optionRefs(html).forEach((o) => {
      if (o.name && !nameById[o.id]) nameById[o.id] = o.name
      if (!options.some((x) => x.id === o.id)) options.push(o)
    })
  }

  const pack = () => ({
    courses: out,
    lists: lists,
    nameById: nameById,
    options: options,
    docPath: docPath,
    baseHref: baseHref,
    trace: traceLines
  })

  if (!home) return pack()

  // 首页自己也可能就是列表页
  const homeAssign = assignCount(home.raw)
  if (homeAssign) lists.push({ label: '首页', pagePath: docPath, url: docPath, html: home.raw, assignCount: homeAssign })
  noteOptions(home.raw)
  add(courseRefs(home.raw), docPath, '首页')
  // 首页就有课程链接（老版部署）：课程不用再往下摸，但「在线作业」这个 tab
  // 还得读一次——不然一门课有作业、却没有列表页可解析，等于白摸
  const homeReady = out.length > 0

  /** 按队列往下摸；`depth` 最多到 2，总请求数封死（内网一次一两秒） */
  const visited = {}
  const crawl = async (seeds, budget) => {
    const queue = []
    const pushQ = (u, label, depth) => {
      const cands = candidateUrls(u, docPath, baseHref)
      if (!cands.length) return
      const url = cands[0]
      if (visited[url]) return
      visited[url] = 1
      queue.push({ url: url, label: label || u, depth: depth || 1 })
    }

    seeds.forEach((s) => pushQ(s.url, s.label, 1))

    let fetched = 0
    for (let qi = 0; qi < queue.length && fetched < budget; qi++) {
      const item = queue[qi]
      fetched++
      let res
      try {
        res = await request(item.url, { timeout: 8000, accept: 'text/html' })
      } catch (e) {
        traceLines.push(item.label + ' ❌ ' + squeeze(e.message, 20))
        continue
      }
      if (isLoginPage(res)) {
        traceLines.push(item.label + ' → 被跳回登录页')
        continue
      }
      const html = String(res.raw || '')
      // 框架页本身很短（一个 frameset 一两百字节），别拿「太短」当失败
      if (res.status >= 400 || html.length < 120) {
        traceLines.push(item.label + ' → ' + res.status + (html.length ? ' / ' + html.length + ' 字节' : ''))
        continue
      }
      const sz = listSize(html)
      const refs = courseRefs(html)
      const nAssign = assignCount(html)
      const pagePath = pathOf(item.url)
      traceLines.push(
        item.label + ' → ' + res.status + ' / ' + html.length + ' 字节 / tr ' + sz.tr +
          ' / 课程 ' + refs.length + ' 门' + (nAssign ? ' / 作业 ' + nAssign + ' 条' : '')
      )
      if (refs.length) add(refs, pagePath, item.label)
      noteOptions(html)
      if (nAssign) lists.push({ label: item.label, pagePath: pagePath, url: item.url, html: html, assignCount: nAssign })
      if (refs.length || nAssign) continue
      // 这一层什么都没有：它自己也可能是框架页，再往下一层看看。
      // 除了 iframe/form/.jsp 字符串，还要跟普通 <a href> 链接——
      // 课程列表常常就藏在「课程信息」这类栏目页的链接里（老版只跟 iframe 会漏掉）
      if (item.depth < 2) {
        targetsOf(html).forEach((t) => pushQ(t.url, (t.tag || '') + ' ' + t.url, item.depth + 1))
        jspPathsOf(html).forEach((u) => pushQ(u, u, item.depth + 1))
        anchorsOf(html).forEach((a) => pushQ(a, a, item.depth + 1))
      }
    }
    return queue.length
  }

  // 首页已经给了课程：只补读一次「在线作业」栏目，别把预算浪费在重复摸页上
  if (homeReady) {
    await crawl([{ url: '/includes/redirect.jsp?tab=-2', label: 'tab=-2 在线作业' }], 2)
    return pack()
  }

  // 第一轮：首页里的 form / iframe / JS 地址（最可能命中）
  const seeds = []
  targetsOf(home.raw).forEach((t) => seeds.push({ url: t.url, label: t.tag + ' ' + t.url }))
  jspPathsOf(home.raw).forEach((u) => seeds.push({ url: u, label: u }))
  await crawl(seeds, 8)

  // 第二轮：还没认到课程就按这套平台常见的栏目页 / 课程列表页碰一碰。
  //         就算已经摸到作业列表（tab=-2），三门课里另两门也得从课程列表页找，
  //         所以只要「课程数 < 2」就补这一轮（只认到 1 门时另两门还下落不明）
  if (out.length < 2) {
    await crawl(
      CRAWL_SEEDS.map((u) => ({ url: u, label: u })),
      out.length ? 3 : 4
    )
  }

  return pack()
}

/* ---------------- 「其他的」在哪儿：换课程 / 换栏目 / 翻页 ---------------- */

/** 一页作业的「作业号指纹」：换了课程或者翻了页，它一定变 */
function assignKey(html) {
  const ids = []
  const s = String(html || '')
  ASSIGN_ANY_G.lastIndex = 0
  let m
  while ((m = ASSIGN_ANY_G.exec(s))) {
    if (ids.indexOf(m[1]) < 0) ids.push(m[1])
    if (ids.length > 60) break
  }
  return ids.sort().join(',')
}

/** 课程切换下拉框：`<option value="40">离散数学</option>` 或 `<span value="40">离散数学</span>` */
function optionRefs(html) {
  const out = []
  const seen = {}
  const s = String(html || '')
  // 真机上这套平台的下拉菜单不是 <select><option>，而是
  // `<div class="dropdown-menu"><span class="dropdown-item ..." value="40">离散数学</span>`。
  // 两种都要认，认到任一都行；value 是数字才算课程号，纯文字不碰。
  const re = /<(?:option|span)\b[^>]*value\s*=\s*["']?(\d{1,6})["']?[^>]*>([\s\S]{0,60}?)<\/(?:option|span)>/gi
  let m
  let guard = 0
  while ((m = re.exec(s)) && guard++ < 400) {
    const id = m[1]
    const name = squeeze(m[2], 40)
    if (!name || name.length < 2 || /^\d+$/.test(name)) continue
    if (NOISE_TITLE.test(name) || NOISE_PREFIX.test(name)) continue
    if (seen[id]) continue
    seen[id] = 1
    out.push({ id: id, name: name, href: '' })
  }
  return out
}

/** 把页面下拉框里的课程灌进 `nameById`（不重复） */
function noteOptionsInto(nameById, html) {
  optionRefs(html).forEach((o) => {
    if (o.name && o.id && !nameById[o.id]) nameById[o.id] = o.name
  })
}

/** 翻页：一页放不下时，其他的在后面几页（「下一页」或者地址里带 pageNo） */
function nextPagePaths(html, pagePath) {
  const s = String(html || '')
  const base = baseTagOf(s)
  const out = []
  const seen = {}
  const push = (href) => {
    const h = String(href || '').trim()
    if (!h || /^(javascript:|#|mailto:)/i.test(h)) return
    const cands = candidateUrls(h, pagePath, base)
    const u = cands[0] || ''
    if (!u || seen[u]) return
    seen[u] = 1
    out.push(u)
  }

  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,24}?)<\/a>/gi
  let m
  let guard = 0
  while ((m = re.exec(s)) && guard++ < 500) {
    const text = squeeze(m[2], 14)
    if (!/^(\u4e0b\u4e00\u9875|\u4e0b\u9875|\u540e\u4e00\u9875|next|\u00bb|&gt;|>)$/i.test(text)) continue
    push(m[1])
    if (out.length >= 2) break
  }

  const re2 = /["']([^"']*\b(?:pageNo|pageNum|curPage|page|pn)\s*=\s*\d+[^"']*)["']/gi
  let m2
  while ((m2 = re2.exec(s)) && out.length < 4) push(m2[1])
  return out
}

/** 「换一门课」的几种可能写法：各校版本的菜单不一样，都试一遍 */
const SWITCH_MAKERS = [
  (id) => '/indexcs/index.jsp?courseID=' + id,
  (id) => '/indexcs/simple.jsp?courseID=' + id,
  (id) => '/indexcs/courselist.jsp?courseID=' + id,
  (id) => '/courselist.jsp?courseID=' + id,
  (id) => '/indexcs/main.jsp?courseID=' + id,
  (id) => '/includes/redirect.jsp?tab=0&courseID=' + id
]

/**
 * 把「其他的」捞出来。
 *
 * 真机上的实情：`/includes/redirect.jsp?tab=-2` 是服务端按**当前课程**渲染的，
 * 一次只列一门课的在线作业；同屏菜单里还有 -1/-3/-4… 几个栏目。所以只扫一次
 * 必然「同步成功，但就少那么几条」。这里补三条路：
 *   1. 换栏目——还没读过 tab 页读一遍
 *   2. 换课程——先试 tab 页直接带 `courseID`（1 个请求最省），不灵再打开
 *      「切换页」让服务端记住课程（哪种写法灵就记住，后面的课直接复用）
 *   3. 翻页——「下一页」与 `pageNo=` 都跟一页
 *
 * 全程有时间预算：内网一次请求一两秒，扫久了不如先交一部分，下一次同步接着扫。
 * 返回「新拿到的作业页」（调用方负责解析入库）。
 */
async function scanMore(found, trace, opts) {
  opts = opts || {}
  const src = found || {}
  const lines = trace || []
  const lists = src.lists || []
  const nameById = src.nameById || {}
  const out = []
  const doneKeys = {}
  const fetched = {}
  const t0 = Date.now()
  const maxMs = opts.maxMs || 15000
  const left = () => maxMs - (Date.now() - t0)

  let lastKey = lists.length ? assignKey(lists[0].html) : ''
  lists.forEach((l) => {
    const k = assignKey(l.html)
    if (k) doneKeys[k] = 1
    if (l.url) fetched[pathOf(l.url)] = 1
    else if (l.pagePath) fetched[pathOf(l.pagePath)] = 1
  })

  const grab = async (path, label, force) => {
    if (left() <= 0) return null
    const key = pathOf(path)
    if (!force && fetched[key]) return null
    fetched[key] = 1
    let res
    try {
      res = await request(path, { timeout: 8000, accept: 'text/html' })
    } catch (e) {
      lines.push(label + ' \u274c ' + squeeze(e.message, 20))
      return null
    }
    if (res.status >= 400 || isLoginPage(res)) {
      lines.push(label + ' \u2192 ' + res.status + '\uff08\u4e0d\u662f\u9875\u9762\uff09')
      return null
    }
    const html = String(res.raw || '')
    if (html.length < 120) return null
    const url = res.url || path
    return { label: label, url: url, pagePath: pathOf(url), html: html, n: assignCount(html) }
  }

  const push = (p, courseName) => {
    if (!p || !p.n) return 0
    const k = assignKey(p.html)
    if (!k || doneKeys[k]) return 0
    doneKeys[k] = 1
    lastKey = k
    out.push({ label: p.label, pagePath: p.pagePath, html: p.html, courseName: courseName || '', n: p.n })
    return p.n
  }

  // 1) 其他栏目：tab=-2 是「在线作业」，同屏菜单还有课程信息 / 在线考试 / 在线答疑，
  //    这几个栏目在有的部署里也挂着实训、作业。只挑最可能的三项，别把预算烧光
  const tabNums = ['-1', '-3', '-4']
  for (let i = 0; i < tabNums.length && left() > 0; i++) {
    const p = '/includes/redirect.jsp?tab=' + tabNums[i]
    if (fetched[pathOf(p)]) continue
    const r = await grab(p, 'tab=' + tabNums[i])
    if (!r) continue // 读不到的原因 grab 已经写过了，别重复刷
    const got = r.n ? push(r) : 0
    const refs = courseRefs(r.html)
    noteOptionsInto(nameById, r.html)
    // 这个栏目页既没作业号、也没课程号，但有内容——课程清单很可能就藏在这里，
    // 只是写法不是 courseID=。把它的链接、正文、表格行、下拉框都打出来
    if (!r.n && !refs.length) {
      const ls = linksFromPage(r.html, 14)
      lines.push('tab=' + tabNums[i] + '（' + r.html.length + ' 字节）里没有作业号也没有 courseID：')
      ls.forEach((x) => lines.push('    · ' + x))
      if (!ls.length) lines.push('    · 没有 <a href> 链接')
      const opts = optionRefs(r.html)
      if (opts.length) lines.push('    下拉框课程：' + opts.map((o) => o.id + ':' + o.name).join('，'))
      const trs = String(r.html).match(/<tr\b[\s\S]{0,600}?<\/tr>/gi) || []
      trs.slice(0, 3).forEach((x) => lines.push('    表格行：' + clip(x, 300)))
      // 「切换课程」这类地方常带着课程号和切换动作，把这段原文也打出来——
      // 课程号往往写在 onclick / data-* / JS 里，光看链接和文字看不出来
      const sw = String(r.html).match(/(?:切换课程|选择课程|我的课程|课程列表|switch)[\s\S]{0,500}/i)
      if (sw) lines.push('    切换课程原文：' + clip(sw[0], 500))
      const txt = textOf(r.html, 300)
      if (txt) lines.push('    正文节选：' + txt)
      continue
    }
    if (refs.length) {
      lines.push('tab=' + tabNums[i] + ' 里有课程：' + refs.map((c) => c.id + ':' + c.name).join('，'))
    }
    lines.push('tab=' + tabNums[i] + '：' + (r.n ? '作业 ' + r.n + ' 条' : '没有作业号') + (got ? '（新的 ' + got + ' 条）' : ''))
  }

  // 2) 换课程
  const ids = []
  const known = {}
  const addId = (id, name) => {
    const k = String(id || '')
    if (!/^\d{1,6}$/.test(k) || known[k]) return
    known[k] = 1
    ids.push({ id: k, name: name || nameById[k] || '' })
  }
  ;(src.courses || []).forEach((c) => addId(c.id, c.name))
  Object.keys(nameById).forEach((k) => addId(k, nameById[k]))
  ;(src.options || []).forEach((o) => addId(o.id, o.name))
  const curIds = []
  lists.forEach((l) => {
    assignRows(l.html).forEach((r) => {
      addId(r.courseId)
      if (r.courseId && curIds.indexOf(r.courseId) < 0) curIds.push(r.courseId)
    })
  })

  let shape = -1
  let explored = false
  for (let i = 0; i < ids.length && ids.length > 1; i++) {
    if (left() <= 0) break
    const c = ids[i]
    // 当前课程：它的作业已经在列表页里了，别再花钱读一遍
    if (curIds.indexOf(c.id) > -1) continue

    // a) tab 页直接带课程号（最省，1 个请求）
    let got = 0
    const direct = await grab('/includes/redirect.jsp?tab=-2&courseID=' + c.id, 'tab=-2&courseID=' + c.id)
    if (direct && direct.n && assignKey(direct.html) !== lastKey) got = push(direct, c.name)

    // b) 不灵：先打开切换页，让服务端记住「当前课程」，再读在线作业。
    //    6 种写法只在第一门上全试一遍（试出哪种灵就锁定），后面别重复烧请求
    const makers = shape >= 0 ? [SWITCH_MAKERS[shape]] : explored ? [] : SWITCH_MAKERS
    if (makers.length) explored = true
    for (let k = 0; k < makers.length && !got && left() > 0; k++) {
      const sw = makers[k](c.id)
      const page = await grab(sw, '\u5207\u6362 ' + sw)
      if (!page) continue
      const tab = await grab('/includes/redirect.jsp?tab=-2', '\u5207\u5230\u300c' + (c.name || c.id) + '\u300d\u540e\u7684\u5728\u7ebf\u4f5c\u4e1a', true)
      if (!tab) continue
      const key2 = assignKey(tab.html)
      // 内容变了 = 这种写法真的把「当前课程」换过去了（哪怕这门课没作业，也算试对了）
      if (key2 === lastKey) continue
      if (shape < 0) shape = SWITCH_MAKERS.indexOf(makers[k])
      if (tab.n) got = push(tab, c.name)
      else {
        lastKey = key2
        break // 切过去了，只是这门课确实没作业，别再换别的写法试
      }
    }
    lines.push('\u8bfe\u7a0b\u300c' + (c.name || c.id) + '\u300d：' + (got ? '\u591a\u6293\u5230 ' + got + ' \u6761' : '\u6ca1\u6709\u989d\u5916\u4f5c\u4e1a'))
  }

  // 3) 翻页：列表一页放不下时，剩下的在后面
  const pages = lists.concat(out)
  for (let i = 0; i < pages.length && left() > 0; i++) {
    const pg = pages[i]
    const nexts = nextPagePaths(pg.html, pg.pagePath || '/')
    for (let k = 0; k < nexts.length && k < 2 && left() > 0; k++) {
      const r = await grab(nexts[k], '\u7ffb\u9875 ' + nexts[k])
      if (r && r.n) push(r, pg.courseName || '')
    }
  }

  if (left() <= 0) lines.push('\u626b\u5230\u9884\u7b97\u4e0a\u9650\uff08' + Math.round(maxMs / 1000) + ' \u79d2\uff09\uff0c\u5148\u6536\u5de5')
  if (!out.length) lines.push('\u6ca1\u627e\u5230\u522b\u7684\u4f5c\u4e1a\u9875\u9762')
  return out
}

/** 去掉标签的正文节选 */
function textOf(html, n) {
  const s = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
  return squeeze(s, n)
}

const LINK_LIKE = /(course|homework|task|exercise|experiment|shixun|work|chapter|kecheng|zuoye|class|list)/i

/**
 * 链接体检：光知道「首页有哪些链接」不够，还得知道点进去是不是作业列表。
 *
 * 相对地址按几种拼法挨个试，谁返回了正常列表页就用谁；后面的课程沿用已经
 * 试出来的那一种（省请求，口径也一致）。第一条命中后会把页面里的链接和
 * 正文节选一起报出来——写解析器就差这些。
 */
async function openByCandidates(href, docPath, baseHref, opts) {
  opts = opts || {}
  const cands = candidateUrls(href, docPath, baseHref)
  const fixed = typeof opts.only === 'number' && opts.only >= 0
  const tries = fixed ? [cands[Math.min(opts.only, cands.length - 1)]] : cands
  const tried = []
  for (let i = 0; i < tries.length; i++) {
    const url = tries[i]
    let res
    try {
      res = await request(url, { timeout: opts.timeout || 8000, accept: 'text/html' })
    } catch (e) {
      tried.push(url + ' ❌ ' + squeeze(e.message, 20))
      continue
    }
    const html = String(res.raw || '')
    const size = listSize(html)
    tried.push(url + ' → ' + res.status + '/tr ' + size.tr)
    if (res.status >= 400 || isLoginPage(res)) continue
    // 200 的软 404 页
    if (/404 Not Found|HTTP Status 404|页面不存在|找不到页面|File not found/i.test(html)) continue
    // 真正的列表页一定有表格或列表；空壳子 / 跳转页直接跳过
    // （li 只给到 2：作业列表常常就是一个两三条的 <ul>）
    if (size.tr < 2 && size.td < 4 && size.li < 2) continue
    return { url: url, res: res, html: html, size: size, shape: fixed ? opts.only : i, tried: tried }
  }
  return { url: '', res: null, html: '', size: null, shape: -1, tried: tried }
}

/**
 * 链接体检：光知道「首页有哪些链接」不够，还得知道点进去是不是作业列表。
 *
 * 相对地址按几种拼法挨个试（见 candidateUrls），谁返回了正常列表页就用谁；
 * 后面的课程沿用已经试出来的那一种（省请求，口径也一致）。第一条命中后会把
 * 页面里的链接和正文节选一起报出来——写解析器就差这些。
 */
async function inspectLinks(links, docPath, baseHref) {
  const picked = []
  for (let i = 0; i < links.length && picked.length < 3; i++) {
    const href = String(links[i]).split('\u2192').pop().trim()
    if (!href || !LINK_LIKE.test(href)) continue
    if (/logout|exit|signout/i.test(href)) continue
    if (picked.indexOf(href) > -1) continue
    picked.push(href)
  }
  if (!picked.length) return []

  const out = []
  let winShape = -1

  for (let i = 0; i < picked.length; i++) {
    const href = picked[i]
    const hit = await openByCandidates(href, docPath, baseHref, winShape > -1 ? { only: winShape } : {})

    if (!hit.res) {
      out.push('\u00b7 ' + href + ' \u2717 ' + hit.tried.length + ' \u79cd\u62fc\u6cd5\u90fd\u6ca1\u62ff\u5230\u6b63\u5e38\u9875\u9762\uff1a' + hit.tried.join('\uff1b'))
      continue
    }
    if (winShape < 0) winShape = hit.shape

    const fr = framesOf(hit.html)
    out.push(
      '\u00b7 ' + href +
        ' \u2705 ' + hit.url +
        ' \u2192 HTTP ' + hit.res.status +
        ' / ' + (titleOf(hit.html) || '\u65e0\u6807\u9898') +
        ' / ' + hit.html.length + ' \u5b57\u8282' +
        ' / tr ' + hit.size.tr + ' td ' + hit.size.td + ' li ' + hit.size.li +
        (fr.length ? ' / ' + fr.join('\uff0c') : '')
    )

    if (i === 0) {
      const inner = linksFromPage(hit.html, 14)
      if (inner.length) {
        out.push('  \u9875\u9762\u91cc\u7684\u94fe\u63a5\uff1a')
        inner.forEach((x) => out.push('  \u00b7 ' + x))
      } else {
        out.push('  \u9875\u9762\u91cc\u6ca1\u6709 <a href>\uff0c\u53ef\u80fd\u6574\u9875\u662f JS \u751f\u6210\u7684\u6216\u6846\u67b6\u9875')
      }
      const txt = textOf(hit.html, 240)
      if (txt) out.push('  \u6587\u5b57\u8282\u9009\uff1a' + txt)
    }
  }
  return out
}

async function probe() {
  const cfg = getCfg()
  const lines = []
  lines.push('地址：' + cfg.base)
  lines.push('会话：' + (cfg.cookie ? cfg.cookie.length + ' 字节' : '还没有') + (cfg.stid ? '（学号 ' + cfg.stid + '）' : ''))

  for (let i = 0; i < PROBES.length; i++) {
    const p = PROBES[i]
    let res = null
    try {
      res = await request(p.path, { timeout: 10000, accept: p.kind === 'html' ? 'text/html' : undefined })
    } catch (e) {
      lines.push(`${p.name} ${p.path}：❌ ` + squeeze(e.message, 40))
      if (i === 0) return lines
      continue
    }
    const len = res.raw.length
    const login = isLoginPage(res)
    let brief
    if (p.kind === 'json') {
      const j = tryJson(res.raw)
      brief = j ? 'JSON ' + JSON.stringify(j).slice(0, 100) : squeeze(res.raw, 60)
    } else {
      brief = (titleOf(res.raw) || '无标题') + ' / ' + len + ' 字节'
    }
    lines.push(`${p.name} ${p.path}：HTTP ${res.status}${login ? '（登录页）' : ''} → ${brief}`)
  }

  // 登录了才有意义：把学生首页的链接列出来
  const st = await status()
  if (st.logged) {
    const home = await openHome()
    const docPath = home && home.url ? pathOf(home.url) : '/'
    const baseHref = home ? baseTagOf(home.raw) : ''
    const ls = home ? linksFromPage(home.raw, 40) : []
    const homeFr = home ? framesOf(home.raw) : []
    lines.push('')
    lines.push(
      '学生首页 ' + docPath + (baseHref ? '（base=' + baseHref + '）' : '') + ' 链接（' + ls.length + ' 个）：'
    )
    if (!ls.length) lines.push('（一个都没抓到，可能首页是框架页）')
    ls.forEach((x) => lines.push('· ' + x))
    if (homeFr.length) lines.push('首页里的 iframe/form：' + homeFr.join('，'))

    // 再往下摸一层：课程 / 作业入口点进去到底长什么样
    const linkLike = ls.filter((x) => LINK_LIKE.test(x.split('\u2192').pop()))
    const traceLines = []
    const found = await collectCourses(home, traceLines)

    // 「其他的」在哪儿：其他课程 / 其他栏目 / 翻页。一次摸清，别再让用户来回发结果
    const scanTrace = []
    const extra = await scanMore(found, scanTrace, { maxMs: 15000 })

    if (linkLike.length) {
      const deep = await inspectLinks(ls, docPath, baseHref)
      lines.push('')
      lines.push(deep.length ? '课程 / 作业入口体检：' : '没找到像课程/作业的链接，可能藏在 iframe 或 JS 跳转里')
      deep.forEach((x) => lines.push(x))
    }

    lines.push('')
    lines.push('补充扫描（其他课程 / 其他栏目 / 翻页）：')
    scanTrace.forEach((x) => lines.push('· ' + x))
    extra.forEach((p) => {
      const rows = assignRows(p.html)
      lines.push('  ✅ ' + p.label + '：' + rows.length + ' 条' + (p.courseName ? '｜' + p.courseName : ''))
      rows.slice(0, 6).forEach((r) => {
        lines.push('     · ' + r.title + '｜' + (r.deadline ? '截止 ' + fmtTs(r.deadline) : '没有截止时间') + (r.done ? '｜已提交' : '') + (r.courseId ? '｜课程 ' + r.courseId : ''))
      })
      // 分区诊断：这页有没有「当前作业/历史作业」分区（希冀在线作业标准结构）
      const hasCur = /当前\s*作\s*业/i.test(String(p.html))
      const histM2 = /历史\s*作\s*业/i.exec(String(p.html))
      if (hasCur || histM2) {
        lines.push('  ℹ 分区：当前作业=' + (hasCur ? '有' : '无') + '，历史作业=' + (histM2 ? '有' : '无'))
        if (histM2) {
          const at2 = histM2.index
          lines.push('    · 历史作业附近原文：' + clip(String(p.html).slice(Math.max(0, at2 - 120), at2 + 500), 520))
        }
        // 当前作业区：截止时间应该在这里（未到期的作业一定带截止时间）
        const curM2 = /当前\s*作\s*业/i.exec(String(p.html))
        if (curM2) {
          const curEnd2 = histM2 ? histM2.index : curM2.index + 2000
          lines.push('    · 当前作业区原文：' + clip(String(p.html).slice(curM2.index, curEnd2), 900))
        }
      }
      // 诊断：这页 assignCount 数到的作业号远多于 assignRows 解析出来的行数，
      // 说明有几条作业写法特殊被丢了。把原始标签打出来定位（只看文字看不出作业号写哪）。
      if (p.n && p.n >= 3 && rows.length <= 1) {
        lines.push('  ⚠ assignCount 数到 ' + p.n + ' 个作业号，却只解析出 ' + rows.length + ' 行，原始标签：')
        const li = String(p.html).match(/<li\b[\s\S]{0,400}?<\/li>/gi) || []
        li.slice(0, 8).forEach((x) => lines.push('    · ' + clip(x, 300)))
        if (!li.length) {
          const tr = String(p.html).match(/<tr\b[\s\S]{0,400}?<\/tr>/gi) || []
          tr.slice(0, 8).forEach((x) => lines.push('    · ' + clip(x, 300)))
        }
        // 兜底：把「作业号附近」的原文直接截出来
        const m = /(?:assign_?id|data-assign|assign)\s*[=:]\s*["']?\d+/i.exec(String(p.html))
        if (m) {
          const at = String(p.html).slice(Math.max(0, m.index - 250), m.index + 350)
          lines.push('    · 作业号附近原文：' + clip(at, 520))
        }
      }
    })

    lines.push('')
    // 作业列表页（在线作业 tab）：这才是这套平台的真实数据源
    if (found.lists.length) {
      found.lists.forEach((p) => {
        const rows = assignRows(p.html)
        const dated = rows.filter((r) => r.deadline > 0)
        lines.push(
          '作业列表 ' + p.label + '（' + p.html.length + ' 字节）：作业行 ' + rows.length +
            ' / 带截止时间 ' + dated.length
        )
        rows.slice(0, 10).forEach((r) => {
          lines.push(
            '  · ' + r.title +
              '｜' + (r.deadline ? '截止 ' + fmtTs(r.deadline) : '没有截止时间') +
              (r.done ? '｜已提交' : '') +
              (r.courseId ? '｜课程 ' + r.courseId : '')
          )
        })
        if (rows.length && !dated.length) lines.push('  ' + rowProbe(p.html))
        // 诊断：这页有没有「当前作业 / 历史作业」分区（希冀在线作业的标准结构）。
        // 历史作业 = 已完成。锚列表本身不写「已提交」，只能靠区块判断。
        const hasCur = /当前\s*作\s*业/i.test(String(p.html))
        const histM = /历史\s*作\s*业/i.exec(String(p.html))
        if (hasCur || histM) {
          lines.push(
            '  ℹ 分区：当前作业=' + (hasCur ? '有' : '无') +
            '，历史作业=' + (histM ? '有' : '无')
          )
          if (histM) {
            const at = histM.index
            lines.push('    · 历史作业附近原文：' + clip(String(p.html).slice(Math.max(0, at - 120), at + 500), 520))
          }
          // 当前作业区：截止时间应该在这里（未到期的作业一定带截止时间）
          const curM = /当前\s*作\s*业/i.exec(String(p.html))
          if (curM) {
            const curEnd = histM ? histM.index : curM.index + 2000
            const curSeg = String(p.html).slice(curM.index, curEnd)
            lines.push('    · 当前作业区原文：' + clip(curSeg, 900))
          }
        }
        if (!rows.length) {
          // 解析失败时把原始标签也打出来：作业号写在 href 还是 onclick / data-* 上，
          // 一眼就能看出为什么没认出来（只看文字是看不出来的）
          const raw = String(p.html).match(/<a\b[^>]*assign[^>]*>[\s\S]{0,200}?<\/a>/gi) || []
          lines.push('  （有作业号但一行都没解析出来，下面是原始标签）')
          raw.slice(0, 4).forEach((x) => lines.push('  · ' + clip(x, 240)))
          if (!raw.length) {
            const idx = String(p.html).normalize ? String(p.html).toLowerCase().search(/assign/) : -1
            const at = idx > -1 ? String(p.html).slice(Math.max(0, idx - 200), idx + 200) : ''
            lines.push('  （作业号不在锚标签里，附近原文）' + clip(at, 320))
          }
        }
      })

      // 截止时间探针：列表页锚里没有日期（上面「当前作业区原文」已证），
      // 截止时间大概率在作业详情页 index.jsp?courseID=N&assignID=M 里。
      // 抓第一个作业的详情页，看有没有「截止/结束/提交截止」+ 日期。
      {
        let detailRow = null
        let detailHref = ''
        for (let i = 0; i < found.lists.length && !detailHref; i++) {
          const rs = assignRows(found.lists[i].html)
          for (let k = 0; k < rs.length && !detailHref; k++) {
            if (rs[k].href && /assign/i.test(rs[k].href)) {
              detailRow = rs[k]
              detailHref = rs[k].href
            }
          }
        }
        if (detailHref) {
          // 详情页地址可能也要多拼法（/index.jsp、/indexcs/index.jsp …），
          // 逐个试，并把完整 errMsg 打出来（上次只看到裸 request:fail，看不出原因）
          const cands = candidateUrls(detailHref, '/', '')
          const tried = []
          let got = null
          for (let c = 0; c < cands.length && !got; c++) {
            try {
              const dr = await request(cands[c], { timeout: 10000, accept: 'text/html' })
              const dhtml = String(dr.raw || '')
              tried.push(cands[c] + ' → HTTP ' + dr.status + ' / ' + dhtml.length + ' 字节')
              if (dr.status < 400 && dhtml.length >= 120 && !isLoginPage(dr)) got = { url: cands[c], html: dhtml, status: dr.status }
            } catch (e) {
              tried.push(cands[c] + ' ❌ ' + e.message)
            }
          }
          if (got) {
            const dhtml = got.html
            lines.push('作业详情页 ' + got.url + ' → HTTP ' + got.status + ' / ' + dhtml.length + ' 字节')
            const dm = /(截止|结束|提交截止|到期|有效|deadline|endTime)\s*(时间|日期)?\s*[:：]?[\s\S]{0,60}/i.exec(dhtml)
            const dateAt = dhtml.search(/20\d{2}[-/年.]\d{1,2}/)
            if (dm) {
              lines.push('  · 详情页有「截止/结束」字样：' + clip(dhtml.slice(Math.max(0, dm.index - 80), dm.index + 180), 260))
            } else if (dateAt >= 0) {
              lines.push('  · 详情页有日期（无「截止」字样）：' + clip(dhtml.slice(Math.max(0, dateAt - 80), dateAt + 160), 260))
            } else {
              lines.push('  · 详情页没有截止/日期线索，正文节选：' + textOf(dhtml, 220))
            }
            // —— 挖 JS 外壳里的接口线索（截止时间大概率由 AJAX 异步拉取）——
            // 1) 外部脚本引用
            const scripts = String(dhtml).match(/<script\b[^>]*src\s*=\s*["']([^"']+)["']/gi) || []
            const jsSrc = scripts.map((s) => /src\s*=\s*["']([^"']+)["']/i.exec(s)[1])
            if (jsSrc.length) lines.push('  · 详情页引用的 JS：' + jsSrc.slice(0, 10).join(' | '))
            // 2) 内联/脚本里的 ajax、fetch、接口 URL
            const js = String(dhtml)
            const ajaxHits = js.match(/(?:url\s*[=:]\s*|fetch\s*\(\s*|\.ajax\s*\(\s*\{?)[^'"\n]{0,80}/gi) || []
            if (ajaxHits.length) {
              lines.push('  · 详情页里的接口调用（url/ajax/fetch）：')
              ajaxHits.slice(0, 8).forEach((x) => lines.push('      ' + clip(x, 100)))
            }
            // 3) assignID 在 JS 里的上下文（接口常按 assignID 拼地址）
            const aidHits = String(dhtml).match(/.{0,60}assign_?id.{0,80}/gi) || []
            if (aidHits.length) {
              lines.push('  · assignID 在详情页的上下文：')
              aidHits.slice(0, 6).forEach((x) => lines.push('      ' + clip(x, 140)))
            }
          } else {
            lines.push('作业详情页没拿到正常页：')
            tried.forEach((t) => lines.push('  · ' + t))
          }
        }
      }

      if (!found.courses.length) {
        lines.push('没有独立的课程列表（课程/作业详情页是 JS 外壳，进去也只有同一个页面）')
        if (traceLines.length) lines.push('走过的路：' + traceLines.join('；'))
        return lines
      }
    }

    if (!found.courses.length) {
      lines.push('没摸到课程，也没有作业列表。走过的路：')
      if (!traceLines.length) lines.push('· 首页里既没有课程号，也没有 form/iframe 能往下走')
      traceLines.forEach((x) => lines.push('· ' + x))
      const jsps = jspPathsOf(home ? home.raw : '')
      if (jsps.length) lines.push('首页里出现过的 .jsp：' + jsps.slice(0, 8).join('，'))
      const txt = home ? textOf(home.raw, 200) : ''
      if (txt) lines.push('首页文字节选：' + txt)
    } else {
      lines.push('摸到 ' + found.courses.length + ' 门课程：')
      found.courses.slice(0, 10).forEach((c) => lines.push('· ' + c.name + ' → ' + c.href + '（来自 ' + c.from + '）'))
      if (traceLines.length) lines.push('走过的路：' + traceLines.join('；'))

      // 上面已经按链接体检过了，就别把同样的地址再打一遍（内网一次一两秒）
      if (linkLike.length) return lines

      // 第一门实际打开一次：确认拼法，顺便把作业页的结构摊开
      const c0 = found.courses[0]
      const hit = await openByCandidates(c0.href, c0.docPath || docPath, baseHref, {})
      lines.push('')
      if (!hit.res) {
        lines.push('第一门实测：✗ ' + hit.tried.join('；'))
      } else {
        lines.push(
          '第一门实测：✅ ' + hit.url + ' → HTTP ' + hit.res.status +
            ' / ' + (titleOf(hit.html) || '无标题') +
            ' / ' + hit.html.length + ' 字节' +
            ' / tr ' + hit.size.tr + ' td ' + hit.size.td + ' li ' + hit.size.li
        )
        const rows = parseRows(hit.html)
        const dated = rows.filter((r) => r.deadline > 0)
        lines.push('带截止时间的行：' + dated.length + ' / 可解析行：' + rows.length)
        dated.slice(0, 5).forEach((r) => lines.push('  · ' + r.title + ' @ ' + r.deadline))
        if (!dated.length) {
          if (rows.length) {
            lines.push('  解析到的行都没日期（没敢猜）：')
            rows.slice(0, 5).forEach((r) => lines.push('  · ' + r.title + '｜' + r.text))
          }
          const inner = linksFromPage(hit.html, 10)
          if (inner.length) {
            lines.push('  页面里的链接：')
            inner.forEach((x) => lines.push('  · ' + x))
          }
          const txt2 = textOf(hit.html, 260)
          if (txt2) lines.push('  文字节选：' + txt2)
        }
      }
    }
  } else {
    lines.push('')
    lines.push('还没登录：' + (st.reason || ''))
  }
  return lines
}

/* ---------------- 解析 ---------------- */

function pick(obj, keys, dft) {
  for (let i = 0; i < keys.length; i++) {
    const v = obj[keys[i]]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return dft
}

function normList(data) {
  if (Array.isArray(data)) return data
  if (!data) return []
  if (Array.isArray(data.data)) return data.data
  if (data.data && Array.isArray(data.data.items)) return data.data.items
  if (Array.isArray(data.items)) return data.items
  if (Array.isArray(data.courses)) return data.courses
  if (Array.isArray(data.courseList)) return data.courseList
  if (Array.isArray(data.homework_commons)) return data.homework_commons
  if (Array.isArray(data.homeworkCommons)) return data.homeworkCommons
  if (data.data && Array.isArray(data.data.courses)) return data.data.courses
  return []
}

/** 把 '2026-10-25 23:59' / '2026/10/25' / ISO 串转成毫秒 */
function toTs(v) {
  if (!v) return 0
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v
  const s = String(v).replace(/年|月/g, '-').replace(/日/g, '').replace(/\//g, '-')
  const t = Date.parse(s.replace(' ', 'T'))
  return isNaN(t) ? 0 : t
}

/** 毫秒 → `2026-11-01 23:59`（探测结果里给人看的，走本地时区） */
function fmtTs(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const p2 = (n) => ('0' + n).slice(-2)
  return (
    d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) +
    ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes())
  )
}

/** 给任务打学期标签（和超星一个口径，首页默认只看本学期） */
function tagSemester(list, course) {
  const startMs = toTs(
    pick(course, ['start_date', 'start_time', 'begin_date', 'begin_time', 'created_at', 'create_time'], '')
  )
  const name = pick(course, ['name', 'title', 'course_name'], '')
  const sem = SEM.ofCourse({ startMs, name })
  list.forEach((t) => {
    t.semesterKey = sem.key
    t.semesterLabel = sem.label
    t.semesterShort = sem.short
    t.semesterRank = sem.rank
  })
  return sem
}

/* ---------------- 抓取数据 ---------------- */

async function getJsonList(paths, trace) {
  for (let i = 0; i < paths.length; i++) {
    let res
    try {
      res = await request(paths[i])
    } catch (e) {
      trace.push(paths[i] + ' 请求失败')
      continue
    }
    if (isLoginPage(res)) {
      trace.push(paths[i] + ' 被跳登录页')
      continue
    }
    const j = tryJson(res.raw)
    if (!j) {
      trace.push(paths[i] + ' 非 JSON(HTTP ' + res.status + ')')
      // 200 却回 HTML/外壳，说明这套部署根本没有这套接口：剩下的变体别再打了
      // （内网一次一两秒，省下来的时间用户能少等好几秒）
      if (res.status < 400) return { path: '', list: [], html: true }
      continue
    }
    const list = normList(j)
    if (list.length) {
      trace.push(paths[i] + ' 命中，' + list.length + ' 条')
      return { path: paths[i], list: list }
    }
    trace.push(paths[i] + ' 通了但为空')
  }
  return { path: '', list: [] }
}

/**
 * 把一条「作业 / 实训」记录变成统一的任务结构。
 * 各套部署的字段名不一样，pick 依次试。
 */
function toTask(course, raw, base) {
  const done =
    raw.finished === true ||
    raw.is_finished === true ||
    raw.passed === true ||
    raw.status === 'finished' ||
    raw.status === 1 ||
    raw.state === 'finished' ||
    raw.work_status === 2 // Educoder：已交且评分
  const id = pick(raw, ['id', 'task_id', 'challenge_id', 'homework_id'], '')
  const title = String(pick(raw, ['name', 'title', 'challenge_name', 'homework_name'], '')).trim()
  if (!title) return null
  const cid = pick(course, ['id', 'course_id'], '')
  return {
    externalId: `${KEY}:${cid}:${id || title}`,
    courseId: String(cid),
    courseName: pick(course, ['name', 'title', 'course_name'], '未命名课程'),
    title: title,
    taskType: raw.challenge_id || raw.homework_type === 'shixun' || raw.type === 'challenge' ? 'practice' : 'homework',
    deadline: toTs(pick(raw, ['deadline', 'end_time', 'end_at', 'expire_at', 'due_at'], '')),
    status: done ? 'done' : 'todo',
    progress: null,
    url: base + (id ? '/homework_commons/' + id : '/')
  }
}

/** 一门课的作业接口候选（按命中概率排，命中一个就够） */
function taskPaths(cid) {
  return [
    `/api/courses/${cid}/homework_commons.json?page=1&limit=200`,
    `/api/courses/${cid}/homework_commons.json`,
    `/api/courses/${cid}/homework_commons/list.json`,
    `/api/courses/${cid}/tasks.json?limit=200`,
    `/api/courses/${cid}/homeworks.json?limit=200`,
    `/api/courses/${cid}/challenges.json?limit=200`
  ]
}

/* ---------------- 页面模式：从 HTML 里解析作业 ---------------- */

const DATE_RE = /(\d{4})[-/\u5e74](\d{1,2})[-/\u6708](\d{1,2})\u65e5?(?:[\sT]+(\d{1,2}):(\d{2}))?/
const DONE_RE = /(\u5df2\u63d0\u4ea4|\u5df2\u5b8c\u6210|\u5df2\u6279\u9605|\u5df2\u901a\u8fc7|\u5df2\u4ea4|\u5df2\u8bc4\u5206|completed)/i

/**
 * 把表格行解析成「标题 + 截止时间 + 是否已交」。
 *
 * 只认「一行里既有链接标题、又有日期」的行：日期是硬证据。没有日期的行一律
 * 不进任务列表——瞎猜会把错的东西塞进首页，比没数据更糟。
 */
function parseBlock(html, tag) {
  const rows = []
  String(html || '')
    .split(new RegExp('<' + tag + '\\b', 'i'))
    .slice(1)
    .forEach((b) => {
      const seg = b.split(new RegExp('</' + tag + '>', 'i'))[0] || b
      const a = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/i.exec(seg)
      if (!a) return
      const href = a[1].trim()
      if (!href || /^(javascript:|#|mailto:)/i.test(href)) return
      const title = squeeze(a[2].replace(/<[^>]+>/g, ' '), 80)
      if (!title) return
      const text = squeeze(seg.replace(/<[^>]+>/g, ' '), 300)
      let deadline = 0
      const dm = DATE_RE.exec(text)
      if (dm) {
        const iso =
          dm[1] + '-' + ('0' + dm[2]).slice(-2) + '-' + ('0' + dm[3]).slice(-2) +
          'T' + (dm[4] ? ('0' + dm[4]).slice(-2) + ':' + dm[5] : '23:59') + ':00'
        deadline = toTs(iso)
      }
      rows.push({ title: title, href: href, deadline: deadline, done: DONE_RE.test(text), text: text })
    })
  return rows
}

/**
 * 把页面解析成「标题 + 截止时间 + 是否已交」。
 *
 * 先按表格行（`<tr>`）解析；表格里没有带日期的，再按列表项（`<li>`）解析——
 * 这套 JSP 平台的作业页两种写法都见过。
 * 只认「一条里既有链接标题、又有日期」的：日期是硬证据。没有日期的一律
 * 不进任务列表，瞎猜会把错的东西塞进首页，比没数据更糟。
 */
function parseRows(html) {
  const tr = parseBlock(html, 'tr')
  if (tr.filter((r) => r.deadline > 0).length) return tr
  const li = parseBlock(html, 'li')
  const seen = {}
  return tr.concat(li).filter((r) => {
    if (seen[r.title]) return false
    seen[r.title] = 1
    return true
  })
}

/**
 * 相对链接 → 绝对地址。
 *
 * `/includes/` 这个目录是公共片段（tab 页都在这儿），里面的链接是相对**站点根**
 * 的（`index.jsp?courseID=124&assignID=802` → `/index.jsp?...`）。按目录拼会拼成
 * `/includes/index.jsp?...`——而这类平台对所有路径都回 200 外壳，拼错了也看不出，
 * 用户点进去就是空白页，所以这里单独处理。
 */
function linkFor(href, pagePath) {
  const cfg = getCfg()
  const h = String(href || '')
  if (/^https?:\/\//i.test(h)) return h
  if (h.charAt(0) === '/') return cfg.base + h
  const dir = dirOf(pagePath)
  if (/^\/includes\//i.test(dir)) return cfg.base + joinPath('/', h)
  return cfg.base + joinPath(dir, h)
}

/**
 * 作业行里常常没有「所属课程」这一列，就拿已知的课程名去这行文字里碰一下
 * （「2025级认知实习报告书」里能碰到「认知实习」）。碰不到就留空，由
 * pageTask 兜底成「希冀课程」，别硬编一个错的。
 */
function guessCourseName(row, nameById) {
  const names = Object.keys(nameById || {}).map((k) => nameById[k])
  for (let i = 0; i < names.length; i++) {
    const n = names[i]
    if (!n) continue
    if (row.title.indexOf(n) > -1 || String(row.text || '').indexOf(n) > -1) return n
  }
  return ''
}

/** 页面里的一行 → 统一任务结构 */
function pageTask(course, row, pageUrl) {
  return {
    externalId: KEY + ':page:' + (course.name || '') + ':' + row.title,
    courseId: String(course.id || course.name || ''),
    courseName: course.name || '\u5e0c\u5180\u8bfe\u7a0b',
    title: row.title,
    taskType: /(\u5b9e\u9a8c|\u5b9e\u8bad|practice|shixun|\u4e0a\u673a)/i.test(row.title) ? 'practice' : 'homework',
    deadline: row.deadline,
    status: row.done ? 'done' : 'todo',
    // 这条来自「当前作业」区（还没截止）。补日期时用它挡住过去的日期，
    // 免得一条 11-20 才交的作业被塞个半年前的日期、跳到「已过期」里去。
    // 只在本机抓取过程用，pushTasks 不会把它写进库。
    inCurrent: row.inCurrent === true,
    progress: null,
    url: linkFor(row.href, pageUrl)
  }
}

/**
 * 「作业时间：<b>2026-10-26 20:00:00</b> 至 <b>2026-11-07 23:59:00</b>」
 *
 * 真机轨迹（2026-10-27）确认：这是这套平台**唯一**给出截止的地方。
 * 在线作业页把「当前作业」的时间直接渲染出来，`至` 后面那个才是截止。
 * 列表里的 `<a>` 只有作业名；`index.jsp?courseID=&assignID=` 只返回 20852
 * 字节的外壳（内容靠 redirect.jsp / main.jsp 服务端渲染）——所以认这一条，
 * 比继续猜详情页地址有用得多。
 */
const RANGE_RE = new RegExp(
  '(?:作业时间|答题时间|起止时间|有效时间|开放时间)\\s*[:：]?[\\s\\S]{0,24}?' +
    '(\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}(?:[\\sT]+\\d{1,2}:\\d{2}(?::\\d{2})?)?)' +
    '[\\s\\S]{0,40}?(?:至|到|~|～|—|–)' +
    '[\\s\\S]{0,40}?' +
    '(\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}(?:[\\sT]+\\d{1,2}:\\d{2}(?::\\d{2})?)?)',
  'g'
)

/** `2026/11/7 23:59` → `2026-11-07T23:59:00`；没写时分按当天 23:59 */
function isoOf(x) {
  const m = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(String(x || ''))
  if (!m) return ''
  return (
    m[1] +
    '-' + ('0' + m[2]).slice(-2) +
    '-' + ('0' + m[3]).slice(-2) +
    'T' + (m[4] === undefined ? '23:59' : ('0' + m[4]).slice(-2) + ':' + m[5]) +
    ':' + (m[6] || '00')
  )
}

/** 这段「作业时间」前面最近的一个标题（一般是 `<h4>作业名</h4>`），用来判断时间属于哪条作业 */
function headingBefore(s, at) {
  const back = String(s || '').slice(Math.max(0, at - 1600), at)
  const g = /<h[1-6][^>]*>([\s\S]{0,220}?)<\/h[1-6]>/gi
  let m
  let last = ''
  while ((m = g.exec(back))) last = squeeze(m[1], 90)
  return last
}

/** 页面上每一段「作业时间」→ { start, end, at, title } */
function rangeBlocks(html) {
  const s = String(html || '')
  const out = []
  const g = new RegExp(RANGE_RE.source, 'g')
  let m
  let n = 0
  while ((m = g.exec(s)) && n < 40) {
    n++
    const end = toTs(isoOf(m[2]))
    if (!end) continue
    out.push({ start: toTs(isoOf(m[1])), end: end, at: m.index, title: headingBefore(s, m.index) })
  }
  return out
}

/** 比标题用：去标签、去空白、去标点（「序偶和关系 - 2026-2027(1)」对「序偶和关系」也算中） */
function normTitle(t) {
  return String(t || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[·・,，.。:：;；!！?？'"“”‘’()（）\[\]【】<>《》\-—_/\\|～~]+/g, '')
    .toLowerCase()
}

/**
 * 两个标题算不算同一条作业。
 *
 * 完全相等就认；只是「包含」的话要求**被包含的那边够长（≥4）**，
 * 否则「实验」「作业」这种通用词会到处命中——之前希冀这批任务的截止时间
 * 就是这么被张冠李戴的。
 */
function titleHit(h, want) {
  if (!h || !want) return false
  return h === want || (want.length >= 4 && h.indexOf(want) >= 0) || (h.length >= 4 && want.indexOf(h) >= 0)
}

/**
 * 把页面上的一段「作业时间」绑到**这一条**作业上，绑不上返回 0。
 *
 * 为什么必须绑：列表页只渲染「当前作业」那一块时间。要是见着日期就拿来用，
 * 10 条历史作业会全被塞上同一个截止时间——比「无截止」更坑人，
 * 用户会以为这些都还没过期。
 */
function deadlineForAssignment(html, aid, title) {
  const blocks = rangeBlocks(html)
  if (!blocks.length) return 0
  const want = normTitle(title)
  if (want.length >= 2) {
    for (let i = 0; i < blocks.length; i++) {
      const h = normTitle(blocks[i].title)
      if (h.length < 2) continue
      if (titleHit(h, want)) return blocks[i].end
    }
  }
  // 整页只有这一段：详情页就是这种（只有这一条作业的时间），可以放心用
  if (blocks.length === 1) {
    const ids = assignIdsIn(html)
    if (!ids.length || !aid || (ids.length === 1 && ids[0] === aid)) return blocks[0].end
  }
  return 0
}

/**
 * 给「在当前作业区」的作业补日期时的护栏：**不许补成过去**。
 *
 * 平台把还没截止的作业放在「当前作业」区（历史作业区才是过期的）。所以一条
 * 还在当前区的作业，它的截止一定没到；这时候从页面里捞出一个过去的日期，
 * 只可能是绑错了——串到了别的作业、或者把「初次提交时间 / 学期结束」当成了截止。
 *
 * 用户报障（2026-10-27）：「集合的概念截止 176 天了」。一条 11-20 才交的作业
 * 被塞了个半年多以前的日期，比「无截止时间」更坑人：它会跳到「已过期」组，
 * 还一直喊你交。
 *
 * 留 1 小时余量，防手机时间慢一点把自己刚过期的当天作业也挡掉。
 */
function deadlineFitsCurrent(t, ts) {
  if (!ts) return 0
  if (t && t.inCurrent === true && ts < Date.now() - 3600000) return 0
  return ts
}

/**
 * 把一页上的「作业时间」绑回这一页的作业行上（就地写 r.deadline，返回同一份 rows）。
 *
 * 真机（2026-10-27）：在线作业页左边是作业清单，右边只有**当前选中**那一条的
 * 「作业时间：A 至 B」。解析行时只看锚或锚所在的那一行，永远看不到右栏——
 * 于是轨迹里写着「作业行 10 条 / 带截止时间 0」，页面明明有日期却一条都没认出来。
 * 绑不上就不动，绝不把某一条的时间平摊给同页其它作业。
 */
function bindPageDeadlines(html, rows) {
  const list = rows || []
  if (!list.length || !rangeBlocks(html).length) return list
  list.forEach((r) => {
    if (!r || r.deadline || !r.assignId) return
    const ts = deadlineFitsCurrent(r, deadlineForAssignment(html, r.assignId, r.title))
    if (ts) r.deadline = ts
  })
  return list
}

/* ---------------- 交没交：把平台上的提交痕迹绑回作业行 ---------------- */

/**
 * 「这条作业交没交」在页面上的写法。
 *
 * 真机（2026-10-27）右栏「当前作业」是这样的：
 *
 *   <h4> 序偶和关系 - 2026-2027(1)</h4>
 *   <p> 作业时间：<b>2026-10-26 20:00:00</b> 至 <b>2026-11-07 23:59:00</b> </p>
 *   <table><tr><td>100.00</td><td>初次提交时间: 2026-10-27 11:08:40
 *                              最近一次提交时间: 2026-10-27 16:20:00</td></tr></table>
 *
 * 左边那列 `<a>` 上只有作业名，**一个「已提交」的字样都没有**；提交与否只体现在
 * 右栏这段「初次提交时间 / 最近一次提交时间」里。所以只看行的文字永远判成「待完成」，
 * 用户在平台上交完了，小程序里还得再长按标一次——这就是本段的由来。
 *
 * 只认这几种硬痕迹（认得越宽，误标「已完成」的风险越大）：
 *   · 提交时间：初次 / 最近一次 / 第一次提交时间、提交时间:、提交日期:
 *   · 状态词：已提交 / 已交 / 已批阅 / 已评分 / 已通过 / 已完成 / 已审阅 / 待批阅
 *     （「待批阅」是交上去还没批，算已提交）
 *   · 否定词：未提交 / 尚未提交 / 未交 / 待提交 / 未完成 → 明确算没交，
 *     并且**优先于**前面那些（页面同时出现时以否定为准）
 */
const SUBMIT_DONE = /(?:初次提交时间|最近一次提交时间|第一次提交时间|提交时间\s*[:：]|提交日期\s*[:：]|已提交|已交卷|已交作业|已批阅|已评分|已通过|已完成|已审阅|待批阅)/
const SUBMIT_TODO = /(?:未提交|尚未提交|未交卷|未交作业|待提交|尚未完成|未完成)/
/** 这些是栏目标题，不是作业名：出现在「标签之前」不该被当成归属 */
const GENERIC_HEAD = /^(?:在线作业|作业列表|作业详情|作业信息|当前作业|历史作业|作业|详情|首页|课程信息)$/

/** 整页的提交痕迹点：[{ at, done, word }]，按出现顺序 */
function submitMarks(html) {
  const s = String(html || '')
  const out = []
  const scan = (re, done) => {
    const g = new RegExp(re.source, 'g')
    let m
    let n = 0
    while ((m = g.exec(s)) && n < 80) {
      n++
      out.push({ at: m.index, done: done, word: m[0] })
    }
  }
  scan(SUBMIT_DONE, true)
  scan(SUBMIT_TODO, false)
  return out.sort((a, b) => a.at - b.at)
}

/**
 * 把这一页上的提交痕迹绑回作业行（就地写 r.done）。
 *
 * 归属判据和截止时间是同一套（右栏那块归它上面的 `<h4>` 标题）：
 *   ① 痕迹上方最近的标题 == 这条作业 → 认
 *   ② 整页只有这一条作业、且标题是「在线作业 / 作业详情」这类栏目名 → 认
 *   ③ 其它情况一律不动：宁可留着「待完成」让人手动标，也不能把别人的
 *      「已提交」安到这条头上
 *
 * 返回 rows 里被判成「已提交」的条数（给轨迹用）。
 */
function bindPageDone(html, rows) {
  const list = rows || []
  const s = String(html || '')
  const marks = submitMarks(s)
  if (!list.length || !marks.length) return 0
  // 每个痕迹只认一次归属，别按行重扫（一页十来条作业 × 十来个痕迹）
  marks.forEach((m) => {
    m.head = normTitle(headingBefore(s, m.at))
  })
  const ids = assignIdsIn(s)
  let hit = 0
  list.forEach((r) => {
    if (!r) return
    const want = normTitle(r.title)
    const single = !ids.length || (!!r.assignId && ids.length === 1 && ids[0] === String(r.assignId))
    let verdict = ''
    marks.forEach((m) => {
      if (want && m.head && titleHit(m.head, want)) verdict = m.done ? 'done' : 'todo'
      else if (single && (!m.head || GENERIC_HEAD.test(m.head))) verdict = m.done ? 'done' : 'todo'
    })
    if (!verdict) return
    r.done = verdict === 'done'
    // 这一行的状态是页面**明说**的（不是按「历史作业区」推的），轨迹和提示用得到
    r.pageDone = true
    if (r.done) hit++
  })
  return hit
}

/**
 * 这一页说这条作业交了没有：'done' / 'todo' / ''（页面没给痕迹）。
 * 给「单条作业」的场景用（补状态时只有一个作业号，没有整页 rows）。
 */
function submitStatusOf(html, aid, title) {
  const row = { assignId: String(aid || ''), title: title }
  bindPageDone(html, [row])
  if (typeof row.done !== 'boolean') return ''
  return row.done ? 'done' : 'todo'
}

/**
 * 从作业详情页里抠截止时间（不确定属于哪条作业时用）。
 *
 * 只认硬证据，认不出就返回 0 —— 编一个假时间比没有更坑人：
 *   ① 「作业时间：A 至 B」这一段（这套平台真正的截止，B 就是）
 *   ② 「截止 / 结束 / 到期」等关键词之后 120 字内的日期
 *   ③ JS 变量 / JSON 字段（endTime、end_time、deadline、dueDate…）的值
 *   ④ 整页只有一个日期时，就是它
 *
 * 注意：**「提交时间」不算**。这套平台的详情区还印着
 * 「初次提交时间: 2026-07-11 / 最近一次提交时间: 2026-07-13」，
 * 那是交作业的时刻，当成截止时间会直接把日期算到过去。
 */
function deadlineFromHtml(html) {
  const s = String(html || '')
  if (!s) return 0

  // ① 作业时间：A 至 B —— 硬证据
  const blocks = rangeBlocks(s)
  if (blocks.length === 1) return blocks[0].end
  // 多段说明这一页混着好几条作业，交给 deadlineForAssignment 按标题绑
  if (blocks.length > 1) return 0

  const KW = /(?:截止|结束|到期|有效时间|deadline|end[_\s-]?time|due[_\s-]?date)/i
  const km = KW.exec(s)
  if (km) {
    const win = s.slice(km.index, km.index + 120)
    const dm = DATE_RE.exec(win)
    if (dm) return dmToTs(dm)
    const short = shortDateTs(win)
    if (short) return short
  }

  const jm = /["']?(?:end_?time|end_?date|deadline|due_?(?:time|date)|expire_?time)["']?\s*[:=]\s*["']?([^"',;}\s]{6,40})/i.exec(
    s
  )
  if (jm) {
    const dm = DATE_RE.exec(jm[1])
    if (dm) return dmToTs(dm)
  }

  // 全文唯一日期：只有一种「年-月-日」组合时才敢用
  const g = new RegExp(DATE_RE.source, 'g')
  const uniq = {}
  let m
  let n = 0
  while ((m = g.exec(s)) && n < 20) {
    n++
    uniq[m.slice(1, 4).join('-')] = m.slice(0, 6)
  }
  const keys = Object.keys(uniq)
  if (keys.length === 1) return dmToTs(uniq[keys[0]])
  // 整页只有「12-20 23:59」这一种写法时，同样只在唯一时才敢用
  if (!keys.length) {
    const sg = new RegExp(SHORT_DATE.source, 'g')
    const set = {}
    let sm
    let sn = 0
    while ((sm = sg.exec(s)) && sn < 20) {
      sn++
      set[sm[2] + '-' + sm[3]] = 1
    }
    if (Object.keys(set).length === 1) return shortDateTs(s)
  }
  return 0
}

function aidOf(t) {
  const m = /:assign:(\d+)$/.exec(String((t && t.externalId) || ''))
  return m ? m[1] : ''
}

/**
 * 这一条作业的详情页候选写法（按可能性排序）。
 *
 * 真机轨迹（2026-10-27）：`index.jsp?courseID=40&assignID=861` 一律回 20852
 * 字节外壳；内容由 `/includes/redirect.jsp?tab=N` 服务端渲染。所以先按
 * 「redirect.jsp?tab=-2 + 作业号」试，再退到 main.jsp（外壳里那个 form 的目标），
 * 最后才是列表给的原始地址。
 */
function detailCandidates(t) {
  const base = getCfg().base
  const aid = aidOf(t)
  const cid = /^\d+$/.test(String((t && t.courseId) || '')) ? String(t.courseId) : ''
  const out = []
  const add = (c) => {
    if (!c.url) return
    const key = c.url + '|' + (c.method || 'GET')
    if (out.some((x) => x.url + '|' + (x.method || 'GET') === key)) return
    out.push(c)
  }
  const q = (cid ? 'courseID=' + cid + '&' : '') + 'assignID=' + aid
  if (aid && cid) {
    // 先把外壳按作业号点一下（大概率只是 20852 字节的空壳，但它可能顺手把
    // 「当前选中的作业」写进 session），再读在线作业页——那页才会渲染这一条。
    add({
      url: base + '/includes/redirect.jsp?tab=-2&courseID=' + cid,
      prelude: base + '/index.jsp?' + q,
      label: '先点作业再读在线作业页'
    })
  }
  if (aid) {
    add({ url: base + '/includes/redirect.jsp?tab=-2&' + q, label: 'redirect tab=-2 + 作业号' })
    add({
      url: base + '/includes/redirect.jsp?tab=-2&assignID=' + aid,
      label: 'redirect tab=-2 + 作业号（不带课程号）'
    })
    add({ url: base + '/main.jsp?tab=-2&' + q, label: 'main.jsp + 作业号' })
  }
  if (t.url) add({ url: t.url, label: '列表里的地址' })
  if (aid) {
    add({ url: base + '/index.jsp?' + q, label: '根目录 index.jsp' })
    add({ url: base + '/main.jsp', method: 'POST', body: 'tab=-2&' + q, label: 'POST main.jsp' })
  }
  return out
}

/** 这条任务按「作业号」在站点根目录拼的详情页地址（早期实现，保留给测试） */
function altDetailUrl(t) {
  const m = /:assign:(\d+)$/.exec(String((t && t.externalId) || ''))
  if (!m) return ''
  const cid = /^\d+$/.test(String((t && t.courseId) || '')) ? String(t.courseId) : ''
  return getCfg().base + '/index.jsp?' + (cid ? 'courseID=' + cid + '&' : '') + 'assignID=' + m[1]
}

/**
 * 给还缺截止时间的任务补日期。
 *
 * 两条硬要求：
 *  · 限总时长 —— 内网一次请求一两秒，几十条逐个打开会把同步拖过一分钟，用户以为卡死
 *  · 先探路再批量 —— 详情页写法有好几种可能，只用第 1 条把写法试一遍，
 *    哪种能出日期就固定用哪种；全都出不来就立刻收手，不再拿剩下 11 条空跑
 *
 * 顺序也是故意的：先按课程打一次「在线作业」页（一次请求就能绑上「当前作业」那条），
 * 再对剩下的逐条开详情页。反过来做的话，12 条要先空跑 12 次才轮到这一步。
 */
async function fillDeadlines(tasks, trace, pages, stat) {
  const all = (tasks || []).filter((t) => t && !t.deadline)
  if (!all.length) return 0
  // 抓在手里的「在线作业」页（课程号 → html）：页面上就有「作业时间：A 至 B」，
  // 按标题绑回去就行，一个请求都不用发。之前这里按课程号重新请求，
  // 但真机上是 3 门课拿回同一个 session 页面（都是 22623 字节、同一门课的内容），
  // 于是只有 session 里那门课绑上了，另外两门全是 0。
  const cache = pages || {}
  // 探路最多 4 次 + 少量批量；预算比之前收紧，省下来的时间留给扫描
  const MAX = 14
  const BUDGET = 12000
  const t0 = Date.now()
  const lines = []
  let tried = 0
  let got = 0

  /** 从一页 HTML 里抠「属于这一条作业」的日期；认不出返回 0 */
  const sniff = (raw, t) => {
    const aid = aidOf(t)
    let ts = deadlineForAssignment(raw, aid, t.title)
    if (ts) return deadlineFitsCurrent(t, ts)
    // 绑不上时，只对「整页只有这一条作业」的详情页放宽到通用解析：
    // 别的平台的详情页压根没有「作业时间：A 至 B」，只有一句「截止时间：…」。
    // 但列表页（一页好几条作业）绝不放宽，否则会张冠李戴。
    const ids = assignIdsIn(raw)
    const single = !ids.length || (!!aid && ids.length === 1 && ids[0] === aid)
    return single ? deadlineFitsCurrent(t, deadlineFromHtml(raw)) : 0
  }

  /** 打开一个候选地址，只认「能绑到这一条作业上」的日期 */
  const openCand = async (c, t) => {
    /**
     * 顺手把「交没交」也读一下。
     *
     * 扫列表页时右栏只渲染「当前选中」那一条，别的作业的提交状态根本不在页面上；
     * 而这里为了补日期会把作业一个个点开（prelude / 详情候选），点开之后右栏
     * 就切到了这一条——这正是唯一能读到它「初次提交时间」的时机，白扔太可惜。
     * 判定仍走 bindPageDone 那套（标题必须对上），不会张冠李戴。
     */
    const markDone = (raw) => {
      if (!raw || t.status === 'done') return
      if (submitStatusOf(raw, aidOf(t), t.title) !== 'done') return
      t.status = 'done'
      if (stat) stat.submitted = (stat.submitted || 0) + 1
      lines.push('  ' + squeeze(t.title, 30) + '：打开后显示已提交 → 已标为已完成')
    }
    const opt = { accept: 'text/html', timeout: 8000 }
    if (c.prelude) {
      // 前一步是「点一下这条作业」。它自己的响应也值得看一眼：
      // 有的部署里 index.jsp?assignID= 就直接是详情页，白白扔掉太可惜。
      try {
        const pre = await request(c.prelude, opt)
        if (pre && pre.status < 400 && !isLoginPage(pre)) {
          markDone(pre.raw)
          const pTs = sniff(pre.raw, t)
          if (pTs) {
            return {
              ts: pTs,
              raw: pre.raw,
              url: c.prelude,
              note: pre.status + ' / ' + pre.raw.length + ' 字节（点的这一下就是详情页） → 绑到这条作业'
            }
          }
        }
      } catch (e) {
        /* 点不到就继续，后面那步自己会回默认页，标题匹配会挡住张冠李戴 */
      }
    }
    if (c.method === 'POST') {
      opt.method = 'POST'
      opt.body = c.body
      opt.header = { 'Content-Type': 'application/x-www-form-urlencoded' }
    }
    const res = await request(c.url, opt)
    const bad = res.status >= 400 || isLoginPage(res)
    if (!bad) markDone(res.raw)
    // 外壳页的特征：里面有 mainFrame 这个 iframe，且正文啥都没有
    const shell = /name=["']?mainFrame/i.test(res.raw) && res.raw.length < 30000
    const ts = bad ? 0 : sniff(res.raw, t)
    return {
      ts: ts,
      raw: res.raw,
      url: c.url,
      note:
        res.status + ' / ' + res.raw.length + ' 字节' +
        (bad ? '（登录页或错误页）' : '') +
        (shell ? '（外壳页）' : '') +
        (ts ? ' → 绑到这条作业' : ' → 没绑到这条作业')
    }
  }

  // ── 第一步：每门课一次「在线作业」页。优先用扫描阶段已经抓下来的那份，
  //    没有再发请求。这套平台把**当前作业**的时间（作业时间：A 至 B）直接渲染
  //    在列表页右栏，一次就能按标题绑给对应那条。
  const byCourse = {}
  all.forEach((t) => {
    const cid = /^\d+$/.test(String(t.courseId || '')) ? String(t.courseId) : ''
    if (!cid) return
    ;(byCourse[cid] = byCourse[cid] || []).push(t)
  })
  const cids = Object.keys(byCourse)
  for (let i = 0; i < cids.length; i++) {
    const cid = cids[i]
    const group = byCourse[cid]
    let html = cache[cid] || ''
    let reused = !!html
    if (!html) {
      if (tried >= MAX || Date.now() - t0 > BUDGET) break
      tried++
      try {
        const res = await request(getCfg().base + '/includes/redirect.jsp?tab=-2&courseID=' + cid, {
          accept: 'text/html',
          timeout: 8000
        })
        html = res.status >= 400 || isLoginPage(res) ? '' : res.raw
      } catch (e) {
        lines.push('  课程 ' + cid + ' 的在线作业页打不开：' + squeeze(e.message, 40))
        continue
      }
    }
    if (!html) continue
    const blocks = rangeBlocks(html)
    let hit = 0
    group.forEach((t) => {
      if (t.deadline) return
      // 还在「当前作业」区的作业，截止不可能在过去：捞到过去日期说明绑错了，宁可留空
      const raw = deadlineForAssignment(html, aidOf(t), t.title)
      const ts = deadlineFitsCurrent(t, raw)
      if (ts) {
        t.deadline = ts
        got++
        hit++
      } else if (raw && t.inCurrent) {
        // 挡掉了要说一声，否则用户看到的还是「无截止」，不知道为什么
        lines.push(
          '  ' + squeeze(t.title, 26) + '：页面给的截止是 ' + fmtTs(raw) +
            '（已经过去），但它在「当前作业」区，已忽略——多半是串到别的作业身上了'
        )
      }
    })
    const ids = assignIdsIn(html)
    lines.push(
      '  课程 ' + cid + '：' + group.length + ' 条缺日期，页面作业时间 ' + blocks.length +
        ' 段，绑上 ' + hit + ' 条' + (reused ? '（复用扫描已抓的页面）' : '') +
        // 页面有作业、却只渲染一段作业时间 —— 平台只给「当前作业」那一条，其余没有
        (blocks.length === 1 && ids.length > 1 ? '；这页共 ' + ids.length + ' 条作业，其余不渲染时间' : '')
    )
  }

  // ── 第二步：还缺的逐条开详情页（先探路，再批量）
  const rest = all.filter((t) => !t.deadline)
  if (rest.length) {
    let pattern = -1
    // 候选写法按可能性排序；真机上第 1 种就会拿回「已解析过的那个页面」，
    // 下面那道比对会立刻收手，所以不必提前截断（别的平台可能是第 5 种才灵）
    const cands0 = detailCandidates(rest[0])
    for (let k = 0; k < cands0.length; k++) {
      if (tried >= MAX || Date.now() - t0 > BUDGET) break
      tried++
      try {
        const r = await openCand(cands0[k], rest[0])
        lines.push('  [' + (k + 1) + '] ' + cands0[k].label + ' → ' + r.note)
        if (!r.ts && k === 0) lines.push('      原文：' + clip(r.raw, 180))
        if (r.ts) {
          pattern = k
          rest[0].deadline = r.ts
          // 指向真正能出日期的那一个地址（可能是「先点作业」那一步），
          // 首页点「打开」才不会再落到 404 的拼错路径上
          rest[0].url = r.url || cands0[k].url
          got++
          lines.push('  ✓ 详情页有效写法：' + cands0[k].label)
          break
        }
        // 返回的和已经解析过的那个在线作业页逐字节相同 → 服务端把参数当空气，
        // 换别的写法只会再拿一次同一页，立刻收手
        const fork = Object.keys(cache)
        let same = false
        for (let q = 0; q < fork.length; q++) {
          if (cache[fork[q]] === r.raw) {
            same = true
            break
          }
        }
        if (same) {
          lines.push('      （和已解析过的在线作业页一模一样，地址里的作业号被忽略）')
          break
        }
      } catch (e) {
        lines.push('  [' + (k + 1) + '] ' + cands0[k].label + ' → 失败：' + squeeze(e.message, 40))
      }
    }
    if (pattern < 0) {
      lines.push('  ✗ ' + cands0.length + ' 种详情页写法都没绑上，剩下的不再空跑')
      lines.push(
        '  （这套平台只在在线作业页渲染「当前作业」那一条的作业时间；其余作业没有单独时间可读，' +
          '详情页一律是 20852 字节的外壳）'
      )
    } else {
      for (let i = 1; i < rest.length; i++) {
        if (tried >= MAX || Date.now() - t0 > BUDGET) break
        const c = detailCandidates(rest[i])[pattern]
        if (!c) continue
        tried++
        try {
          const r = await openCand(c, rest[i])
          if (lines.length < 9) lines.push('  #' + (i + 1) + ' ' + r.note)
          if (r.ts) {
            rest[i].deadline = r.ts
            got++
          }
        } catch (e) {
          if (lines.length < 9) lines.push('  #' + (i + 1) + ' 失败：' + squeeze(e.message, 40))
        }
      }
    }
  }

  trace.push('补截止时间：缺 ' + all.length + ' 条，试了 ' + tried + ' 次，补上 ' + got + ' 条')
  lines.forEach((x) => trace.push(x))
  return got
}

/**
 * 页面模式的课程：打开课程页 → 解析行 → 变成任务。
 * 返回这次用的是第几种拼法（-1 表示没成功），后面的课程直接沿用。
 */
async function syncPageCourse(course, docPath, baseHref, trace, tasks, seen, only) {
  const name = String(course.name || course.href).slice(0, 24)
  const hit = await openByCandidates(course.href, docPath, baseHref, typeof only === 'number' && only >= 0 ? { only: only } : {})
  if (!hit.res) {
    trace.push(name + ' \u6253\u4e0d\u5f00\uff08' + hit.tried.join('\uff1b') + '\uff09')
    return -1
  }
  // 课程页里有 assignID（在线作业那种写法）就按 assignRows 解析——它懂得
  // 「作业名在 td 里、链接只有『进入作业』」这套平台的怪写法，还能按作业号去重。
  // 没有 assignID 的（老版 jobID 之类）才退到 parseRows。
  const arows = assignRows(hit.html)
  const rows = arows.length ? arows : parseRows(hit.html)
  const dated = rows.filter((r) => r.deadline > 0)
  trace.push(
    name + ' ' + hit.html.length + ' \u5b57\u8282 / \u8868\u683c\u884c ' + hit.size.tr +
      ' / \u53ef\u89e3\u6790\u884c ' + rows.length + ' / \u5e26\u622a\u6b62\u65f6\u95f4 ' + dated.length
  )
  // 有作业号的行一律收：作业号是硬证据（不会把菜单当作业），日期缺了后面能补
  // （fillDeadlines 去详情页捞）；纯 parseRows 的行没有作业号，仍旧只认带日期的。
  const usable = arows.length ? rows : dated
  if (!usable.length) {
    const sample = rows.slice(0, 3).map((r) => r.title).join(' | ')
    trace.push(name + '\uff1a\u6ca1\u6562\u731c' + (sample ? '\uff08\u884c\u91cc\u6709\uff1a' + sample + '\uff09' : '\uff08\u6ca1\u6709 \u6807\u9898+\u65e5\u671f \u7684\u884c\uff09'))
    return -1
  }
  const made = usable.map((r) => {
    const t = pageTask(course, r, hit.url)
    // 有作业号就用作业号做稳定键（跨页/改标题都能对上），没有才退到页面键
    if (r.assignId) t.externalId = KEY + ':assign:' + r.assignId
    return t
  })
  const sem = tagSemester(made, { name: course.name })
  // 课程页里通常没有开课时间：学期判不出来就按当前学期记，
  // 否则首页默认只看本学期，这些任务会「同步成功但看不到」，更让人懵
  if (sem && sem.key === SEM.UNKNOWN.key) {
    const cur = SEM.current()
    made.forEach((t) => {
      t.semesterKey = cur.key
      t.semesterLabel = cur.label
      t.semesterShort = cur.short
      t.semesterRank = cur.rank
    })
    trace.push(name + '\uff1a\u9875\u9762\u6ca1\u6709\u5f00\u8bfe\u65f6\u95f4\uff0c\u6309\u5f53\u524d\u5b66\u671f\u8bb0')
  }
  let n = 0
  made.forEach((t) => {
    if (seen.has(t.externalId)) return
    seen.add(t.externalId)
    tasks.push(t)
    n++
  })
  trace.push(name + '\uff1a\u89e3\u6790\u51fa ' + n + ' \u6761')
  return hit.shape
}

/**
 * 抓一遍希冀的任务。
 *
 * 两条路都留着，因为「希冀」有两套完全不同的部署：
 *   1. 公网头歌（www.educoder.net）/ 开了接口的部署 → 走 JSON 接口，最准
 *   2. 学校自建的 JSP 版（educg，就是 10.67.4.14 这套）→ 目前只确认了登录，
 *      作业页的路径还得靠「连通性探测」摸一次，摸清了才能写解析
 *
 * 走不通时把整条轨迹抛出来，让人知道卡在哪一步，而不是干巴巴一句「失败了」。
 */
async function sync() {
  const cfg = getCfg()
  if (!cfg.cookie) throw new Error('还没登录希冀（先在下面填学号密码登录一次）')

  const trace = []
  // 首页都打不开（被跳登录页）就别往下试了，先让人重新登录
  const home = await openHome()
  if (!home) throw new Error('登录已失效（访问首页被跳回登录页），重新登录一次')

  trace.push('首页 ' + home.raw.length + ' 字节 / ' + (titleOf(home.raw) || '无标题'))
  // 首页里那些相对链接该拼到哪个目录：后面打开课程页时要用同一套拼法
  const docPath = pathOf(home.url || '/')
  const baseHref = baseTagOf(home.raw)

  // 1) 我的课程（头歌学生端真实在用的接口）
  const c1 = await getJsonList(
    ['/api/courses/mine.json', '/api/courses.json?scope=joined', '/api/courses.json', '/api/mycourses.json'],
    trace
  )
  let courses = c1.list

  // 2) 老版部署：课堂 → 课程（上面已经确认这套部署没有 JSON 接口就别试了）
  if (!courses.length && !c1.html) {
    const schools = await getJsonList(['/api/myschools.json', '/api/schools.json'], trace)
    if (schools.list.length) {
      const ids = schools.list
        .map((x) => pick(x, ['id', 'school_id'], ''))
        .filter(Boolean)
        .slice(0, 6)
      for (let i = 0; i < ids.length; i++) {
        const r = await getJsonList(
          [`/api/schools/${ids[i]}/courses.json?scope=joined`, `/api/schools/${ids[i]}/courses.json`],
          trace
        )
        courses = courses.concat(r.list)
      }
    }
  }

  // 3) 还没有 → 从页面里摸（首页是外壳时，作业列表在 tab 页里）
  let pageDocPath = docPath
  let found = null
  if (!courses.length) {
    found = await collectCourses(home, trace)
    pageDocPath = found.docPath || docPath
    if (found.courses.length) {
      trace.push('从页面认出 ' + found.courses.length + ' 门课程')
      courses = found.courses.map((c) => ({ id: c.id, name: c.name, href: c.href, docPath: c.docPath }))
    }
  }

  const tasks = []
  const seen = new Set()

  // 3.5) 「在线作业」这类列表页：一页就是一批任务，直接解析，不用再进课程
  //      （这套平台的课程/作业详情页是 JS 外壳，进去只会拿到同一个 20852 字节的壳）
  let listRows = 0
  // 已经抓到手的「在线作业」页，按课程号索引：页面上的「作业时间：A 至 B」
  // 就是这套平台唯一的截止时间来源，后面补日期直接复用，不用再请求一次
  const pageByCourse = {}
  const pageNotes = []
  // 这一趟「页面上明确显示已提交」的条数，同步完要跟用户说一声：
  // 它们会被自动归到「已完成」，不说的话用户会以为任务丢了
  let submittedN = 0
  const absorbList = (p, fallbackName) => {
    const rows = assignRows(p.html)
    const nid = (found && found.nameById) || {}
    bindPageDeadlines(p.html, rows)
    // 右栏「初次提交时间 / 已批阅」按标题绑回左栏那一条：
    // 平台把「交没交」只写在当前作业那一块，列表锚上什么标记都没有
    const doneN = bindPageDone(p.html, rows)
    const blocks = rangeBlocks(p.html)
    rows.forEach((r) => {
      if (r.courseId && p.html) pageByCourse[String(r.courseId)] = p.html
    })
    if (rows.length && blocks.length) {
      const dated = rows.filter((r) => r.deadline > 0).length
      pageNotes.push(
        '  ' + (p.label || '在线作业页') + '：' + rows.length + ' 条作业，页面只渲染 ' +
          blocks.length + ' 段作业时间（绑上 ' + dated + ' 条）' +
          (blocks.length < rows.length ? '，其余 ' + (rows.length - dated) + ' 条平台没给时间' : '')
      )
    }
    // 交没交单独交代一句：用户最直观的疑问就是「我明明交了，怎么还挂在待办里」
    if (rows.length && doneN) {
      pageNotes.push('  ' + (p.label || '在线作业页') + '：页面显示已提交 ' + doneN + ' 条，已标为已完成')
    } else if (rows.length) {
      // 有痕迹却一条都没绑上：说明状态写的不是「标题 → 内容」这种结构，
      // 下次再查就知道该看哪儿（不然只会得出「同步了但还是没完成」）
      const marks = submitMarks(p.html).length
      if (marks) {
        pageNotes.push(
          '  ' + (p.label || '在线作业页') + '：页面上有 ' + marks + ' 处提交痕迹，但标题对不上任何一条作业，没敢自动标完成'
        )
      }
    }
    rows.forEach((r) => {
      listRows++
      const name = fallbackName || nid[r.courseId] || guessCourseName(r, nid)
      const t = pageTask({ id: r.courseId, name: name }, r, p.pagePath)
      // 作业号是稳定的，跨页 / 改标题都能对上
      t.externalId = KEY + ':assign:' + r.assignId
      if (seen.has(t.externalId)) return
      seen.add(t.externalId)
      // 只数「页面明说已提交」的那几条（历史作业区按规则推的 done 不数进去），
      // 免得同步完跟用户说「8 条已完成」，其实是 8 条过期了
      if (t.status === 'done' && r.pageDone) submittedN++
      tasks.push(t)
    })
    return rows
  }

  if (found && found.lists.length) {
    found.lists.forEach((p) => {
      const rows = absorbList(p)
      const dated = rows.filter((r) => r.deadline > 0).length
      trace.push(p.label + '：作业行 ' + rows.length + ' 条 / 带截止时间 ' + dated)
      // 一条都没日期时把首行原文带上：日期写没写、写在哪，看一眼就清楚
      if (rows.length && !dated) trace.push('  ' + rowProbe(p.html))
    })
  }

  // 3.6) 「其他的」：换课程 / 换栏目 / 翻页。真机上 tab=-2 只列「当前课程」，
  //      不补这一步，结果就是「同步成功，但只有一门课那一条」
  let scanTrace = []
  if (found) {
    let extra = []
    try {
      // 12 秒：后面还要逐课打开课程页，别让补扫把整趟同步拖过 20 秒
      extra = await scanMore(found, scanTrace, { maxMs: 12000 })
    } catch (e) {
      scanTrace.push('补充扫描失败：' + squeeze(e.message, 40))
    }
    extra.forEach((p) => {
      const rows = absorbList(p, p.courseName)
      const dated = rows.filter((r) => r.deadline > 0).length
      scanTrace.push('补充 ' + p.label + '：作业行 ' + rows.length + ' 条 / 带截止时间 ' + dated)
      // 补充扫进来的页（换课程后的在线作业）才是任务大头，日期有没有同样要交代
      if (rows.length && !dated) scanTrace.push('  ' + rowProbe(p.html))
      // 诊断：页面里 assignCount 数到的作业号远多于真正解析出来的行数，
      // 说明有几条作业因为写法特殊被丢了。把原始标签打出来定位。
      if (p.n && p.n >= 3 && rows.length <= 1) {
        scanTrace.push('  ⚠ 这页 assignCount 数到 ' + p.n + ' 个作业号，却只解析出 ' + rows.length + ' 行，原始标签：')
        const li = String(p.html).match(/<li\b[\s\S]{0,400}?<\/li>/gi) || []
        li.slice(0, 6).forEach((x) => scanTrace.push('    · ' + clip(x, 320)))
        if (!li.length) {
          const tr = String(p.html).match(/<tr\b[\s\S]{0,400}?<\/tr>/gi) || []
          tr.slice(0, 6).forEach((x) => scanTrace.push('    · ' + clip(x, 320)))
        }
        const d = String(p.html).match(/<div\b[^>]*(?:assign|work|job|homework)[\s\S]{0,400}?<\/div>/gi) || []
        d.slice(0, 6).forEach((x) => scanTrace.push('    · ' + clip(x, 320)))
      }
    })
  }
  // 「页面有作业时间，但只覆盖其中几条」必须说出来：否则用户看到 9 条「无截止」，
  // 会以为是解析器又坏了，其实平台就只渲染了当前作业那一条
  pageNotes.forEach((x) => scanTrace.push(x))

  // 统一打学期标签（补扫进来的也算上）：页面里没有开课时间，就按当前学期记，
  // 否则首页默认只看本学期，这些任务会「同步成功但看不到」
  if (found && tasks.length) {
    const sem = tagSemester(tasks, { name: '' })
    if (sem && sem.key === SEM.UNKNOWN.key) {
      const cur = SEM.current()
      tasks.forEach((t) => {
        t.semesterKey = cur.key
        t.semesterLabel = cur.label
        t.semesterShort = cur.short
        t.semesterRank = cur.rank
      })
    }
  }

  // 4) 逐课抓作业
  let pageCourses = 0
  let pageShape = -1
  for (let i = 0; i < courses.length && i < 20; i++) {
    const course = courses[i]

    // 从页面链接认出来的课程没有数字 id，只有 href。这种绝不能拿去拼
    // /api/courses/{id}/... —— 会拼出一串必然 404 的垃圾地址，把轨迹刷满。
    if (course.href) {
      pageCourses++
      // 前 6 门尝试按页面解析（多了太慢，内网一次请求就要一两秒）
      if (pageCourses <= 6) {
        const shape = await syncPageCourse(course, course.docPath || pageDocPath, baseHref, trace, tasks, seen, pageShape)
        if (shape > -1) pageShape = shape
      }
      continue
    }

    const cid = pick(course, ['id', 'course_id'], '')
    if (!cid) continue
    const r = await getJsonList(taskPaths(cid), trace)
    if (!r.list.length) continue
    const made = []
    r.list.forEach((raw) => {
      if (!raw) return
      const t = toTask(course, raw, cfg.base)
      if (t) made.push(t)
    })
    tagSemester(made, course)
    made.forEach((t) => {
      if (seen.has(t.externalId)) return
      seen.add(t.externalId)
      tasks.push(t)
    })
  }

  // 补扫的轨迹放在最后：报错信息只截前 800 字，得先保住「哪一门打不开」
  scanTrace.forEach((x) => trace.push(x))

  // 已经有作业时间的任务不用再补；剩下的先用「抓在手里的页面」按标题绑一遍，
  // 绑不到才去开详情页（这套平台的详情页只是外壳，绝大多数情况白跑）
  const fillStat = { submitted: 0 }
  if (tasks.length) await fillDeadlines(tasks, trace, pageByCourse, fillStat)
  submittedN += fillStat.submitted || 0

  if (tasks.length) return { tasks: tasks, trace: trace, count: tasks.length, submitted: submittedN }

  if (!courses.length && !listRows) {
    throw new Error('读到首页但没找到课程，也没有作业列表。轨迹：' + trace.join('；'))
  }

  // 5) 有课程 / 有列表但一条都没解析出来
  const trail = trace.join('；')
  // 列表页明明有作业号、却一行都没解析出来时，把原始标签带上——
  // 作业号写在哪个属性上，看一眼就知道该怎么改，不用再来回一轮
  let snippet = ''
  if (found && found.lists.length && !listRows) {
    const html = String(found.lists[0].html || '')
    const a = /<a\b[^>]*assign[^>]*>[\s\S]{0,160}?<\/a>/i.exec(html)
    if (a) snippet = ' 原始标签：' + clip(a[0], 200)
    else {
      const at = html.toLowerCase().indexOf('assign')
      if (at > -1) snippet = ' 附近原文：' + clip(html.slice(Math.max(0, at - 160), at + 160), 260)
    }
  }
  throw new Error(
    '登录正常' +
      (courses.length ? '，课程读到 ' + courses.length + ' 门' : '') +
      (listRows ? '，作业行看到 ' + listRows + ' 条' : '') +
      '，但一条都没解析成任务（宁缺不猜）。请点「连通性探测」，把卡片下面那份结果（右下角「复制结果」）发我。' +
      snippet +
      ' 轨迹：' +
      (trail.length > 800 ? trail.slice(0, 800) + '…' : trail)
  )
}

async function syncAndPush() {
  const r = await sync()
  const res = await api.pushTasks('educoder', r.tasks)
  saveCfg({ lastSync: Date.now() })
  return {
    count: (res && res.count) || r.tasks.length,
    trace: r.trace,
    tasks: r.tasks,
    // 页面明说「已提交」的条数：账号页同步完要跟用户交代一句
    submitted: r.submitted || 0
  }
}

module.exports = {
  getCfg,
  saveCfg,
  captcha,
  login,
  status,
  logout,
  probe,
  linksFromPage,
  sync,
  syncAndPush,
  splitSetCookie,
  mergeCookie,
  parseCookie,
  stringifyCookie,
  isLoginPage,
  errorText,
  gifRatio,
  // 供测试直接校验「这一行 HTML 能不能变成作业」（不经过网络与摸页预算）
  assignRows,
  assignCount,
  // 截止时间解析（详情页补日期用，测试直接校验）
  deadlineFromHtml,
  // 「作业时间：A 至 B」——这套平台唯一给出截止的地方，B 才是截止
  rangeBlocks,
  // 把一段「作业时间」按标题绑到具体某条作业上（列表页只有「当前作业」那一段）
  deadlineForAssignment,
  // 整页绑一遍：解析完一页作业行之后调用（右栏的作业时间绑回左边对应的那条）
  bindPageDeadlines,
  // 交没交：右栏「初次提交时间 / 已批阅」按标题绑回左边对应的那条
  bindPageDone,
  submitMarks,
  submitStatusOf,
  detailCandidates,
  // 把锚扩成整行（列表页日期写在锚的兄弟节点里，只解析锚永远拿不到）
  containerOf,
  rowProbe,
  // 详情页补日期（测试直接喂任务，不经过整个 sync）
  fillDeadlines,
  altDetailUrl,
  assignKey,
  optionRefs,
  nextPagePaths,
  scanMore,
  BUILD,
  DEFAULT_BASE,
  AES_KEY
}
