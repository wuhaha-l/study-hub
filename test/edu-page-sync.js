/**
 * 希冀「页面模式」同步：从课程页的表格里解析作业。
 *
 * 真机背景：这套 JSP 部署没有 JSON 接口（/api/courses/mine.json 之类全是 404），
 * 课程只能从首页链接认出来，作业只能从课程页的表格里读。这里用假服务器把
 * 两种情况都演一遍：
 *   1. 课程 40 的表格行有标题有截止时间 → 应该解析出任务
 *   2. 课程 115 的表格行没有截止时间 → 一条都不许编，并说明「没敢猜」
 *
 * 运行：node test/edu-page-sync.js
 */
const path = require('path')
const ROOT = path.join(__dirname, '..')

const store = {}
const requests = []

const HOME_HTML = `<!DOCTYPE html><html><head><title></title></head><body>
<a href="courselist.jsp?courseID=40">离散数学</a>
<a href="courselist.jsp?courseID=115">2025级高级语言程序设计实验（报告提交）</a>
<a href="courselist.jsp?courseID=124">认知实习</a>
</body></html>`

const COURSE_40 = `<!DOCTYPE html><html><head><title>离散数学</title></head><body>
<table class="list">
<tr><th>作业名称</th><th>截止时间</th><th>状态</th></tr>
<tr><td><a href="jobdetail.jsp?jobID=1001">第1章 命题逻辑</a></td><td>2026-11-01 23:59</td><td>未提交</td></tr>
<tr><td><a href="jobdetail.jsp?jobID=1002">实验一 真值表</a></td><td>2026/11/08 18:00</td><td>已提交</td></tr>
<tr><td><a href="jobdetail.jsp?jobID=1003">第2章 谓词逻辑</a></td><td>待定</td><td>未提交</td></tr>
</table></body></html>`

// 115 这一门：表格里有标题但没有日期 —— 一条都不该进任务列表
const COURSE_115 = `<!DOCTYPE html><html><head><title>高级语言程序设计实验</title></head><body>
<table class="list">
<tr><th>实验名称</th><th>操作</th></tr>
<tr><td><a href="jobdetail.jsp?jobID=2001">实验一 顺序结构</a></td><td>进入</td></tr>
<tr><td><a href="jobdetail.jsp?jobID=2002">实验二 分支结构</a></td><td>进入</td></tr>
</table></body></html>`

// 124 这一门用 <ul><li> 列表，不用表格：两种写法都得能解析
const COURSE_124 = `<!DOCTYPE html><html><head><title>认知实习</title></head><body>
<ul class="jobs">
<li><a href="jobdetail.jsp?jobID=3001">实习日志（一）</a><span>截止 2026-10-30 12:00</span></li>
<li><a href="jobdetail.jsp?jobID=3002">实习总结</a><span>截止 2026年12月20日</span></li>
</ul></body></html>`

global.wx = {
  getStorageSync(k) {
    return Object.prototype.hasOwnProperty.call(store, k) ? JSON.parse(JSON.stringify(store[k])) : ''
  },
  setStorageSync(k, v) {
    store[k] = JSON.parse(JSON.stringify(v))
  },
  removeStorageSync(k) {
    delete store[k]
  },
  request(opt) {
    const full = String(opt.url || '').replace(/^https?:\/\/[^/]+/, '')
    const p = full.split('?')[0]
    requests.push(full)
    const reply = (status, body) =>
      setTimeout(() => opt.success({ statusCode: status, data: body, header: {} }), 0)

    if (p === '/indexcs/simple.jsp' || p === '/') return reply(200, HOME_HTML)
    if (p === '/login/loginproc.jsp') return reply(200, '<html><input id="captchaCode"></html>')
    if (p === '/courselist.jsp') {
      if (/courseID=40/.test(full)) return reply(200, COURSE_40)
      if (/courseID=124/.test(full)) return reply(200, COURSE_124)
      return reply(200, COURSE_115)
    }
    return reply(404, 'Not Found')
  }
}

const edu = require(path.join(ROOT, 'miniprogram', 'utils', 'edu'))

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

async function main() {
  edu.saveCfg({ base: 'http://10.67.4.14', cookie: 'educg_session=SESS1A1B2C3', stid: '202515020339' })
  requests.length = 0

  const r = await edu.sync()
  console.log('轨迹：' + r.trace.join('；'))
  console.log('任务：' + JSON.stringify(r.tasks, null, 1).slice(0, 900))
  console.log('')

  console.log('[1] 有标题有日期的行被解析出来')
  ok('解析出 4 条（40 里第三条「待定」不编，剩 2；124 是 li 列表，2 条）', r.tasks.length === 4, r.tasks.map((t) => t.title))
  ok('标题对得上', r.tasks[0].title === '第1章 命题逻辑', r.tasks[0].title)
  ok('课程名带上了', r.tasks[0].courseName === '离散数学', r.tasks[0].courseName)

  const liTasks = r.tasks.filter((t) => t.courseName === '认知实习')
  ok('li 结构的页面也解析出来了', liTasks.length === 2, liTasks.map((t) => t.title))
  ok('中文日期「2026年12月20日」也认', liTasks[1] && new Date(liTasks[1].deadline).getMonth() === 11, liTasks[1] && liTasks[1].deadline)

  console.log('\n[2] 截止时间')
  const d = new Date(r.tasks[0].deadline)
  ok('第一条解析到 11 月 1 日 23:59', d.getMonth() === 10 && d.getDate() === 1 && d.getHours() === 23 && d.getMinutes() === 59, r.tasks[0].deadline)
  const d2 = new Date(r.tasks[1].deadline)
  ok('斜杠日期也认（2026/11/08 18:00）', d2.getMonth() === 10 && d2.getDate() === 8 && d2.getHours() === 18, r.tasks[1].deadline)

  console.log('\n[3] 状态与类型')
  ok('「已提交」判成 done', r.tasks[1].status === 'done', r.tasks[1].status)
  ok('没写已提交的是 todo', r.tasks[0].status === 'todo', r.tasks[0].status)
  ok('「实验一」判成 practice', r.tasks[1].taskType === 'practice', r.tasks[1].taskType)

  console.log('\n[4] 链接与去重键')
  ok(
    '作业链接是绝对地址（相对页面的拼法也没错）',
    r.tasks[0].url === 'http://10.67.4.14/jobdetail.jsp?jobID=1001',
    r.tasks[0].url
  )
  ok('externalId 稳定、能跨次去重', /^educoder:page:离散数学:第1章 命题逻辑$/.test(r.tasks[0].externalId), r.tasks[0].externalId)

  console.log('\n[4b] 学期：课程页没有开课时间时按当前学期记（否则首页默认只看本学期，会看不到）')
  ok('学期不是「未知」', r.tasks[0].semesterKey !== 'unknown', r.tasks[0].semesterKey)
  ok('学期短名有值', r.tasks[0].semesterShort !== '未知', r.tasks[0].semesterShort)

  console.log('\n[5] 没日期的课程：宁缺不猜')
  ok('115 的作业没被硬塞进来', !r.tasks.some((t) => /顺序结构|分支结构/.test(t.title)), r.tasks.map((t) => t.title))
  ok('轨迹里明说没敢猜', /没敢猜/.test(r.trace.join('；')), r.trace)

  console.log('\n[6] 只请求该请求的地址')
  ok(
    '课程页走的是 /courselist.jsp（不是 404 的 /indexcs/courselist.jsp）',
    requests.filter((u) => u.indexOf('/courselist.jsp?courseID=40') === 0).length >= 1,
    requests.filter((u) => /courselist/.test(u))
  )

  console.log('\n----------------------------------------')
  console.log('通过 ' + pass + '，失败 ' + fail)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('测试崩了：', e)
  process.exit(1)
})
