/**
 * 爱课程（icourse163.org，即网易的「中国大学MOOC」）适配器
 *
 * 两种登录方式（来自开源项目 SigureMo/mooc-dl 的逆向核对）：
 *   ① 账号密码：POST /mob/logonByIcourse，
 *      密码取 MD5 hex，返回 {status:{code:0}, results:{mob-token}}，
 *      code 100 = 密码错误（文案字段是 status.message）；
 *   ② Cookie：电脑浏览器登录后复制整串 Cookie（要含 STUDY_INFO / STUDY_SESS）。
 *
 * 登录建立会话后，课程/测验走 RPC：POST /web/j/<Bean>.rpc，
 * 带 cookie 会话 + csrfKey（取自 cookie）。不同课程入口有差异，多候选探测。
 */
const crypto = require('crypto')
const { CookieJar, request, parseDate } = require('../lib/http')

const KEY = 'icourse163'
const NAME = '爱课程'
const ORIGIN = 'https://www.icourse163.org'

function pick(obj, keys, dft) {
  for (let i = 0; i < keys.length; i++) {
    const v = obj[keys[i]]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return dft
}

/** RPC 返回常是 {result:{...}} 或 {content:{...}}，多层壳逐层剥 */
function dig(json, keys) {
  let cur = json
  for (const k of keys) {
    if (!cur || typeof cur !== 'object') return null
    cur = cur[k]
  }
  return cur === undefined ? null : cur
}

function normList(json, keys) {
  const v = dig(json, keys)
  if (Array.isArray(v)) return v
  // 有时是 {123:{...}} 的 map 形态
  if (v && typeof v === 'object') return Object.values(v).filter((x) => x && typeof x === 'object')
  return []
}

async function tryRpc(jar, bean, params, csrfKey) {
  const body = new URLSearchParams()
  Object.keys(params || {}).forEach((k) => body.append(k, params[k]))
  if (csrfKey) body.append('csrfKey', csrfKey)
  try {
    const r = await request(ORIGIN + '/web/j/' + bean, {
      method: 'POST',
      jar,
      body: body.toString(),
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        accept: 'application/json',
        referer: ORIGIN + '/learn',
        'x-requested-with': 'XMLHttpRequest'
      }
    })
    if (r.status === 401 || r.status === 403) return { skip: 'HTTP ' + r.status }
    const j = JSON.parse(r.text)
    return { json: j, text: r.text }
  } catch (e) {
    return { skip: String((e && e.message) || e).slice(0, 60) }
  }
}

/** csrfKey 通常就是 cookie 里的某个字段；从 cookie 串里猜 */
function guessCsrf(jar) {
  const o = jar.toObject()
  return pick(o, ['csrfKey', 'CSRF_KEY', 'JSESSIONID'], '')
}

/** /mob/ 系列是「中国大学MOOC App」的接口，必须带 App 身份头，否则网关回 HTML 页 */
const MOB_HEADERS = {
  'user-agent': 'Dalvik/2.1.0 (Linux; U; Android 10; PCT-AL10 Build/HUAWEIPCT-AL10)',
  'edu-app-channel': 'ucmooc_offical',
  'edu-app-type': 'android',
  'edu-app-version': '4.19.0',
  accept: 'application/json'
}

/**
 * 账号密码登录（爱课程账号）：POST /mob/logonByIcourse，
 * 密码取 MD5 hex；成功后 jar 里就种下了 web 会话 cookie，
 * 后面的课程/测验 RPC 照常走。
 * 返回 jar 或抛错（带服务端原文）。
 */
async function loginByPassword(account) {
  const jar = new CookieJar()
  const md5pw = crypto
    .createHash('md5')
    .update(String(account.password || ''), 'utf8')
    .digest('hex')
  const user = String(account.username || '')
  // 字段名两种写法都带上（老接口 username/passwd，新文档 userName/passWord），
  // 服务端只认自己要的那对，多出来的会被忽略 —— 免得字段改名后被当成空密码
  const body = new URLSearchParams()
  body.append('username', user)
  body.append('userName', user)
  body.append('passwd', md5pw)
  body.append('passWord', md5pw)
  body.append('mob-token', '')
  let r
  try {
    r = await request(ORIGIN + '/mob/logonByIcourse', {
      method: 'POST',
      jar,
      body: body.toString(),
      headers: Object.assign({}, MOB_HEADERS, {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8'
      })
    })
  } catch (e) {
    throw new Error('连不上爱课程（icourse163.org）：' + String((e && e.message) || e))
  }
  let j = null
  try {
    j = JSON.parse(r.text)
  } catch (e) {
    // 200 却不是 JSON：十有八九是网关顶回来的网页（缺 App 头 / 触发风控 / 接口改版）。
    // 把原文片段带回去，一眼分清是哪种。
    const ct = String((r.headers && r.headers.get('content-type')) || '')
    const isHtml = /^\s*<(?:!doctype|html)/i.test(r.text) || /<\/html>/i.test(r.text)
    const snippet = String(r.text || '')
      .replace(/\s+/g, ' ')
      .slice(0, 120)
    throw new Error(
      '登录接口返回的不是 JSON（HTTP ' + r.status + (ct ? '，' + ct : '') + '）：' +
        (isHtml ? '被网页版拦截' : snippet)
    )
  }
  const code = j && j.status ? Number(j.status.code) : NaN
  // 实测（2026-10）服务端的文案字段是 status.message；兼容历史 msg 写法
  const msg = String(
    (j && j.status && (j.status.message || j.status.msg)) || (j && (j.msg || j.message)) || ''
  )
  if (code !== 0) {
    if (code === 100) {
      throw new Error(
        '爱课程拒绝了这对账号密码' + (msg ? '（服务端原话：' + msg + '）' : '') +
          '。请求格式已验证没问题，就是这对用户名/密码在服务器上对不上。' +
          '最常见原因：你平时在MOOC App里用「手机验证码」或微信登录 —— 这种账号没有设过密码。' +
          '办法：电脑浏览器打开 icourse163.org 用你平时的方式登录 → 头像 → 账号设置 → 看绑定的手机号/邮箱并设置密码，' +
          '回来填那个手机号/邮箱+新密码。急用可先切「Cookie 模式」：网页登录后复制整串 Cookie 粘进来'
      )
    }
    throw new Error('爱课程登录失败（code ' + code + (msg ? '：' + msg : '') + '）')
  }
  return jar
}

/** 建立会话：密码模式先走 logonByIcourse，Cookie 模式直接用粘来的 cookie */
async function buildSession(account) {
  if (account.mode === 'password') {
    if (!account.username || !account.password) {
      throw new Error('请填写爱课程账号和密码')
    }
    return loginByPassword(account)
  }
  const jar = new CookieJar(account.cookie)
  if (!jar.size()) {
    throw new Error(
      'Cookie 为空：电脑浏览器登录 icourse163.org 后复制整串 Cookie（要含 STUDY_INFO / STUDY_SESS），' +
        '或改用账号密码登录'
    )
  }
  return jar
}

async function sync(account) {
  const debug = []
  const jar = await buildSession(account)
  const csrfKey = guessCsrf(jar)

  // ① 登录态 + 我的课程：多候选探测（接口形态没公开文档，按真实返回校准过一部分）
  const courseCandidates = [
    { label: 'mocCourseBean.getMyCourseList', bean: 'mocCourseBean.rpc', params: { method: 'getMyCourseList', pageNo: 1, pageSize: 50 } },
    { label: 'mocCourseBean.getPagedMyCourseList', bean: 'mocCourseBean.rpc', params: { method: 'getPagedMyCourseList', pageNo: 1, pageSize: 50 } },
    { label: 'courseBean.getMyCourseList', bean: 'courseBean.rpc', params: { method: 'getMyCourseList', pageNo: 1, pageSize: 50 } }
  ]
  let courses = []
  const tried = []
  for (const c of courseCandidates) {
    const r = await tryRpc(jar, c.bean, c.params, csrfKey)
    const list = normList(r.json, ['result', 'courses'])
      .concat(normList(r.json, ['result', 'myCourses']))
      .concat(normList(r.json, ['result', 'data']))
      .concat(normList(r.json, ['result', 'list']))
    tried.push(
      c.label + ' → ' + (r.json ? JSON.stringify(r.json).slice(0, 100) : r.skip || '非 JSON')
    )
    if (list.length) {
      courses = list
      debug.push('课程数 ' + list.length + '（' + c.label + '）')
      break
    }
  }
  if (!courses.length) {
    throw new Error(
      '课程接口未命中（' + tried.length + ' 个入口都试过）：\n' +
        tried.join('\n') +
        '\n若内容是「请登录」类：Cookie/登录会话没被网页接口认可。把上面整段发我校准'
    )
  }

  // ② 逐课取测验/作业（RPC 方法名按课程形态探测）
  const tasks = []
  const seen = new Set()
  for (const course of courses.slice(0, 15)) {
    const cid = pick(course, ['id', 'courseId', 'termId'], '')
    if (!cid) continue
    const cname = String(pick(course, ['name', 'nameZh', 'courseName'], '未命名课程'))
    const candidates = [
      { bean: 'mocQuizBean.rpc', params: { method: 'getQuizList', courseId: cid } },
      { bean: 'mocHomeworkBean.rpc', params: { method: 'getHomeworkList', courseId: cid } },
      { bean: 'mocExamBean.rpc', params: { method: 'getExamList', courseId: cid } }
    ]
    for (const c of candidates) {
      const r = await tryRpc(jar, c.bean, Object.assign({}, c.params, { csrfKey }), csrfKey)
      const list = normList(r.json, ['result']).concat(normList(r.json, ['result', 'list']))
      list.forEach((raw) => {
        if (!raw || typeof raw !== 'object') return
        const title = String(pick(raw, ['title', 'name', 'quizName', 'homeworkName', 'examName'], '')).trim()
        if (!title) return
        const eid = pick(raw, ['id', 'quizId', 'homeworkId', 'examId'], title)
        const key = `${KEY}:${cid}:${eid}`
        if (seen.has(key)) return
        seen.add(key)
        tasks.push({
          externalId: key,
          courseId: String(cid),
          courseName: cname,
          title,
          taskType: /quiz/i.test(c.bean) ? 'quiz' : /exam/i.test(c.bean) ? 'exam' : 'homework',
          deadline: parseDate(pick(raw, ['deadline', 'endTime', 'end_time', 'submitEndTime'], '')),
          status: /submit|finish|complet/i.test(JSON.stringify(pick(raw, ['status', 'state'], ''))) ? 'done' : 'todo'
        })
      })
    }
  }

  if (!tasks.length) {
    throw new Error(
      '读到 ' + courses.length + ' 门课但没解析出测验/作业。轨迹：' + debug.join('；') +
        '。把这段发我，按真实返回补接口'
    )
  }
  return { tasks, debug }
}

module.exports = { key: KEY, name: NAME, sync }
