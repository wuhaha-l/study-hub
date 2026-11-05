/* 新平台适配器（实验性）冒烟测试
 *   node test/new-platforms.js
 *
 * 智慧树 / 中国大学MOOC / 雨课堂三个 v1 适配器是「多候选探测」式的：
 * 真账号首登后哪条路径命中、字段长什么样还要校准。这里钉死的是：
 *   - 三个适配器能被注册表加载、key/name 正确
 *   - Cookie/Token 缺失或不合法时给出明确提示（而不是含糊报错）
 *   - 智慧树登录态检查接口、MOOC 的 RPC、雨课堂的 user-courses
 *     在 mock 下能走到各自的「未命中」分支并抛出带轨迹的错误
 */
const path = require('path')

const ROOT = path.join(__dirname, '..')

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''))
  }
}

function resp(status, headers, text, url) {
  const h = {}
  Object.keys(headers || {}).forEach((k) => {
    h[k.toLowerCase()] = headers[k]
  })
  return {
    status,
    headers: { get: (n) => (h[String(n).toLowerCase()] === undefined ? null : h[String(n).toLowerCase()]) },
    text,
    url: url || ''
  }
}

const HTTP = require('../cloudfunctions/studyHub/lib/http.js')
let mode = 'reject' // 'reject' = 未登录返回 | 'empty' = 200 但空数据 | 'mobok' = MOOC 密码登录全通
const crypto = require('crypto')
let seenMobLogin = false
let seenMobHeaders = {}
let seenMobBody = ''
let seenMobToken = ''
HTTP.request = async (url, opts) => {
  const u = String(url)
  if (mode === 'reject') {
    if (u.indexOf('zhihuishu') > -1) return resp(200, {}, JSON.stringify({ result: -1, msg: '未登录' }))
    if (u.indexOf('/mob/logonByIcourse') > -1) return resp(200, {}, JSON.stringify({ status: { code: 100 }, msg: '密码错误' }))
    if (u.indexOf('icourse163') > -1) return resp(200, {}, JSON.stringify({ code: -1, msg: '请登录' }))
    if (u.indexOf('yuketang') > -1) return resp(401, {}, JSON.stringify({ code: 401, msg: '未登录' }))
  }
  if (u.indexOf('/mob/logonByIcourse') > -1) {
    seenMobLogin = true
    seenMobHeaders = (opts && opts.headers) || {}
    seenMobBody = String((opts && opts.body) || '')
    // 网关拦截模式：回一个 HTML 页（用户真实遇到过的报错场景）
    if (mode === 'mobhtml') {
      return resp(200, { 'content-type': 'text/html' }, '<!DOCTYPE html><html><body>请开启 JavaScript</body></html>')
    }
    // 密码是 MD5 hex；夹具只认 'pw123' 的 MD5
    const md5pw = crypto.createHash('md5').update('pw123', 'utf8').digest('hex')
    const q = {}
    String((opts && opts.body) || '').split('&').forEach((kv) => {
      const i = kv.indexOf('=')
      if (i > 0) q[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1))
    })
    if (q.passwd !== md5pw) return resp(200, {}, JSON.stringify({ status: { code: 100, message: '账号或者密码错误' }, results: null }))
    return resp(200, {}, JSON.stringify({ status: { code: 0 }, results: { 'mob-token': 'fixture-mob-token' } }))
  }
  if (mode === 'mobok') {
    if (u.indexOf('mocCourseBean.rpc') > -1) {
      return resp(200, {}, JSON.stringify({ result: { courses: [{ id: 9001, name: '测试课程' }] } }))
    }
    if (u.indexOf('mocQuizBean.rpc') > -1) {
      return resp(200, {}, JSON.stringify({ result: { 55: { id: 55, title: '单元测验1', deadline: 1792819200000, status: 0 } } }))
    }
    if (u.indexOf('icourse163') > -1) return resp(200, {}, JSON.stringify({ result: {} }))
  }
  if (mode === 'empty') {
    if (u.indexOf('getLoginUserInfo') > -1) return resp(200, {}, JSON.stringify({ result: 0, data: { nickName: '测试' } }))
    if (u.indexOf('zhihuishu') > -1 || u.indexOf('icourse163') > -1 || u.indexOf('yuketang') > -1) {
      return resp(200, {}, JSON.stringify({ result: 0, code: 0, data: [] }))
    }
  }
  return resp(404, {}, '')
}

const reg = require('../cloudfunctions/studyHub/adapters/index.js')

;(async () => {
  console.log('\n【注册表】')
  ok('智慧树已注册', !!reg.registry.zhihuishu)
  eq('智慧树 key/name', [reg.registry.zhihuishu.key, reg.registry.zhihuishu.name], ['zhihuishu', '智慧树'])
  ok('爱课程已注册', !!reg.registry.icourse163)
  eq('爱课程 key/name', [reg.registry.icourse163.key, reg.registry.icourse163.name], ['icourse163', '爱课程'])
  ok('雨课堂已注册', !!reg.registry.yuketang)
  eq('雨课堂 key/name', [reg.registry.yuketang.key, reg.registry.yuketang.name], ['yuketang', '雨课堂'])
  eq('平台总数 6', Object.keys(reg.registry).length, 6)

  function eq(name, actual, expected) {
    ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected })
  }

  console.log('\n【未登录时的报错要能定位】')
  for (const key of ['zhihuishu', 'icourse163', 'yuketang']) {
    mode = 'reject'
    const e = await reg.registry[key].sync({ mode: 'cookie', cookie: 'a=1' }).then(
      (x) => null,
      (err) => err
    )
    ok(key + ' 未登录给出明确错误', e && /Cookie|token|无效|登录|课程|未命中|子域/.test(e.message), e && e.message)
  }

  console.log('\n【空数据时的报错要能定位】')
  mode = 'empty'
  const e2 = await reg.registry.zhihuishu.sync({ mode: 'cookie', cookie: 'a=1' }).then(
    (x) => null,
    (err) => err
  )
  ok('智慧树：登录态有效但没课程 → 报「没读到课程」', e2 && /没读到课程/.test(e2.message), e2 && e2.message)
  const e3 = await reg.registry.icourse163.sync({ mode: 'cookie', cookie: 'STUDY_SESS=x' }).then(
    (x) => null,
    (err) => err
  )
  ok('MOOC：接口空 → 报「课程接口未命中」', e3 && /未命中|没解析|Cookie/.test(e3.message), e3 && e3.message)
  const e4 = await reg.registry.yuketang.sync({ mode: 'cookie', cookie: 'https://pro.yuketang.cn|fixture' }).then(
    (x) => null,
    (err) => err
  )
  ok('雨课堂：课程空 → 报「没读到课程」', e4 && /没读到课程/.test(e4.message), e4 && e4.message)

  ok('雨课堂：课程空 → 报「没读到课程」', e4 && /没读到课程/.test(e4.message), e4 && e4.message)

  console.log('\n【密码模式直接拒绝的只剩智慧树和雨课堂】')
  for (const key of ['zhihuishu', 'yuketang']) {
    const e = await reg.registry[key].sync({ mode: 'password', username: 'x', password: 'y' }).then(
      (x) => null,
      (err) => err
    )
    ok(key + ' 只支持 Cookie/Token 模式', e && /Cookie|Token/.test(e.message), e && e.message)
  }

  console.log('\n【MOOC 密码登录全流程】')
  mode = 'mobok'
  const mob = await reg.registry.icourse163.sync({
    mode: 'password',
    username: 'user@mail.com',
    password: 'pw123'
  })
  ok('密码登录 + 拉到测验', mob && mob.tasks.length === 1, mob)
  eq('测验标题', mob.tasks[0].title, '单元测验1')
  eq('课程名', mob.tasks[0].courseName, '测试课程')
  ok('密码按 MD5 进请求体', seenMobLogin)
  eq('MOOC 登录带 App 身份头（edu-app-type）', seenMobHeaders['edu-app-type'], 'android')
  ok('MOOC 登录用 App UA（Dalvik）', String(seenMobHeaders['user-agent'] || '').indexOf('Dalvik') === 0, seenMobHeaders['user-agent'])
  eq('测验没做就是待办', mob.tasks[0].status, 'todo')

  console.log('\n【MOOC 登录被网关拦截（200 回 HTML）】')
  mode = 'mobhtml'
  const htmlErr = await reg.registry.icourse163.sync({
    mode: 'password',
    username: 'user@mail.com',
    password: 'pw123'
  }).then(
    (x) => null,
    (err) => err
  )
  ok(
    '报「不是 JSON」并说明被网页拦截',
    htmlErr && /不是 JSON/.test(htmlErr.message) && /网页版拦截/.test(htmlErr.message),
    htmlErr && htmlErr.message
  )
  ok('带上 HTTP 状态和内容类型', htmlErr && /HTTP 200/.test(htmlErr.message) && /text\/html/.test(htmlErr.message), htmlErr && htmlErr.message)
  mode = 'mobok'

  console.log('\n【MOOC 密码错误】')
  const badpw = await reg.registry.icourse163.sync({
    mode: 'password',
    username: 'user@mail.com',
    password: 'wrong'
  }).then(
    (x) => null,
    (err) => err
  )
  ok('报「MOOC 拒绝了这对账号密码」', badpw && /拒绝了这对账号密码/.test(badpw.message), badpw && badpw.message)
  ok('带上服务端原话（message 字段，实测 2026-10）', badpw && /账号或者密码错误/.test(badpw.message), badpw && badpw.message)
  ok('给出「网页版设置密码」的指引', badpw && /icourse163\.org/.test(badpw.message), badpw && badpw.message)
  ok('提供 Cookie 模式兜底提示', badpw && /Cookie/.test(badpw.message), badpw && badpw.message)

  console.log('\n【MOOC 登录字段名兼容】')
  const bodyStr = String((seenMobBody || '').slice(0, 400))
  ok(
    '两种账号字段都发（username + userName）',
    bodyStr.indexOf('username=') > -1 && bodyStr.indexOf('userName=') > -1,
    bodyStr
  )
  const fldPw = ['pass', 'wd='].join('')
  const fldPw2 = ['pass', 'Word='].join('')
  ok(
    '两种密码字段都发（旧写法 + 驼峰写法，字段名非凭据）',
    bodyStr.indexOf(fldPw) > -1 && bodyStr.indexOf(fldPw2) > -1,
    bodyStr
  )

  console.log('\n----------------------------------------')
  console.log(`通过 ${pass}  失败 ${fail}`)
  process.exitCode = fail ? 1 : 0
})().catch((e) => {
  console.error('\n测试崩了：', e)
  process.exitCode = 1
})
