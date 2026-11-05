/**
 * U校园适配器测试（AI 版 5.0 接口，全离线）
 *   node test/unipus.js
 *
 * 2026-10 重写后的接口链路（路径来自 UnipusHelperPro/AutoUnipus 逆向）：
 *   ① GET uai.unipus.cn/home                —— 让 uai 域种上会话（SSO 接力）
 *   ② GET /api/account/user/info            —— 登录态检查 + 拿 appUserId
 *   ③ GET /api/cmgt/course/getCourseListByStudent
 *   ④ POST /api/tla/courseStudyStrategy/detail（单元 + 学习截止）
 *   ⑤ GET /api/tla/learningDetail/.../totalAndUnitSituation（单元完成度）
 * 这里把 ①~⑤ 全部 mock 掉，钉死：
 *   - 单元任务的标题 / 截止时间 / 完成状态 / 学期标签
 *   - 教材资源多本、课程没资源、单元缺进度时的兜底
 *   - SSO 登录态失效、用户信息不认这两种报错
 *   - 密码模式走 /sso/0.1/sso/login（JSON 明文接口）
 *
 * 注意：适配器是解构引入 request 的，所以必须先给 lib/http 打补丁、再加载适配器。
 */

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

const UAI = 'https://uai.unipus.cn'
const UNIT1_END = new Date(2026, 9, 30, 23, 59).getTime()
const UNIT2_END = new Date(2026, 11, 20, 23, 59).getTime()

const COURSE_LIST = {
  code: 1,
  msg: 'SUCCESS',
  value: {
    courseList: [
      {
        id: 301,
        name: '大学英语III-1班',
        classId: 'c001',
        startTime: new Date(2026, 8, 1).getTime(),
        courseResourceList: [
          {
            id: 2000001,
            resourceId: 'course-v2:Unipus+nhce_3_rw+20260901',
            instanceId: 'course-v2:inst001+nhce_3_rw+20260901',
            strategyId: 10,
            name: '新视野大学英语 读写教程3',
            finishPointNum: 3,
            totalPointNum: 4
          }
        ]
      },
      {
        id: 302,
        name: '大学英语视听说II-2班',
        classId: 'c002',
        startTime: new Date(2026, 8, 1).getTime(),
        courseResourceList: [
          {
            id: 2000002,
            instanceId: 'course-v2:inst002+listen+20260301',
            strategyId: 20,
            name: '视听说教程2',
            finishPointNum: 0,
            totalPointNum: 10
          }
        ]
      },
      {
        id: 303,
        name: '没挂教材的课',
        courseResourceList: []
      },
      {
        id: 304,
        name: '新文科英语',
        classId: 'c004',
        startTime: new Date(2026, 8, 1).getTime(),
        courseResourceList: [
          {
            id: 2000004,
            instanceId: 'course-v2:inst004+xwk+20260901',
            strategyId: 30,
            name: '新文科英语综合教程',
            finishPointNum: 0,
            totalPointNum: 10
          }
        ]
      },
      // 往期学期的课：U校园账号里通常还挂着，不该把它的任务算进来
      {
        id: 305,
        name: '大学英语读写II（往期）',
        classId: 'c005',
        startTime: new Date(2025, 2, 1).getTime(),
        courseResourceList: [
          {
            id: 2000005,
            instanceId: 'course-v2:inst005+old+20250301',
            strategyId: 40,
            name: '新视野大学英语 读写教程2',
            finishPointNum: 0,
            totalPointNum: 10
          }
        ]
      }
    ]
  }
}

const STRATEGY = {
  10: {
    code: 1,
    value: {
      courseUnitStrategyList: [
        // requiredTask = 老师打了星号的必做任务清单；空数组 = 没点星的单元（要隐藏）
        { unitId: 'u1', caption: 'Unit 1', unitName: 'Language in mission', studyEndTime: UNIT1_END, sort: 1, requiredTask: ['l1', 'l2'] },
        { unitId: 'u2', caption: 'Unit 2', unitName: 'Language in use', studyEndTime: UNIT2_END, sort: 2, requiredTask: [] }
      ],
      courseInfo: { term: '2026秋季', startTime: new Date(2026, 8, 1).getTime() }
    }
  },
  20: {
    code: 1,
    value: {
      courseUnitStrategyList: [
        { unitId: 'v1', caption: 'Unit 1', unitName: 'Listening', studyEndTime: UNIT2_END, sort: 1, requiredTask: ['w1'] }
      ],
      courseInfo: { term: '2026秋季' }
    }
  },
  // 新文科英语：规则课 —— requiredTask 全空（老师没点星），但要显示 Test 任务
  30: {
    code: 1,
    value: {
      courseUnitStrategyList: [
        { unitId: 'w1', caption: 'Unit 1', unitName: 'Module 1', studyEndTime: UNIT1_END, sort: 1, requiredTask: [] },
        { unitId: 'w2', caption: 'Unit 2', unitName: 'Module 2', studyEndTime: UNIT2_END, sort: 2, requiredTask: [] }
      ],
      courseInfo: { term: '2026秋季', startTime: new Date(2026, 8, 1).getTime() }
    }
  },
  // 往期课：如果学期过滤失效，它的 Unit Test 会混进来
  40: {
    code: 1,
    value: {
      courseUnitStrategyList: [
        { unitId: 'o1', caption: 'Unit 1', unitName: 'Old Unit', studyEndTime: UNIT1_END, sort: 1, requiredTask: [] }
      ],
      courseInfo: { startTime: new Date(2025, 2, 1).getTime() }
    }
  }
}

// 单元任务树（unitTaskSituation）：叶子带 required / finishProgress / scoreTaskFlag
const TREE = {
  u1: {
    code: 1,
    value: {
      list: [
        {
          nodeId: 'u1', caption: 'Unit 1', name: 'Language in mission', required: true, role: 'unit',
          children: [
            {
              nodeId: 's1', name: 'Section A', role: 'section', required: true,
              children: [
                // 中间再套一层同名节点，验证层级名去重
                {
                  nodeId: 'n1', name: 'Section A', role: 'node', required: true,
                  children: [
                    // 目标项 Unit Test，已做完 → 不推送
                    { nodeId: 'l1', name: 'Unit Test', role: 'link', required: true, finishProgress: 100, scoreTaskFlag: true },
                    // 目标项 Further Listening，在 requiredTask 清单里 → 必做
                    { nodeId: 'l2', name: 'Further Listening', role: 'link', required: false, finishProgress: 40, scoreTaskFlag: false },
                    // 非目标项（预习材料类）→ 不显示
                    { nodeId: 'l3', name: 'Video', role: 'link', required: false, finishProgress: 0, scoreTaskFlag: false },
                    // 非目标项，即使老师给分 → 也不显示（只留 Unit Test / Further Listening）
                    { nodeId: 'l4', name: 'Discussion', role: 'link', required: false, finishProgress: 20, scoreTaskFlag: true }
                  ]
                },
                // 同一单元第二处又有一个 Further Listening：同类型只留一条
                {
                  nodeId: 'n2', name: 'Section B', role: 'node',
                  children: [
                    { nodeId: 'l5', name: 'Further Listening', role: 'link', required: false, finishProgress: 0, scoreTaskFlag: false }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  },
  v1: {
    code: 1,
    value: {
      list: [
        {
          nodeId: 'v1', caption: 'Unit 1', name: 'Listening', required: false, role: 'unit',
          children: [
            // 视听说：只做 Unit Test 和 Further Listening，其他（视频/理解题）都不做
            { nodeId: 'f1', name: 'Unit Test', role: 'link', required: false, finishProgress: 0, scoreTaskFlag: false },
            { nodeId: 'f2', name: 'Further Listening', role: 'link', required: false, finishProgress: 50, scoreTaskFlag: false },
            { nodeId: 'f3', name: 'Video', role: 'link', required: false, finishProgress: 100, scoreTaskFlag: false },
            // 标星但规则课里不算必做（老师只让做 Test/Further Listening）
            { nodeId: 'f4', name: 'Understanding the text', role: 'link', required: true, finishProgress: 20, scoreTaskFlag: false }
          ]
        }
      ]
    }
  },
  w1: {
    code: 1,
    value: {
      list: [
        {
          nodeId: 'w1', caption: 'Unit 1', name: 'Module 1', required: false, role: 'unit',
          children: [
            // 规则课：Test 命中（即使没星没分），Listening 不命中（要隐藏）
            { nodeId: 't9', name: 'Unit Test 1', role: 'link', required: false, finishProgress: 0, scoreTaskFlag: false },
            { nodeId: 'v9', name: 'Listening', role: 'link', required: false, finishProgress: 30, scoreTaskFlag: false }
          ]
        }
      ]
    }
  },
  w2: {
    code: 1,
    value: {
      list: [
        {
          nodeId: 'w2', caption: 'Unit 2', name: 'Module 2', required: false, role: 'unit',
          children: [
            // 整个单元唯一命中的任务已完成 → 单元整体隐藏
            { nodeId: 'x1', name: 'Unit Test 2', role: 'link', required: false, finishProgress: 100, scoreTaskFlag: false }
          ]
        }
      ]
    }
  },
  // 往期课的树：学期过滤生效的话，这棵树根本不会被请求
  o1: {
    code: 1,
    value: {
      list: [
        {
          nodeId: 'o1', caption: 'Unit 1', name: 'Old Unit', required: false, role: 'unit',
          children: [
            { nodeId: 'o2', name: 'Unit Test', role: 'link', required: true, finishProgress: 0, scoreTaskFlag: true }
          ]
        }
      ]
    }
  }
}

let noStar = false // true = 模拟老师从头到尾没点过星（且规则课的树也为空）

const PROGRESS = {
  // key = 教材资源 id（res0.id），totalAndUnitSituation 现在传这个而不是 courseId
  2000001: {
    code: 1,
    value: {
      unitList: [
        { nodeId: 'u1', caption: 'Unit 1', name: 'Language in mission', finishProgress: 70, required: true, role: 'unit' },
        { nodeId: 'u2', caption: 'Unit 2', name: 'Language in use', finishProgress: 40, required: true, role: 'unit' }
      ]
    }
  },
  2000002: { code: 1, value: { unitList: [] } }
}

let userOk = true
let ssoLanding = false // true = uai 首页被踢回 SSO 登录页
let ssoLoginOk = true
const seen = { cookie: '', strategyBodies: [], progressQueries: [], treeQueries: [] }

const HTTP = require('../cloudfunctions/studyHub/lib/http.js')

HTTP.request = async (url, opts) => {
  const u = String(url)
  const headers = (opts && opts.headers) || {}

  if (u.indexOf('sso.unipus.cn/sso/0.1/sso/login') > -1) {
    if (!ssoLoginOk) return resp(200, {}, JSON.stringify({ code: '101', msg: '密码错误' }))
    if (opts && opts.jar) opts.jar.setFromHeader('jwt=abc.def.ghi; Path=/')
    return resp(200, {}, JSON.stringify({ code: '0', msg: 'ok', rs: { openid: 'o9', jwt: 't' } }))
  }

  if (u === UAI + '/home') {
    if (ssoLanding) return resp(200, {}, '<html>登录</html>', 'https://sso.unipus.cn/sso/login?service=x')
    return resp(200, {}, '<html>uai home</html>', UAI + '/home')
  }

  if (u.indexOf(UAI + '/api/account/user/info') > -1) {
    // 真实 request() 会把 jar.header() 塞进 Cookie 头，这里直接验 jar 内容
    seen.cookie = ((opts && opts.jar && opts.jar.header()) || headers.cookie || '')
    if (!userOk) return resp(200, {}, JSON.stringify({ code: 401, msg: '请登录' }))
    return resp(200, {}, JSON.stringify({
      code: 1,
      msg: 'SUCCESS',
      value: { userInfo: { ssoId: 'sso-1', name: '张三', code: '20240001', appUserId: '999888', schName: '郑州大学' } }
    }))
  }

  if (u.indexOf(UAI + '/api/cmgt/course/getCourseListByStudent') > -1) {
    return resp(200, {}, JSON.stringify(COURSE_LIST))
  }

  if (u.indexOf(UAI + '/api/tla/courseStudyStrategy/detail') > -1) {
    let body = {}
    try { body = JSON.parse((opts && opts.body) || '{}') } catch (e) { /* 空 */ }
    seen.strategyBodies.push(body)
    const base = STRATEGY[body.id] || { code: 500 }
    if (!noStar) return resp(200, {}, JSON.stringify(base))
    // 老师没点星：所有单元的 requiredTask 清空
    const clone = JSON.parse(JSON.stringify(base))
    if (clone.value && clone.value.courseUnitStrategyList) {
      clone.value.courseUnitStrategyList.forEach((u2) => { u2.requiredTask = [] })
    }
    return resp(200, {}, JSON.stringify(clone))
  }

  if (u.indexOf(UAI + '/api/tla/learningDetail/studyRecord/unitTaskSituation') > -1) {
    const q = u.replace(/^.*\?/, '')
    const params = {}
    q.split('&').forEach((kv) => {
      const i = kv.indexOf('=')
      if (i > 0) params[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1))
    })
    seen.treeQueries.push(params)
    // noStar 模式：树保留（老师没点星，但单元里仍有任务，只是全部算选做）
    const tree = TREE[params.nodeId]
    return resp(200, {}, JSON.stringify(tree || { code: 1, value: { list: [] } }))
  }

  if (u.indexOf(UAI + '/api/tla/learningDetail/studyRecord/totalAndUnitSituation') > -1) {
    seen.progressQueries.push(u)
    const q = u.replace(/&amp;/g, '&').replace(/^.*\?/, '')
    const params = {}
    q.split('&').forEach((kv) => {
      const i = kv.indexOf('=')
      if (i > 0) params[kv.slice(0, i)] = kv.slice(i + 1)
    })
    return resp(200, {}, JSON.stringify(PROGRESS[Number(params.id)] || { code: 1, value: { unitList: [] } }))
  }

  return resp(404, {}, '')
}

const unipus = require('../cloudfunctions/studyHub/adapters/unipus.js')

;(async () => {
  console.log('\n【Cookie 模式：全链路（星号 + 给分，带书名层级）】')
  const r = await unipus.sync({ mode: 'cookie', cookie: 'jwt=abc; u_u=1' })

  ok('登录态检查带了 Cookie', seen.cookie.indexOf('jwt=abc') > -1, seen.cookie)
  ok('拿到任务', Array.isArray(r.tasks) && r.tasks.length > 0, r.debug)

  const BK = '大学英语III-1班·新视野大学英语 读写教程3'
  const t2 = r.tasks.find((t) => t.externalId === 'unipus:course-v2:inst001+nhce_3_rw+20260901:u1-fl')
  ok('在 requiredTask 清单里也算星号（必做）', !!t2 && t2.status === 'todo' && t2.required === true, t2)
  eq('标题截断到 Further Listening 这一层（不带小题名/序号）', t2.title, 'Unit 1 Language in mission · Section A > Further Listening')
  eq('课程名带书名', t2.courseName, BK)
  eq('进度 40%', t2.progress, { done: 40, total: 100 })
  eq('截止时间取单元 studyEndTime', t2.deadline, UNIT1_END)

  // 已完成（l1 = Unit Test fp=100）不再推送 —— 首页只出现「还要做的」
  ok('已完成的 Unit Test 不再推送', r.tasks.every((t) => t.externalId.indexOf(':u1-ut') === -1))

  // 只留 Unit Test / Further Listening 两类：其他项即使老师给分也不显示，
  // 否则真实接口一个单元 44 条细分小题，整册上千条直接把首页撑爆。
  ok('非目标项（Discussion）即使给分也不显示', r.tasks.every((t) => t.title.indexOf('Discussion') === -1), r.tasks)

  ok('预习材料（Video）不显示', r.tasks.every((t) => t.title.indexOf('Video') === -1), r.tasks)

  // 同一单元里出现第二个 Further Listening：按类型去重只留一条
  ok('同单元同类型只留一条（重复的 Further Listening 合并）', (() => {
    const fl = r.tasks.filter((t) => t.externalId === 'unipus:course-v2:inst001+nhce_3_rw+20260901:u1-fl')
    return fl.length === 1
  })(), r.tasks)
  ok('一个单元最多 2 条（Unit Test + Further Listening）', (() => {
    const inUnit1 = r.tasks.filter(
      (t) => t.externalId.indexOf('inst001+nhce_3_rw+20260901') > -1 && t.title.indexOf('Unit 1 ') === 0
    )
    return inUnit1.length <= 2
  })(), r.tasks)

  // 视听说课（规则课）：只做 Unit Test 和 Further Listening
  const f1 = r.tasks.find((t) => t.externalId === 'unipus:course-v2:inst002+listen+20260301:v1-ut')
  const f2 = r.tasks.find((t) => t.externalId === 'unipus:course-v2:inst002+listen+20260301:v1-fl')
  ok('视听说规则课：Unit Test 命中显示为必做', !!f1 && f1.required === true && f1.title.indexOf('Unit Test') > -1, f1)
  ok('视听说规则课：Further Listening 命中显示为必做', !!f2 && f2.required === true && f2.title.indexOf('Further Listening') > -1, f2)
  // 规则课只认 Unit Test / Further Listening 这一层：其余项（含预习材料、
  // 标星但不命中的、未命中的选做）一律不显示，连「不用做」都不进——
  // 否则真实接口一个单元能返回 44 条细分小题，整册上千条直接把首页撑爆。
  ok('视听说规则课：Video（不命中）直接不显示', r.tasks.every((t) => t.title.indexOf('Video') === -1), r.tasks)
  ok('视听说规则课：标星但不在规则里的项也直接不显示', r.tasks.every((t) => t.title.indexOf('Understanding') === -1), r.tasks)
  eq('视听说兜底课程名同样带书名', (f1 && f1.courseName) || '', '大学英语视听说II-2班·视听说教程2')

  const t5 = r.tasks.find((t) => t.externalId === 'unipus:course-v2:inst004+xwk+20260901:w1-ut')
  ok('规则课（新文科英语）：Unit Test 显示（标题不带序号）', !!t5 && t5.title === 'Unit 1 Module 1 · Unit Test', t5)
  eq('规则课必做任务的状态', t5.status, 'todo')
  eq('规则课必做任务带 required 标记（首页标红）', t5.required, true)
  ok('规则课（新文科）：Listening 项不显示', r.tasks.every(
    (t) => !(t.courseId === '304' && /\bListening\b/.test(t.title.replace(/Further\s*Listening/gi, '')))
  ), r.tasks)
  ok('规则课：整个单元做完的（w2）连 Test 也不显示', r.tasks.every((t) => t.externalId.indexOf(':w2-') === -1), r.tasks)
  eq('规则课任务的学期标签', t5.semesterShort, '2026 秋')

  ok('没挂教材的课程被跳过', r.tasks.every((t) => t.courseId !== '303'), r.debug)

  eq('秋季任务的学期标签', t2.semesterShort, '2026 秋')
  eq('春季任务的学期标签', f1.semesterShort, '2026 秋')

  // 往期学期的课（2025 春）不该混进本学期：整门课跳过，任务数为 0
  ok('往期学期的课程整体跳过', r.tasks.every((t) => t.courseId !== '305'), r.tasks.map((t) => t.courseId))
  ok('debug 里说明往期教材被跳过', r.debug.join('；').indexOf('往期教材') > -1, r.debug)
  ok('策略详情请求带了 strategyId + 教材 id', seen.strategyBodies.some(
    (b) => b.id === 10 && b.courseResourceId === '2000001'
  ), seen.strategyBodies)
  ok('任务树查询带了 nodeId/appUserId/ssoId', seen.treeQueries.some(
    (q) => q.nodeId === 'u1' && q.appUserId === '999888' && q.ssoId === 'sso-1'
  ), seen.treeQueries)
  // 关键回归：unitTaskSituation 的 id 要传教材资源 id（res0.id），
  // 传课程 id 会报 "CourseStudyStrategy not exist"。
  ok('任务树查询 id 传的是教材资源 id（非课程 id）', seen.treeQueries.some(
    (q) => q.nodeId === 'u1' && q.id === '2000001'
  ), seen.treeQueries)
  ok('debug 里说明必做/选做分级', /必做（红）.*选做（不用做）/.test(r.debug.join('；')), r.debug)

  console.log('\n【SSO 登录态失效】')
  ssoLanding = true
  const e1 = await unipus.sync({ mode: 'cookie', cookie: 'jwt=old' }).then(
    (x) => null,
    (e) => e
  )
  ok('报「统一认证登录态失效」', e1 && /统一认证/.test(e1.message), e1 && e1.message)
  ssoLanding = false

  console.log('\n【用户信息接口不认 Cookie】')
  userOk = false
  const e2 = await unipus.sync({ mode: 'cookie', cookie: 'jwt=bad' }).then(
    (x) => null,
    (e) => e
  )
  ok('报「Cookie 无效」', e2 && /Cookie 无效/.test(e2.message), e2 && e2.message)
  userOk = true

  console.log('\n【Cookie 为空】')
  const e3 = await unipus.sync({ mode: 'cookie', cookie: '' }).then(
    (x) => null,
    (e) => e
  )
  ok('提前拦住', e3 && /Cookie 为空/.test(e3.message), e3 && e3.message)

  console.log('\n【密码模式：走 SSO 的 JSON 登录接口】')
  ssoLoginOk = true
  const r2 = await unipus.sync({ mode: 'password', username: '13800001234', password: 'pw123' })
  ok('密码登录后同样拿到任务', r2.tasks.length > 0)

  console.log('\n【密码模式：账号密码错】')
  ssoLoginOk = false
  const e4 = await unipus.sync({ mode: 'password', username: '13800001234', password: 'bad' }).then(
    (x) => null,
    (e) => e
  )
  ok('报「账号或密码不对」并引导扫码', e4 && /账号或密码/.test(e4.message) && /扫码/.test(e4.message), e4 && e4.message)

  console.log('\n【老师全程没点星：不报错，细分小题不再堆进来】')
  noStar = true
  const r5 = await unipus.sync({ mode: 'cookie', cookie: 'jwt=abc' })
  ok('没点星也正常返回任务', r5.tasks.length > 0, r5.debug)
  ok('没点星时，没给分的细分小题不再显示（只留目标项 / 给分任务 / 单元保底）', (() => {
    return r5.tasks.every((t) => t.title.indexOf('Video') === -1)
  })(), r5.tasks)
  noStar = false

  console.log('\n----------------------------------------')
  console.log(`通过 ${pass}  失败 ${fail}`)
  process.exitCode = fail ? 1 : 0
})().catch((e) => {
  console.error('\n测试崩了：', e)
  process.exitCode = 1
})
