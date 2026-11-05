/* 郑大课表 · 云函数版测试（APP /token/ 协议）
 *
 * 2026-10-24 起，登录通道从「网页版 CAS」换到「郑大 APP 的 /token/ API」：
 *   detect（拿 state）→ 需要时 initByType + attest 发短信/验码 →
 *   passwordLogin（账号+密码都 RSA 加密，query string 传参）→ idToken/refreshToken。
 *   门户 API 认 X-Id-Token: idToken（约一个月有效）。MFA 信任绑定 deviceId。
 *
 * 这里用内存版数据库 + 假 HTTP 把链路跑通，专门盯：
 *   ① 密码登录撞 MFA → 发短信 → 存接力态 → 回 needMfaCode
 *   ② 验证码不对 / 过期 / 重发的各种分支
 *   ③ 验证通过 → passwordLogin → 拉回课表
 *   ④ idToken 过期 / 门户拒 token（无效token）→ 清态 + needLogin，可重新登录
 *   ⑤ 库里搜不到任何敏感原文
 *
 * 说明：RSA 加密格式（PKCS#1 v1.5 + __RSA__ 前缀）是学校服务端规定的，
 * 加解密往返由 node 内置库保证，这里不再起测试密钥对，格式正确性由
 * 真账号首登验证。
 */
const path = require('path')
const crypto = require('crypto')

const ROOT = path.join(__dirname, '..')
const CF = path.join(ROOT, 'cloudfunctions', 'studyHub')

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
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected })
}

/* ------------------------------------------------------------------ */
/* 假数据库（内存版，形状照抄云开发 SDK）                               */
/* ------------------------------------------------------------------ */

const docs = new Map()
let seq = 0

const coll = {
  where(q) {
    return {
      limit() {
        return {
          get: async () => ({
            data: Array.from(docs.values()).filter((d) => d.openid === q.openid)
          })
        }
      }
    }
  },
  doc(id) {
    return {
      get: async () => ({ data: docs.get(id) }),
      update: async ({ data }) => {
        const cur = docs.get(id) || {}
        docs.set(id, Object.assign(cur, data))
        return { stats: { updated: 1 } }
      },
      remove: async () => {
        docs.delete(id)
        return { stats: { removed: 1 } }
      }
    }
  },
  add: async ({ data }) => {
    const _id = 'doc' + ++seq
    docs.set(_id, Object.assign({ _id }, data))
    return { _id }
  }
}

const fakeCloud = {
  init() {},
  DYNAMIC_CURRENT_ENV: 'test',
  database() {
    return {
      collection() {
        return coll
      },
      createCollection: async () => ({})
    }
  },
  getWXContext: () => ({ OPENID: 'o_test' })
}

// 让 zzu.js 里的 require('wx-server-sdk') 拿到假的
const sdkPath = require.resolve('wx-server-sdk', { paths: [CF] })
require.cache[sdkPath] = {
  id: sdkPath,
  filename: sdkPath,
  loaded: true,
  exports: fakeCloud,
  children: [],
  paths: []
}

/* ------------------------------------------------------------------ */
/* 假网络（APP /token/ 协议）                                          */
/* ------------------------------------------------------------------ */

const HTTP = require('../cloudfunctions/studyHub/lib/http.js')

// 测试夹具：一对公开的 RSA 测试公钥（公钥本身不是秘密，私钥不在仓库里，
// 只用来让 mock 的 publicKey 接口返回合法 PEM，供 publicEncrypt 走通）
const TEST_PUBLIC_KEY_PEM = [
  '-----BEGIN PUBLIC KEY-----',
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxrpz2FqWugkpIU3VJmAt',
  'jzsL4Bc2YvYOHsnmcv7xo/Eo81+zdQQwcmL55DaUt8YwEvCezwflqmgs9FEDNKE8',
  'Rae/QeSJ5xSTrLyWj68ebGsfZddu3ItXCdFD8RxhSj2vOp8ry9ZTYbM1eZT4kwi8',
  'bZFdLiu59yzkaimw33GdnkuXL5V2g0FU8de6a3KS9QiS+fWj2j2tcKAVMwhqex3m',
  'wXzygOl5H9ZadusDf9uT+q0qMxoRA12Cfkm442d4oYodJajtu0w+ExZRjpm5SP4A',
  'oIkcJwFWuvQLLozrn0yfuhp8B3/2lparIdDbiMtUGvwy67BAg69W6PMHSL/JZTzS',
  'mQIDAQAB',
  '-----END PUBLIC KEY-----'
].join('\n')

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
// 测试夹具：形状像 JWT 的假 idToken（不是任何真实凭据）
const idTokenValid =
  'aaa.' + b64url({ name: '张三', organizationName: '郑州大学', exp: Math.floor(Date.now() / 1000) + 30 * 86400 }) + '.ccc'
const idTokenExpired =
  'eee.' + b64url({ exp: Math.floor(Date.now() / 1000) - 3600 }) + '.fff'

// 教务 course-table 夹具（形状照抄 ZZU.Py 的 LessonModel：camelCase）
const COURSE_TABLE = {
  result: 0,
  msg: 'ok',
  data: [
    {
      course: { nameZh: '高等数学' },
      schedules: [
        { date: '2026-09-08', weekday: 2, startUnit: 1, endUnit: 2, weekIndex: 1, room: { nameZh: '南1-301' }, teacherName: '王老师' },
        { date: '2026-10-13', weekday: 2, startUnit: 1, endUnit: 2, weekIndex: 6, room: { nameZh: '南1-301' } }
      ]
    },
    {
      course: { nameZh: '大学英语' },
      schedules: [
        { date: '2026-09-11', weekday: 4, startUnit: 3, endUnit: 4, weekIndex: 1, room: { nameZh: '北3-201' } },
        { date: '2026-09-18', weekday: 4, startUnit: 3, endUnit: 4, weekIndex: 2, room: { nameZh: '北3-201' } }
      ]
    }
  ]
}

const calls = { detect: 0, login: 0 }
let mfaDetectMode = 'off' // 'off'=探测接口挂了 | 'need'=要短信 | 'noneed'=设备已信任
let mfaInitOk = true
let smsSendOk = true
let mfaVerified = false // 短信验证通过后，passwordLogin 才放行（服务端真实行为）
let mfaStateSeq = 0
const smsSends = []
const SMS_CODE = '123456'
let rejectToken = false // false | true（result -1）| 'token'（无效token）
let seenEamsToken = ''
let seenCourseTable = false

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

HTTP.request = async (url, opts) => {
  const u = String(url)
  const q = u.replace(/^[^?]*\?/, '')
  const params = {}
  q.split('&').forEach((kv) => {
    const i = kv.indexOf('=')
    if (i > 0) params[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1))
  })

  if (u.indexOf('/token/jwt/publicKey') > -1) return resp(200, {}, TEST_PUBLIC_KEY_PEM)

  if (u.indexOf('/token/mfa/detect') > -1) {
    calls.detect++
    if (mfaDetectMode === 'off') return resp(404, {}, 'not found')
    return resp(200, {}, JSON.stringify({
      code: 0,
      data: {
        state: 'mfa_state_' + ++mfaStateSeq,
        need: mfaDetectMode === 'need',
        mfaTypeSecurePhone: true
      }
    }))
  }

  if (u.indexOf('/token/mfa/initByType/securephone') > -1) {
    if (!mfaInitOk) return resp(200, {}, JSON.stringify({ code: 500, message: '安全手机未绑定' }))
    return resp(200, {}, JSON.stringify({
      code: 0,
      data: { gid: 'fixture-gid-9x', attestServerUrl: 'https://cas.s.zzu.edu.cn/attest', securePhone: '13800001234' }
    }))
  }

  if (u.indexOf('/api/guard/securephone/send') > -1) {
    smsSends.push(u)
    if (!smsSendOk) return resp(200, {}, JSON.stringify({ code: 500, message: '发送太频繁' }))
    return resp(200, {}, JSON.stringify({ code: 0, data: { result: 'sent' } }))
  }

  if (u.indexOf('/api/guard/securephone/valid') > -1) {
    let body = {}
    try { body = JSON.parse((opts && opts.body) || '{}') } catch (e) { /* 保持空 */ }
    if (body.code === 'expired') return resp(200, {}, JSON.stringify({ code: 0, data: { result: 'expired' } }))
    if (body.code === SMS_CODE) mfaVerified = true
    return resp(200, {}, JSON.stringify({ code: 0, data: { status: body.code === SMS_CODE ? 2 : 0, result: 'ok' } }))
  }

  if (u.indexOf('/token/password/passwordLogin') > -1) {
    calls.login++
    // 真实行为：MFA 未完成时密码登录被拒；设备已信任或验证过了才发 token
    if (!mfaVerified && mfaDetectMode === 'need') {
      return resp(200, {}, JSON.stringify({ code: 5001, message: 'MFA 未完成' }))
    }
    mfaVerified = false
    // 测试夹具：假 idToken / 假 refreshToken（不是任何真实凭据）
    const mockRefresh = ['fixture', 'refresh', 'not', 'real'].join('-')
    return resp(200, {}, JSON.stringify({
      code: 0,
      data: { idToken: idTokenValid, refreshToken: mockRefresh }
    }))
  }

  if (u.indexOf('/eams-micro-server/api/v1/semester/current-semester') > -1) {
    seenEamsToken = (opts && opts.headers && opts.headers.authorization) || ''
    // 'token' 模拟教务用另一种文案拒票（「无效token」，result 也不是 0）
    if (rejectToken === 'token') return resp(200, {}, JSON.stringify({ result: 401, msg: '无效token' }))
    if (rejectToken) return resp(200, {}, JSON.stringify({ result: -1, msg: '未登录' }))
    return resp(200, {}, JSON.stringify({ result: 0, msg: 'ok', data: { id: 20261 } }))
  }

  if (u.indexOf('/eams-micro-server/api/v1/lesson/student/course-table/') > -1) {
    seenCourseTable = true
    return resp(200, {}, JSON.stringify(COURSE_TABLE))
  }
  return resp(404, {}, '')
}

const Z = require('../cloudfunctions/studyHub/lib/zzu.js')
const I = Z._internal

/* ------------------------------------------------------------------ */
;(async () => {
  console.log('\n【JWT / 工具】')
  {
    const payload = { name: '张三', organizationName: '郑州大学', exp: Math.floor(Date.now() / 1000) + 60 }
    const jwt = 'aaa.' + b64url(payload) + '.ccc'
    const got = I.jwtPayload(jwt)
    eq('JWT 用户名', got.name, '张三')
    eq('没过期的 token 不算过期', I.tokenExpired(jwt), false)
    eq('过期的 token 算过期', I.tokenExpired(idTokenExpired), true)
    eq('读不出来的 token 算过期', I.tokenExpired('abc'), true)

    eq('完整号码 → 前3后4', I.maskPhone('13800001234'), '138****1234')
    eq('已是打码格式保持原样', I.maskPhone('138****1234'), '138****1234')
    const d1 = I.deviceIdOf({})
    ok('设备号自动生成且带前缀', d1.indexOf('zzu-mini-') === 0, d1)
    eq('已有设备号不覆盖', I.deviceIdOf({ deviceId: 'keep-me' }), 'keep-me')
  }

  console.log('\n【教务课表 → 课表格子】')
  {
    const { items, meta, termStart } = I.parseCourseTable(COURSE_TABLE)
    eq('聚合成 2 个格子', items.length, 2)
    eq('课程数 / 节次数', [meta.courses, meta.lessons], [2, 4])
    eq('第 1 格课程名', items[0].name, '高等数学')
    eq('第 1 格星期和节次', [items[0].day, items[0].start, items[0].end], [2, 1, 2])
    eq('第 1 格地点', items[0].place, '南1-301')
    eq(
      '周次保留精确列表（第 1 和第 6 周，中间的 2-5 周没课）',
      items[0].weeks,
      { from: 1, to: 6, list: [1, 6], parity: 0 }
    )
    eq('连续周次（1、2 周）list 完整', items[1].weeks, { from: 1, to: 2, list: [1, 2], parity: 0 })
    eq('开学周一从第 1 周的课反推', termStart, '2026-09-07')
    eq('格子 id 稳定', items[0].id, '2|1|2|高等数学')
    const bad = I.parseCourseTable({ result: 500, msg: 'x' })
    eq('result 非 0 返回空', bad.items.length, 0)
    const noDay = I.parseCourseTable({ result: 0, data: [{ course: { nameZh: '无节次' }, schedules: [{ weekday: 9, startUnit: 1, weekIndex: 1 }] }] })
    eq('星期越界就跳过', noDay.items.length, 0)

    // 散点实验课：第 4、6、8 周各一次 —— 以前只记 4-8，中间没课的 5、7 周也被显示
    const lab = I.parseCourseTable({
      result: 0,
      data: [
        {
          course: { nameZh: '大学物理实验' },
          schedules: [
            { date: '2026-09-29', weekday: 3, startUnit: 5, endUnit: 6, weekIndex: 4, room: { nameZh: '物理实验大楼305' } },
            { date: '2026-10-13', weekday: 3, startUnit: 5, endUnit: 6, weekIndex: 6 },
            { date: '2026-10-27', weekday: 3, startUnit: 5, endUnit: 6, weekIndex: 8, room: { nameZh: '物理实验大楼305' } }
          ]
        }
      ]
    })
    eq('散点周次保留完整列表（全偶数 → 顺手标双周）', lab.items[0].weeks, { from: 4, to: 8, list: [4, 6, 8], parity: 2 })
    eq('第一条没教室、后面补上', lab.items[0].place, '物理实验大楼305')

    // 体育课只在单周上 → 打上单周标记（不带 list 的旧端退回 from/to 也不会错）
    const pe = I.parseCourseTable({
      result: 0,
      data: [
        {
          course: { nameZh: '体育' },
          schedules: [3, 5, 7].map((w) => ({
            date: '2026-09-2' + w, weekday: 1, startUnit: 7, endUnit: 8, weekIndex: w, room: { nameZh: '北操场' }
          }))
        }
      ]
    })
    eq('纯单周 → parity=1', pe.items[0].weeks.parity, 1)
    eq('纯单周 list 不丢', pe.items[0].weeks.list, [3, 5, 7])

    // 数据覆盖范围（判断教务是不是只给了一半学期的关键指标）
    eq('覆盖周次 = 出现过的最小/最大周', I.parseCourseTable(COURSE_TABLE).meta.weeks, [1, 6])

    // schedules 展开为空的教学班：用排课文字描述兜底，别让整门课消失
    const txt = I.parseCourseTable({
      result: 0,
      data: [
        {
          course: { nameZh: '人工智能导论' },
          schedules: [],
          scheduleText: {
            dateTimePlaceText: {
              textZh: '1~16周 星期四 3~4节 主校区 北3_111；2~17周(单) 星期二 9~10节 主校区 南4_201'
            }
          }
        },
        {
          course: { nameZh: '军事理论(网课)' },
          schedules: [],
          scheduleText: { dateTimePlaceText: { textZh: '线上学习，不排课' } }
        }
      ]
    })
    eq('文字兜底解析出 2 个格子', txt.items.length, 2)
    eq('文字兜底：周四 3-4 节', [txt.items[0].day, txt.items[0].start, txt.items[0].end], [4, 3, 4])
    eq('文字兜底：周次和地点', [txt.items[0].weeks.from, txt.items[0].weeks.to, txt.items[0].place], [1, 16, '主校区 北3_111'])
    eq('文字兜底：周二 9-10 节单周', [txt.items[1].day, txt.items[1].start, txt.items[1].end, txt.items[1].weeks.parity], [2, 9, 10, 1])
    eq('两种都放不出格子的课点名', txt.meta.noSchedule, ['军事理论(网课)'])

    // 文字解析器单独喂
    const segs = I.parseScheduleText('X', '1~16周 星期六 1~2节 主校区 402')
    eq('文字解析：周六', [segs[0].day, segs[0].start, segs[0].end], [6, 1, 2])
    const none = I.parseScheduleText('X', '每周答疑，时间待定')
    eq('放不进格子的文字返回空', none.length, 0)

    // 分组实验课：教务只给一条占位明细（第 17 周），文字声明却是整个学期 —— 按声明补全
    const labFull = I.parseCourseTable({
      result: 0,
      data: [
        {
          course: { nameZh: '大学物理实验A(Ⅰ)' },
          schedules: [
            { date: '2027-01-04', weekday: 1, startUnit: 1, endUnit: 4, weekIndex: 17, room: { nameZh: '物理实验中心楼' } }
          ],
          scheduleText: {
            dateTimePlaceText: {
              // 真实语法：#分组号 + 逗号分段周次（段内可带单双周）+ 分号多段
              textZh: '#1 1~3(单),7~13(单),17周 星期一 1~4节; #1 15周 星期一 1~4节 主校区 物理实验中心楼'
            }
          }
        }
      ]
    })
    eq(
      '占位明细按多段声明补全（两段并集）',
      labFull.items[0].weeks,
      { from: 1, to: 17, parity: 1, list: [1, 3, 7, 9, 11, 13, 15, 17] }
    )
    eq('补全的课点名', labFull.meta.textBased, ['大学物理实验A(Ⅰ)'])
    ok('声明文本进了 meta', /1~3\(单\),7~13\(单\),17周/.test(labFull.meta.textByName['大学物理实验A(Ⅰ)'] || ''))

    // 简单范围声明也能补
    const labSimple = I.parseCourseTable({
      result: 0,
      data: [
        {
          course: { nameZh: '占位实验' },
          schedules: [{ date: '2027-01-04', weekday: 1, startUnit: 1, endUnit: 4, weekIndex: 17 }],
          scheduleText: { dateTimePlaceText: { textZh: '1~17周 星期一 1~4节 主校区 物理实验大楼' } }
        }
      ]
    })
    eq(
      '占位明细按声明展开成 1-17 周',
      labSimple.items[0].weeks,
      { from: 1, to: 17, parity: 0, list: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17] }
    )

    // 声明带单双周：只展开奇数周
    const labOdd = I.parseCourseTable({
      result: 0,
      data: [
        {
          course: { nameZh: '分组实验' },
          schedules: [{ date: '2027-01-04', weekday: 1, startUnit: 1, endUnit: 4, weekIndex: 17 }],
          scheduleText: { dateTimePlaceText: { textZh: '4~17周(单) 星期一 1~4节 实验楼' } }
        }
      ]
    })
    eq('声明(单)只展开奇数周', labOdd.items[0].weeks.list, [5, 7, 9, 11, 13, 15, 17])
    eq('声明(单)带 parity', labOdd.items[0].weeks.parity, 1)

    // 周次语法单元测试（全部来自真实教务声明）
    eq(
      '多段+段内双周', 
      I.parseWeekList('1~4,6~8(双),9~16周'),
      [1, 2, 3, 4, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16]
    )
    eq('单周+散点', I.parseWeekList('1~3(单),7~13(单),17周'), [1, 3, 7, 9, 11, 13, 17])
    eq('散点+范围+双周', I.parseWeekList('2,7~8,10~16(双)周'), [2, 7, 8, 10, 12, 14, 16])
    eq('单一范围', I.parseWeekList('1~16周'), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
    eq('结尾单双周', I.parseWeekList('2~17周(单)'), [3, 5, 7, 9, 11, 13, 15, 17])
    eq('认不出的语法返回空（宁可不补）', I.parseWeekList('每周 3~4节 主校区'), [])
    eq('空串返回空', I.parseWeekList(''), [])

    // 明细丰富的课（>2 条）绝不用文字覆盖：调课/停课的精度在明细里
    const rich = I.parseCourseTable({
      result: 0,
      data: [
        {
          course: { nameZh: '知识表示与处理' },
          schedules: [6, 7].map((w) => ({
            date: '2026-10-16', weekday: 5, startUnit: 1, endUnit: 2, weekIndex: w, room: { nameZh: 'N301' }
          })).concat([{ date: '2026-09-11', weekday: 5, startUnit: 7, endUnit: 8, weekIndex: 1, room: { nameZh: 'N301' } }]),
          scheduleText: { dateTimePlaceText: { textZh: '1~17周 星期五 1~2节 主校区 N301' } }
        }
      ]
    })
    const richFri12 = rich.items.find((x) => x.start === 1)
    eq('明细 >2 条：文字声明不覆盖精确周列表', richFri12.weeks.list, [6, 7])
  }

  console.log('\n【学期范围】')
  {
    const a = I.defaultRange(new Date(2026, 9, 24))
    eq('10 月 → 当年 8 月起', a.from, '2026-08-01')
    eq('10 月 → 次年 3 月底', a.to, '2027-03-31')
  }

  console.log('\n【密码登录：撞 MFA → 发短信 → 存接力态】')
  mfaDetectMode = 'need'
  const m1 = await Z.auto({ openid: 'o_mfa', username: '202515020339', password: 'SecretPw123' })
  ok('没直接成功（在等验证码）', !m1.success)
  ok('明确标记 needMfaCode', m1.needMfaCode === true, m1)
  ok('手机号已打码', m1.phone === '138****1234', m1.phone)
  ok('提示里说明验证码已发', /验证码/.test(String(m1.message || '')), m1.message)
  eq('短信真的发出去了', smsSends.length, 1)
  const mfaDoc = Array.from(docs.values()).find((d) => d.openid === 'o_mfa')
  ok('接力态存了 mfaState（detect 发的）', mfaDoc && /^mfa_state_/.test(mfaDoc.mfaState || ''), mfaDoc && mfaDoc.mfaState)
  ok('接力态存了学号', mfaDoc && mfaDoc.mfaUser === '202515020339')
  ok('设备号已固定下来', mfaDoc && /^zzu-mini-/.test(mfaDoc.deviceId || ''), mfaDoc && mfaDoc.deviceId)
  ok('gid 是加密落库的', mfaDoc && mfaDoc.mfaGid && mfaDoc.mfaGid.indexOf('fixture-gid') === -1)
  ok('账号密码密文也是加密落库的', mfaDoc && mfaDoc.mfaPass && mfaDoc.mfaPass.indexOf('__RSA__') === -1)

  console.log('\n【双因子短信：验证码不对】')
  const m2 = await Z.mfaVerify({ openid: 'o_mfa', code: '000000' })
  ok('没通过', !m2.success)
  ok('还在等验证码', m2.needMfaCode === true, m2)
  ok('提示验证码不对', /验证码/.test(String(m2.message || '')), m2.message)

  console.log('\n【双因子短信：重发】')
  smsSends.length = 0
  const m3 = await Z.mfaVerify({ openid: 'o_mfa', resend: true })
  ok('重发成功', /重发/.test(String(m3.message || '')), m3.message)
  eq('又发了一条短信', smsSends.length, 1)

  console.log('\n【双因子短信：验证通过 → passwordLogin → 拉回课表】')
  const m4 = await Z.mfaVerify({ openid: 'o_mfa', code: SMS_CODE })
  ok('登录成功', m4.success === true, m4)
  eq('课表一并拉回', m4.count, 2)
  ok('标记为已登录', m4.loggedIn === true)
  eq('教务拿到的正是 idToken（Authorization 头）', seenEamsToken, idTokenValid)
  const afterDoc = Array.from(docs.values()).find((d) => d.openid === 'o_mfa')
  ok('接力态已清掉', afterDoc && !afterDoc.mfaGid && !afterDoc.mfaState)
  ok('idToken 已入库（约一个月免密）', !!(afterDoc && afterDoc.appToken))

  console.log('\n【之后：只靠库里的 idToken 免密免短信】')
  const beforeLogin = calls.login
  const r3 = await Z.auto({ openid: 'o_mfa' })
  ok('免密免短信也能拉到', r3.success, r3)
  eq('条数不变', r3.count, 2)
  eq('这一轮没有重新走密码登录', calls.login, beforeLogin)
  const st = await Z.status({ openid: 'o_mfa' })
  ok('状态为已登录', st.loggedIn)
  ok('留下了上次拉取时间', st.lastPullAt > 0)

  console.log('\n【课表诊断：教务到底给了什么】')
  const dbg = await Z.tableDebug({ openid: 'o_mfa' })
  ok('诊断返回成功', dbg.success === true, dbg)
  ok(
    '摘要带覆盖周次（夹具是第 1-6 周）',
    Array.isArray(dbg.summary.weeks) && dbg.summary.weeks[0] === 1 && dbg.summary.weeks[1] === 6,
    dbg.summary && dbg.summary.weeks
  )
  ok('按课程名分组', dbg.summary.byName && Array.isArray(dbg.summary.byName['高等数学']))
  eq(
    '高等数学摘要行：星期 节次 [精确周列表]',
    dbg.summary.byName['高等数学'][0],
    '周二 1-2节 [1,6]'
  )
  const dbgNone = await Z.tableDebug({ openid: 'o_never' })
  ok('没拉过的给明确提示', dbgNone.success === false && /先点一次/.test(String(dbgNone.message || '')), dbgNone)

  console.log('\n【门户拒了 idToken（无效token）：清登录态、允许重登】')
  mfaDetectMode = 'noneed' // 设备已被信任，重登不再收短信
  rejectToken = 'token'
  const k2 = await Z.schedule({ openid: 'o_mfa' })
  ok('明确回 needLogin', k2.needLogin === true, k2)
  ok('错误信息保留门户原文', /无效token/.test(String(k2.error || '')), k2.error)
  ok('提示里给出路（重新登录）', /重新/.test(String(k2.hint || '')), k2.hint)
  const tokDoc = Array.from(docs.values()).find((d) => d.openid === 'o_mfa')
  ok('idToken 被清掉', tokDoc && !tokDoc.appToken, tokDoc && tokDoc.appToken)
  rejectToken = false // 重新登录拿到新 idToken 后，门户恢复正常
  const sendsBefore = smsSends.length
  const k3 = await Z.auto({ openid: 'o_mfa', username: '202515020339', password: 'SecretPw123' })
  ok('再带密码登录不再卡在无效token', k3.success === true, k3)
  eq('设备已信任：这一轮没有再发短信', smsSends.length, sendsBefore)

  console.log('\n【双因子短信：验证码过期】')
  mfaDetectMode = 'need'
  const m5 = await Z.auto({ openid: 'o_exp', username: '202515020339', password: 'SecretPw123' })
  ok('进入等验证码状态', m5.needMfaCode === true)
  const expDoc = Array.from(docs.values()).find((d) => d.openid === 'o_exp')
  expDoc.formAt = Date.now() - 11 * 60 * 1000 // 超过 10 分钟
  const m6 = await Z.mfaVerify({ openid: 'o_exp', code: SMS_CODE })
  ok('提示会话过期', m6.needRestart === true, m6)
  ok('提示里说明过期', /过期/.test(String(m6.message || '')), m6.message)
  const expAfter = Array.from(docs.values()).find((d) => d.openid === 'o_exp')
  ok('过期接力态已清掉', expAfter && !expAfter.mfaGid)

  console.log('\n【没先登录就填验证码】')
  const m7 = await Z.mfaVerify({ openid: 'o_nobody', code: SMS_CODE })
  ok('明确说没有进行中的验证', m7.needRestart === true, m7)

  console.log('\n【探测接口挂了：明确报错】')
  mfaDetectMode = 'off'
  const m8 = await Z.auto({ openid: 'o_off', username: '202515020339', password: 'SecretPw123' })
  ok('报「统一认证探测失败」而不是含糊其辞', !m8.success && /探测失败/.test(String(m8.error || '')), m8)

  console.log('\n【idToken 过期：要求重新登录】')
  mfaDetectMode = 'noneed'
  await Z.auto({ openid: 'o_stale', username: '202515020339', password: 'SecretPw123' })
  const staleDoc = Array.from(docs.values()).find((d) => d.openid === 'o_stale')
  staleDoc.appToken = idTokenExpired
  const s1 = await Z.schedule({ openid: 'o_stale' })
  ok('过期 token 直接要求重登', s1.needLogin === true, s1)
  const s2 = await Z.status({ openid: 'o_stale' })
  ok('状态也回到未登录', !s2.loggedIn)

  console.log('\n【没登录就拉课表 / 没凭据就引导】')
  const r4 = await Z.schedule({ openid: 'o_none' })
  ok('明确要求重新登录', r4.needLogin)
  ok('给出人话提示', String(r4.hint || '').length > 0)
  const r5 = await Z.auto({ openid: 'o_none' })
  ok('没凭据时回 needCredentials', r5.needCredentials === true, r5)
  ok('提示里说明短信流程', /短信/.test(String(r5.hint || '')), r5.hint)

  console.log('\n【退出 / 状态】')
  const out = await Z.logout({ openid: 'o_mfa' })
  ok('退出后未登录', !out.loggedIn)
  eq('会话文档已删除', Array.from(docs.values()).filter((d) => d.openid === 'o_mfa').length, 0)

  console.log('\n【库里不该有敏感原文】')
  const dump = JSON.stringify(Array.from(docs.values()))
  ok('整个库都搜不到明文密码', dump.indexOf('SecretPw123') === -1)
  ok('整个库都搜不到 RSA 密文标记', dump.indexOf('__RSA__') === -1)
  ok('整个库都搜不到 gid 原文', dump.indexOf('fixture-gid') === -1)
  ok('整个库都搜不到完整手机号', dump.indexOf('13800001234') === -1)
  ok('整个库都搜不到 idToken 原文', dump.indexOf(idTokenValid) === -1)

  console.log('\n----------------------------------------')
  console.log(`通过 ${pass}  失败 ${fail}`)
  process.exitCode = fail ? 1 : 0
})().catch((e) => {
  console.error('\n测试崩了：', e)
  process.exitCode = 1
})
