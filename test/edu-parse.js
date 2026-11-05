/**
 * 希冀「校园内网直连」客户端测试（全离线，用 stub 模拟 wx.request）
 *   node test/edu-parse.js
 */
const path = require('path')

/* ---------- 先造一个假的 wx 环境 ---------- */

const ROUTES = {} // url 片段 -> { status, body, type }
const store = {}

global.wx = {
  getStorageSync: (k) => store[k],
  setStorageSync: (k, v) => {
    store[k] = v
  },
  showToast: () => {},
  cloud: { callFunction: () => Promise.resolve({ result: { code: 0, data: {} } }) },
  request(opt) {
    const url = opt.url
    // 只按 path 匹配，避免 "10.67.4.14/" 这种键命中所有请求
    const p = url.replace(/^https?:\/\/[^/]+/, '') || '/'
    const key = Object.keys(ROUTES)
      .filter((k) => p.indexOf(k) === 0)
      .sort((a, b) => b.length - a.length)[0]
    if (!key) {
      // 默认 404
      opt.success({ statusCode: 404, data: 'Not Found', header: { 'Content-Type': 'text/html' } })
      return
    }
    const r = ROUTES[key]
    opt.success({ statusCode: r.status || 200, data: r.body, header: { 'Content-Type': r.type || 'text/html' } })
  }
}

const edu = require(path.join(__dirname, '../miniprogram/utils/edu.js'))

let pass = 0
let fail = 0
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + '\n      期望：' + JSON.stringify(want) + '\n      实际：' + JSON.stringify(got))
  }
}
function truthy(name, v) {
  eq(name, !!v, true)
}

function reset() {
  Object.keys(ROUTES).forEach((k) => delete ROUTES[k])
  Object.keys(store).forEach((k) => delete store[k])
}

/* ---------- 1. 默认配置 ---------- */
console.log('\n[getCfg]')
reset()
const cfg0 = edu.getCfg()
eq('默认内网地址', cfg0.base, 'http://10.67.4.14')
eq('默认无 Cookie', cfg0.cookie, '')
edu.saveCfg({ base: 'http://10.67.4.14/', cookie: 'a=1' })
const cfg1 = edu.getCfg()
eq('去掉地址尾部斜杠', cfg1.base, 'http://10.67.4.14')
eq('Cookie 已存本机', cfg1.cookie, 'a=1')

/* ---------- 2. 探测 ---------- */
console.log('\n[probe]')
reset()
edu.saveCfg({ base: 'http://10.67.4.14', cookie: 'sid=abc' })
ROUTES['/'] = {
    body: '<html><title>登录</title><input id="captchaCode" name="captchaCode"></html>'
  }
ROUTES['/api'] = { body: '{"error":"Unauthorized","message":"missing token"}', type: 'application/json' }

edu.probe().then((lines) => {
  const text = lines.join('\n')
  truthy('第一条是地址', lines[0].indexOf('地址：http://10.67.4.14') === 0)
  truthy('第二条报会话长度', lines[1].indexOf('会话：') === 0 && lines[1].indexOf('7 字节') > -1)
  truthy('站点首页摸到了', /站点首页 \/：HTTP 200/.test(text))
  truthy('token 接口返回的 JSON 被原样带出来', /missing token/.test(text))
  truthy('没登录时明确说还没登录', /还没登录/.test(text))

  /* ---------- 3. 正常抓取 ---------- */
  console.log('\n[sync]')
  reset()
  edu.saveCfg({ base: 'http://10.67.4.14', cookie: 'sid=abc' })
  ROUTES['/'] = { body: '<html><title>头歌</title>我的课程</html>' }
  ROUTES['/api/courses/mine.json'] = {
    body: JSON.stringify([
      { id: 100, name: '数据结构', start_date: '2026-09-01' },
      { id: 101, name: '大学英语（2025秋季）' }
    ]),
    type: 'application/json'
  }
  ROUTES['/api/courses/100/homework_commons.json'] = {
    body: JSON.stringify([
      { id: 11, name: '第1关 链表', finished: false, end_time: '2026-10-30 23:59' },
      { id: 12, name: '第2关 栈与队列', finished: true }
    ]),
    type: 'application/json'
  }
  ROUTES['/api/courses/101/homework_commons.json'] = {
    body: JSON.stringify([{ id: 21, name: 'Quiz 3', finished: true }]),
    type: 'application/json'
  }

  return edu
    .sync()
    .then((r) => {
      eq('任务数（课程 100 两条 + 课程 101 一条）', r.tasks.length, 3)
      eq('第一条标题', r.tasks[0].title, '第1关 链表')
      eq('未完成', r.tasks[0].status, 'todo')
      eq('已完成', r.tasks[1].status, 'done')
      eq('课程名', r.tasks[0].courseName, '数据结构')
      truthy('截止时间被解析', r.tasks[0].deadline > 0)
      eq('截止时间是 10 月 30 日', new Date(r.tasks[0].deadline).getMonth(), 9)
      truthy('链接指向内网', r.tasks[0].url.indexOf('http://10.67.4.14/homework_commons/11') === 0)
      eq('externalId 唯一', r.tasks[0].externalId !== r.tasks[1].externalId, true)
      truthy('轨迹记下了命中的接口', r.trace.join('；').indexOf('homework_commons.json?page=1&limit=200 命中') > -1)
      eq('3 门任务的学期标签都打上了', r.tasks.length, 3)
      eq('按课程开始时间判学期（2026-09-01 → 秋）', r.tasks[0].semesterShort, '2026 秋')
      eq('学期 rank 一并带上', typeof r.tasks[0].semesterRank, 'number')
      eq('课程名里的学期也能认（2025秋季）', r.tasks[2].semesterShort, '2025 秋')
      truthy('标签挂在同课程的每条任务上', r.tasks[1].semesterKey === r.tasks[0].semesterKey)
    })
    .then(() => {
      /* ---------- 4. Cookie 失效 ---------- */
      console.log('\n[sync · Cookie 失效]')
      reset()
      edu.saveCfg({ base: 'http://10.67.4.14', cookie: 'sid=old' })
      ROUTES['/'] = {
        body: '<html><title>登录 - 头歌</title><form id="new_user"><input name="user[password]"></form></html>'
      }
      return edu.sync().then(
        () => {
          fail++
          console.log('  ✗ 失效 Cookie 应该抛错')
        },
        (e) => {
          truthy('提示登录已失效', e.message.indexOf('登录已失效') > -1)
        }
      )
    })
    .then(() => {
      /* ---------- 5. 没填 Cookie ---------- */
      console.log('\n[sync · 未填 Cookie]')
      reset()
      return edu.sync().then(
        () => {
          fail++
          console.log('  ✗ 缺 Cookie 应该抛错')
        },
        (e) => {
          truthy('提示先登录', e.message.indexOf('还没登录') > -1)
        }
      )
    })
    .then(() => {
      /* ---------- 6. 登录之后探测：列出入口 + 再往下摸一层 ---------- */
      console.log('\n[probe · 已登录]')
      reset()
      edu.saveCfg({ base: 'http://10.67.4.14', cookie: 'sid=abc' })
      ROUTES['/indexcs/simple.jsp'] = {
        body:
          '<html><title>学生首页</title>' +
          '<a href="/course/courseindex.jsp">我的课程</a>' +
          '<a href="/homework/list.jsp">作业列表</a>' +
          '<a href="/notice/list.jsp">通知</a></html>'
      }
      ROUTES['/course/courseindex.jsp'] = {
        body:
          '<html><title>我的课程</title><table>' +
          '<tr><td>数据结构</td></tr><tr><td>高等数学</td></tr></table></html>'
      }
      ROUTES['/homework/list.jsp'] = {
        body: '<html><title>作业</title><ul><li>实验一</li><li>实验二</li></ul></html>'
      }
      return edu.probe().then((lines) => {
        const text = lines.join('\n')
        truthy('列出学生首页链接', /学生首页[^：]*链接（3 个）/.test(text))
        truthy('抓到课程入口', /我的课程 → \/course\/courseindex\.jsp/.test(text))
        truthy('有入口体检段', /课程 \/ 作业入口体检/.test(text))
        truthy('课程页的表格行被数出来', /courseindex\.jsp[^]*?tr 2/.test(text))
        truthy('作业页的 li 被数出来', /homework\/list\.jsp[^]*?li 2/.test(text))
        truthy('不像作业的链接不去抓', !/notice\/list\.jsp → HTTP/.test(text))
      })
    })
    .then(() => {
      console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项')
      process.exit(fail ? 1 : 0)
    })
    .catch((e) => {
      console.log('\n✗ 测试异常：' + (e && e.stack))
      process.exit(1)
    })
})
