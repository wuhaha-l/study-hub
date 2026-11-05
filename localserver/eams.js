#!/usr/bin/env node
/**
 * 郑州大学教务系统（EAMS / 教学管理信息系统）课表导入。
 *
 * 学校用的是复旦 URP 系的 EAMS：
 *   https://jw.v.zzu.edu.cn/eams/login.action
 *
 * 两条路都能走通，按顺序尝试：
 *   A. 账号密码自动登录 —— 有图形验证码就把图给前端、用户自己填（不做 OCR）
 *   B. 粘 Cookie        —— 用户在自己浏览器里正常登录后把 Cookie 整串贴进来
 *
 * 为什么不在云函数里做：
 *   教务系统基本只对校园网 / 校园 VPN 开放，机房 IP 进不去；
 *   Cookie 也不该上云。所以这个模块只在 localserver 里跑。
 *
 * 课表解析的地道做法：
 *   EAMS 每个格子都带「周一第1,2节{第1-16周}」这种短文本，
 *   把整格拍平成一行 「周一 1-2节 高等数学 二教101 1-16周」，
 *   再交给 miniprogram/utils/schedule.js 里那套已经打磨过的 parseLine。
 *   一份解析逻辑两处用，手动粘贴和教务导入永远同一个行为。
 */

const path = require('path')
const crypto = require('crypto')

const HTTP = require(path.join(__dirname, '..', 'cloudfunctions', 'studyHub', 'lib', 'http'))
const S = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'schedule'))

const DEFAULT_BASE = 'https://jw.v.zzu.edu.cn'

/** 不同部署的入口前缀不一样，按顺序探 */
const PREFIXES = ['/eams', '']

/** 登录后的落地页，用来判定成功 */
const HOME_RE = /(home\.action|main\.action|index\.action|dashboard|courseTableForStd|stdSchedule)/i

/* ------------------------------------------------------------------ */
/* 文本工具                                                            */
/* ------------------------------------------------------------------ */

const ENT = {
  nbsp: ' ', ensp: ' ', emsp: ' ', amp: '&', lt: '<', gt: '>',
  quot: '"', apos: "'", '#39': "'", '#160': ' ', '#x27': "'"
}

function decodeEntities(s) {
  return String(s || '').replace(/&(#?[a-z0-9]+);/gi, (m, k) => {
    const key = String(k).toLowerCase()
    return Object.prototype.hasOwnProperty.call(ENT, key) ? ENT[key] : m
  })
}

/** 标签拍平：<br> 转换行，其余标签变空格 */
function stripTags(s) {
  return decodeEntities(
    String(s || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function pick(re, s) {
  const m = String(s || '').match(re)
  return m ? String(m[1]).trim() : ''
}

/** 登录页上的报错文案，原样回给用户，比自己编话有用 */
function errorMessageOf(html) {
  const t = stripTags(html || '')
  const patterns = [
    /(用户名或密码[^\n。]{0,30})/,
    /(密码错误[^\n。]{0,20})/,
    /(验证码[^\n。]{0,20})/,
    /(用户不存在[^\n。]{0,20})/,
    /(账号[^\n。]{0,15}锁定[^\n。]{0,15})/,
    /(登录失败[^\n。]{0,25})/
  ]
  for (let i = 0; i < patterns.length; i++) {
    const m = t.match(patterns[i])
    if (m) return m[1].replace(/\s+/g, ' ').trim()
  }
  return ''
}

/* ------------------------------------------------------------------ */
/* 站点探测                                                            */
/* ------------------------------------------------------------------ */

function normBase(base) {
  const b = String(base || DEFAULT_BASE).trim().replace(/\/+$/, '')
  return b || DEFAULT_BASE
}

/**
 * 找出这台机器能不能访问教务系统，以及登录页长什么样。
 * @returns {{reachable:boolean, base:string, prefix:string, loginUrl:string,
 *            needCaptcha:boolean, captchaUrl:string, fields:Object,
 *            cas:boolean, error:string, hint:string}}
 */
async function probe(base, jar) {
  const root = normBase(base)
  const out = {
    reachable: false,
    base: root,
    prefix: '',
    loginUrl: '',
    needCaptcha: false,
    captchaUrl: '',
    fields: {},
    cas: false,
    error: '',
    hint: ''
  }

  for (let i = 0; i < PREFIXES.length; i++) {
    const prefix = PREFIXES[i]
    const url = root + prefix + '/login.action'
    let res
    try {
      res = await HTTP.request(url, { jar: jar || new HTTP.CookieJar(), timeout: 15000, maxRedirect: 6 })
    } catch (e) {
      const msg = String((e && e.message) || e)
      out.error = msg
      if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
        out.hint = '域名解析不出来。先确认这台电脑本身能上网。'
      } else if (/CERT|SSL|TLS|self.signed/i.test(msg)) {
        out.hint = '证书握手失败。学校证书比较老，或者这台电脑装了抓包工具（如 Fiddler / Clash 的 MITM）。先把代理软件关掉再试。'
      } else if (/ECONNREFUSED|ETIMEDOUT|timeout|超时|socket hang up|ECONNRESET|UND_ERR/i.test(msg)) {
        out.hint =
          '连不上教务系统 —— 它基本只对校园网开放。\n' +
          '先做这一步验证：用你这台电脑的浏览器打开 ' + url + '\n' +
          '能打开 → 回来重试；打不开 → 连 ZZU-WLAN 或学校 VPN。'
      } else {
        out.hint = '访问 ' + url + ' 失败：' + msg + '\n先确认浏览器能打开教务系统，再回来试。'
      }
      continue
    }

    if (res.status === 502 || res.status === 503 || res.status === 504) {
      out.error = 'HTTP ' + res.status
      out.hint =
        '学校那边返回 ' + res.status + '（网关错误）。通常是服务维护中，或者只允许校内网访问。' +
        '先确认浏览器能打开 ' + root + ' 再回来试。'
      continue
    }
    if (res.status === 404) continue

    const html = res.text || ''
    out.reachable = true
    out.prefix = prefix
    out.loginUrl = res.url || url
    out.cas = /统一身份认证|cas|sso/i.test(html) && !/name=["']?password/i.test(html)

    // 登录表单字段名（不同版本叫法不同）
    const userField =
      pick(/name=["']?(username|userName|loginName|account|userid)["']?/i, html) || 'username'
    const passField =
      pick(/type=["']?password["']?[^>]*name=["']?([a-zA-Z_]+)["']?/i, html) ||
      pick(/name=["']?(password|passwd|pwd)["']?/i, html) ||
      'password'
    out.fields = { username: userField, password: passField }

    // 验证码：页面里有 captcha 字样的 img / input
    const capImg = html.match(/<img[^>]+src=["']([^"']*(?:captcha|randomCode|validateCode|verifyCode)[^"']*)["']/i)
    const capInput = html.match(/name=["']?(captcha|randomCode|validateCode|verifyCode|checkCode)["']?/i)
    if (capImg || capInput) {
      out.needCaptcha = true
      out.captchaUrl = capImg ? capImg[1] : prefix + '/security/captcha'
      out.fields.captcha = capInput ? capInput[1] : 'captcha'
    }

    // 密码是否要在前端先做 MD5（页面里出现 MD5 加密脚本就按加密走）
    out.fields.md5 = /CryptoJS|hex_md5|md5\(/i.test(html)

    // 登录表单原文（截断），字段识别不准时用来核对
    const fm = html.match(/<form[\s\S]{0,1600}?<\/form>/i)
    out.formSnippet = fm ? fm[0].replace(/\s+/g, ' ').slice(0, 700) : ''
    return out
  }

  if (!out.error) {
    out.error = '登录页 404'
    out.hint = '这个地址下面找不到 EAMS 登录页，确认一下网址对不对。'
  }
  return out
}

/** 把验证码图片拉下来转成 data URL，前端直接 <img src> 显示 */
async function captchaImage(jar, probeResult) {
  const url = absolutize(probeResult.loginUrl, probeResult.captchaUrl)
  const buf = await HTTP.requestBinary(url, { jar, timeout: 12000 })
  const b64 = Buffer.isBuffer(buf) ? buf.toString('base64') : Buffer.from(String(buf)).toString('base64')
  const isPng = b64.slice(0, 4) === 'iVBOR'
  return 'data:image/' + (isPng ? 'png' : 'gif') + ';base64,' + b64
}

function absolutize(pageUrl, maybe) {
  if (/^https?:\/\//i.test(maybe)) return maybe
  try {
    return new URL(maybe, pageUrl).toString()
  } catch (e) {
    return maybe
  }
}

/* ------------------------------------------------------------------ */
/* 登录                                                               */
/* ------------------------------------------------------------------ */

function md5(s) {
  return crypto.createHash('md5').update(String(s), 'utf8').digest('hex')
}

/**
 * 用 EAMS 本地账号登录。
 * @param {Object} o {base, username, password, captcha, jar, p}
 * @returns {{ok, jar, message, needCaptcha, homeUrl}}
 */
async function login(o) {
  o = o || {}
  const p = o.p || (await probe(o.base, o.jar))
  if (!p.reachable) throw new Error(p.hint || p.error || '教务系统不可达')
  if (p.cas) {
    throw new Error(
      '这个入口只支持统一身份认证登录，程序没法代填短信验证码。' +
        '请改用下面的「粘贴 Cookie」方式。'
    )
  }

  const jar = o.jar || new HTTP.CookieJar()
  // 先 GET 一次登录页，确保会话 cookie 在手上（验证码也认这个会话）
  await HTTP.request(p.loginUrl, { jar, timeout: 15000, maxRedirect: 4 })

  const build = (pwd) => {
    const f = p.fields || {}
    const body = {}
    body[f.username || 'username'] = String(o.username || '').trim()
    body[f.password || 'password'] = pwd
    if (p.needCaptcha && o.captcha) body[f.captcha || 'captcha'] = String(o.captcha).trim()
    return HTTP.formBody(body)
  }

  // 先明文，失败再试 MD5（有的学校前端会先加密再提交）
  const candidates = [String(o.password || '')]
  if (p.fields && p.fields.md5) candidates.unshift(md5(o.password || ''))
  else candidates.push(md5(o.password || ''))

  let lastMsg = ''
  for (let i = 0; i < candidates.length; i++) {
    const res = await HTTP.request(p.loginUrl, {
      method: 'POST',
      jar,
      body: build(candidates[i]),
      timeout: 15000,
      maxRedirect: 6
    })
    const finalUrl = res.url || ''
    const html = res.text || ''
    const landed = !/login\.action|login_page/i.test(finalUrl) && HOME_RE.test(finalUrl)
    const hasError = /用户名或密码|密码错误|验证码|登录失败|用户不存在/i.test(stripTags(html))

    if (landed || (!hasError && /logout|navBar|用户登录成功|home/i.test(html) && !/password/i.test(html))) {
      // 再验一次：访问首页，看是不是真进来了
      const home = await HTTP.request(
        p.base + p.prefix + '/home.action',
        { jar, timeout: 15000, maxRedirect: 4 }
      ).catch(() => null)
      const okHome = home && !/login\.action/i.test(home.url || '') && (home.text || '').length > 200
      if (okHome || landed) {
        return { ok: true, jar, message: '登录成功', needCaptcha: false, homeUrl: (home && home.url) || finalUrl }
      }
    }

    lastMsg = errorMessageOf(html) || ''
    if (/验证码/i.test(lastMsg)) {
      return {
        ok: false,
        jar,
        needCaptcha: true,
        message: lastMsg || '验证码不对',
        captchaUrl: p.captchaUrl
      }
    }
  }

  return {
    ok: false,
    jar,
    needCaptcha: p.needCaptcha,
    message: lastMsg || '账号或密码没通过。可以改用「粘贴 Cookie」那条路。',
    captchaUrl: p.captchaUrl
  }
}

/* ------------------------------------------------------------------ */
/* 学期                                                                */
/* ------------------------------------------------------------------ */

/** 从任意页面里捞学期下拉框 */
function parseSemesters(html) {
  const out = []
  const src = String(html || '')
  const re = /<option[^>]*value=["']?(\d{2,8})["']?[^>]*>([^<]{2,60})<\/option>/gi
  let m
  while ((m = re.exec(src))) {
    const name = decodeEntities(m[2]).replace(/\s+/g, ' ').trim()
    if (!name) continue
    if (!/学[年期]|学期|秋季|春季|夏季|20\d\d/i.test(name)) continue
    if (out.some((x) => x.id === m[1])) continue
    out.push({ id: m[1], name })
  }
  // 当前选中项
  const cur = src.match(/<option[^>]*value=["']?(\d{2,8})["']?[^>]*selected[^>]*>([^<]{2,60})<\/option>/i)
  const current = cur ? { id: cur[1], name: decodeEntities(cur[2]).trim() } : null
  return { semesters: out, current }
}

/* ------------------------------------------------------------------ */
/* 课表：抓取                                                          */
/* ------------------------------------------------------------------ */

/**
 * 挨个试常见的课表地址，谁先给出可解析的内容就用谁。
 * 不硬编码单一接口 —— EAMS 各校版本差得很远，探测比猜稳。
 */
async function fetchTable(jar, p, opt) {
  const o = opt || {}
  const prefix = p.prefix || '/eams'
  const base = p.base
  const tries = []
  let studentId = o.studentId || ''

  // 先拿一次课表页，从里面挖 semester.id / 对应的下拉框
  const entryUrls = [
    base + prefix + '/courseTableForStd.action',
    base + prefix + '/stdSchedule/table',
    base + prefix + '/courseTableForStd!courseTable.action'
  ]

  let entry = null
  for (let i = 0; i < entryUrls.length; i++) {
    const r = await HTTP.request(entryUrls[i], { jar, timeout: 20000, maxRedirect: 5 }).catch(() => null)
    if (r && r.status === 200 && (r.text || '').length > 300 && !/login\.action/i.test(r.url || '')) {
      entry = r
      break
    }
    tries.push('入口 ' + entryUrls[i] + ' → ' + (r ? r.status : '失败'))
  }

  const semInfo = parseSemesters(entry ? entry.text : '')
  const semesterId = o.semesterId || (semInfo.current && semInfo.current.id) || ''
  if (!studentId) studentId = findStudentId(entry ? entry.text : '') || ''
  const semesterName =
    (semInfo.semesters.find((x) => x.id === semesterId) || {}).name || o.semesterName || ''

  // ① ws/schedule/table —— 新版 EAMS 的 JSON 课表
  if (studentId) {
    const url = base + prefix + '/ws/schedule/table'
    const body = HTTP.formBody({
      datasource: studentId,
      calendar: semesterId,
      'setting.kind': 'std',
      ids: ''
    })
    const r = await HTTP.request(url, {
      method: 'POST', jar, body, timeout: 25000, maxRedirect: 5,
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' }
    }).catch(() => null)
    if (r && r.status === 200) {
      const items = parseWsJson(safeJson(r.text))
      if (items.length) {
        return { ok: true, via: 'ws/schedule/table', items, semesterId, semesterName, semesters: semInfo.semesters, termStart: findTermStart(entry ? entry.text : ''), tries }
      }
      tries.push('ws/schedule/table → 0 条')
    } else {
      tries.push('ws/schedule/table → ' + (r ? r.status : '失败'))
    }
  }

  // ② 表格页（GET 带周次 / 学期参数）
  const qs = []
  if (semesterId) qs.push('semester.id=' + encodeURIComponent(semesterId))
  if (studentId) qs.push('ids=' + encodeURIComponent(studentId))
  qs.push('setting.kind=std', 'startWeek=1', 'ignoreHead=1')
  const tableUrl = base + prefix + '/courseTableForStd!courseTable.action?' + qs.join('&')

  const r2 = await HTTP.request(tableUrl, {
    jar, timeout: 25000, maxRedirect: 5,
    headers: { referer: base + prefix + '/courseTableForStd.action' }
  }).catch(() => null)

  if (r2 && r2.status === 200) {
    const items = parseTableHtml(r2.text)
    if (items.length) {
      return {
        ok: true, via: 'courseTableForStd!courseTable.action', items,
        semesterId, semesterName, semesters: semInfo.semesters, termStart: findTermStart(entry ? entry.text : ''), tries
      }
    }
    // 有些版本课表就长在入口页里
    if (entry) {
      const items2 = parseTableHtml(entry.text)
      if (items2.length) {
        return {
          ok: true, via: 'courseTableForStd.action（入口页内嵌）', items: items2,
          semesterId, semesterName, semesters: semInfo.semesters, termStart: findTermStart(entry ? entry.text : ''), tries
        }
      }
    }
    tries.push('表格页 → 认得 0 条（结构不认识）')
  } else {
    tries.push('表格页 → ' + (r2 ? r2.status : '失败'))
  }

  return {
    ok: false,
    items: [],
    semesterId,
    semesterName,
    semesters: semInfo.semesters,
    tries,
    entryHtml: entry ? entry.text : '',
    message: '登录是通的，但课表页的结构没认出来。可以把「原始片段」发我，我按真实结构调解析。'
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch (e) {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* 课表：解析                                                          */
/* ------------------------------------------------------------------ */

/** `第1,2节{第1-16周}` → `1-2节 ... 1-16周` 交给共享的 parseLine 处理 */
function normalizeFestival(s) {
  return String(s || '')
    .replace(/第?\s*(\d{1,2})\s*[,，、]\s*(\d{1,2})\s*节/g, '第$1-$2节')
    .replace(/[{}｛｝]/g, ' ')
    .replace(/[（(]\s*([单双])\s*[)）]/g, '($1)')
    .replace(/\s+/g, ' ')
    .trim()
}

const FESTIVAL_RE =
  /(?:周|星期|礼拜)\s*[一二三四五六日天1-7]\s*第?\s*\d{1,2}(?:\s*[-~—－–至到,，、]\s*\d{1,2})?\s*节\s*\{?\s*第?\s*\d{1,2}(?:\s*[-~—－–至到,，、]\s*\d{1,2})?\s*周\s*[}｝]?\s*(?:[（(]\s*[单双]\s*[)）])?/

/**
 * EAMS 课表 HTML → 课表条目
 *
 * 每个格子（td）里可能有 1~N 门课，每门课长这样：
 *   <div class="timetable_con">
 *     <span class="title" title="高等数学">高等数学</span>
 *     <p class="festival">周一第1,2节{第1-16周}</p>
 *     <p>张三 / 二教101</p>
 *   </div>
 * 把每门课拍平成 「周一 1-2节 高等数学 二教101 1-16周」再走 parseLine。
 */
function parseTableHtml(html) {
  const src = String(html || '')
  if (!src) return []

  const lines = []
  const cells = src.split(/<td\b/i).slice(1)

  cells.forEach((raw) => {
    const cell = raw.split(/<\/td>/i)[0]
    if (!/timetable_con|第?\s*\d+\s*[,，]\s*\d+\s*节|节\s*\{|周\s*[一二三四五六日]/i.test(cell)) return

    // 每门课的标题
    const titles = []
    const tre = /<span[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi
    let tm
    while ((tm = tre.exec(cell))) {
      const t = stripTags(tm[1]).split('\n')[0].trim()
      if (t) titles.push(t)
    }
    if (!titles.length) {
      const at = cell.match(/\btitle=["']([^"']{2,40})["']/i)
      if (at) titles.push(stripTags(at[1]).trim())
    }

    // 每个时间串
    const plain = stripTags(cell).replace(/\n+/g, '\n')
    const fests = []
    const fre = new RegExp(FESTIVAL_RE.source, 'gi')
    let fm
    while ((fm = fre.exec(plain))) {
      fests.push({ text: normalizeFestival(fm[0]), index: fm.index })
    }
    if (!fests.length) return

    // 地点 / 教师：取时间串后面的行，挑不像人名的
    fests.forEach((f, i) => {
      const title = titles[i] || titles[0] || ''
      const tailStart = f.index + f.text.length
      const tailEnd = i + 1 < fests.length ? fests[i + 1].index : Math.min(plain.length, tailStart + 120)
      const tail = plain.slice(tailStart, tailEnd)

      let place = ''
      let teacher = ''
      const pm = tail.match(/(?:地点|教室|上课地点)\s*[:：]\s*([^\n]{1,30})/)
      const tmm = tail.match(/(?:教师|老师|任课教师)\s*[:：]\s*([^\n]{1,20})/)
      if (pm) place = pm[1].trim()
      if (tmm) teacher = tmm[1].trim()

      if (!place) {
        // 没写「地点：」就按行猜：像房间号的那一段
        const segs = tail.split('\n').map((x) => x.trim()).filter(Boolean)
        const roomRe = /(楼|教|馆|室|区|栋|厅|场|中心|实验|A\d|B\d|C\d|\d{2,4})/
        const cand = segs.filter((x) => roomRe.test(x) && !/^[\u4e00-\u9fa5]{2,4}$/.test(x))
        if (cand.length) place = cand[cand.length - 1].slice(0, 30)
      }
      // 场地里常混着教师，拆一下
      if (!teacher && place && /[\/、,，]/.test(place)) {
        const parts = place.split(/[\/、,，]/).map((x) => x.trim()).filter(Boolean)
        if (parts.length >= 2) {
          teacher = parts[0]
          place = parts.slice(1).join(' ')
        }
      }
      if (place) place = place.replace(/[\/、,，]\s*$/, '').trim()
      if (teacher) place = (place + ' ' + teacher).trim()

      lines.push(f.text + ' ' + title + ' ' + place)
    })
  })

  if (!lines.length) return []
  return linesToItems(lines)
}

/** 一组「周一 1-2节 课程 地点 1-16周」行 → 合并后的条目 */
function linesToItems(lines) {
  const items = []
  const byKey = {}

  lines.forEach((line) => {
    const one = S.parseLine(line)
    if (!one || !one.name) return
    const key = [one.day, one.start, one.end, one.name, one.place].join('|')
    if (byKey[key]) return
    byKey[key] = 1
    items.push({
      id: key,
      day: one.day,
      start: one.start,
      end: one.end,
      name: one.name,
      place: one.place || '',
      weeks: one.weeks
    })
  })

  items.sort((a, b) => a.day - b.day || (a.start || 99) - (b.start || 99))
  return items
}

/**
 * 新版 ws/schedule/table 的 JSON → 条目
 * 结构大致：
 *  { std: { activities: [{lessonId, courseName, room, teacher, startUnit, endUnit, weekIndex}] },
 *    arragements: [{id, ...}], calendar: {start, weeks} }
 * 各校字段名有出入，做宽松匹配。
 */
function parseWsJson(json) {
  if (!json || typeof json !== 'object') return []
  const std = json.std || json
  const acts = std.activities || std.actives || []
  if (!Array.isArray(acts) || !acts.length) return []

  const arr = json.arragements || []
  const roomName = {}
  const teacherName = {}
  arr.forEach((a) => {
    if (!a) return
    if (a.id !== undefined && a.name) roomName[a.id] = a.name
    if (a.roomId !== undefined && a.roomName) roomName[a.roomId] = a.roomName
    if (a.id !== undefined && a.teacherName) teacherName[a.id] = a.teacherName
  })

  const lines = []
  acts.forEach((a) => {
    if (!a) return
    const name = a.courseName || a.course || a.lessonName || ''
    if (!name) return
    const day = Number(a.weekIndex !== undefined ? a.weekIndex : a.weekDay !== undefined ? a.weekDay : 0)
    const s = Number(a.startUnit || a.start || 0)
    const e = Number(a.endUnit || a.end || s)
    if (!day || !s) return

    let place = ''
    ;['room', 'roomId', 'roomName', 'place', 'location'].forEach((k) => {
      if (place || a[k] === undefined || a[k] === null || a[k] === '') return
      const v = a[k]
      place = (typeof v === 'object' ? v.name || '' : String(v)).trim()
      if (roomName[place]) place = roomName[place]
    })

    // 周次：webs 版本有 weeks 字符串，也有 weekBit 位图
    let weekText = ''
    if (typeof a.weeks === 'string' && a.weeks) weekText = a.weeks
    else if (typeof a.weekUnit === 'string' && a.weekUnit) weekText = a.weekUnit
    else if (typeof a.weekBit === 'string' && /^[01]+$/.test(a.weekBit)) {
      const w = []
      for (let i = 0; i < a.weekBit.length; i++) if (a.weekBit[i] === '1') w.push(i + 1)
      if (w.length) weekText = w.length === 1 ? w[0] + '周' : w[0] + '-' + w[w.length - 1] + '周'
    }

    lines.push(
      '周' + S.DAY_NAMES[day - 1] + ' ' + s + '-' + e + '节 ' + name + ' ' + place + ' ' + weekText
    )
  })

  return linesToItems(lines)
}

/** 兜底：用户直接粘的整页文字 */
function parseText(text) {
  const r = S.parseText(text)
  return (r.items || []).map((x) => ({
    id: x.id,
    day: x.day,
    start: x.start,
    end: x.end,
    name: x.name,
    place: x.place || '',
    weeks: x.weeks
  }))
}

/** 从课表页里找 studentId（有些接口必须要） */
function findStudentId(html) {
  const s = String(html || '')
  return (
    pick(/[?&]ids=(\d{3,12})/i, s) ||
    pick(/name=["']?student\.id["']?[^>]*value=["']?(\d{3,12})/i, s) ||
    pick(/studentId\s*[:=]\s*["']?(\d{3,12})/i, s) ||
    ''
  )
}

/** 从课表页里找这个学期的开学日（有就用，没有就让用户填） */
function findTermStart(html) {
  const s = String(html || '')
  const m =
    s.match(/(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})[^<]{0,20}开学/) ||
    s.match(/开学[日时]期?[^0-9]{0,10}(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})/) ||
    s.match(/semesterStart\s*[:=]\s*["']?(\d{4})-(\d{1,2})-(\d{1,2})/i)
  if (!m) return ''
  const mm = String(m[2]).padStart(2, '0')
  const dd = String(m[3]).padStart(2, '0')
  return m[1] + '-' + mm + '-' + dd
}

/* ------------------------------------------------------------------ */

module.exports = {
  DEFAULT_BASE,
  probe,
  login,
  captchaImage,
  fetchTable,
  parseTableHtml,
  parseWsJson,
  parseText,
  parseSemesters,
  findStudentId,
  findTermStart,
  normalizeFestival,
  md5,
  _internal: { stripTags, decodeEntities, linesToItems, errorMessageOf, absolutize }
}
