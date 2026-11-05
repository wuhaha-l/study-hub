/**
 * 三门课，但只同步到一门——另外两门在「课程列表页」里，得自己去找。
 *
 * 真机（2026-10-26 第五次探测）报的是：
 *   学生首页 = 外壳页（20852 字节，只有导航 + form /main.jsp），一个课程链接都没有
 *   tab=-2 在线作业（22623 字节）只列了当前课程 124 的 1 条作业
 *   tab=-1/-3/-4 各有内容（17317 / 16508 / 17175 字节）但认不出课程号也认不出作业号
 *   学生说「不对不对，有三门」——离散数学(40)、高级语言程序设计实验(115)、认知实习(124)
 *
 * 也就是说：课程清单既不在首页，也不在 tab=-1/-3/-4 的 `courseID=`/`<option>` 里，
 * 而是在一个专门的「课程列表页」（courselist.jsp）里，用普通 <a href> 列出。
 * 老代码摸到作业列表就收工、也只认 courseID=，所以另两门永远丢。
 *
 * 这里用一台「假希冀」还原：首页是壳，courselist.jsp（无参数）才是三门课的清单，
 * 每门课点进去是带 assignID 的作业表。要求：一次同步把三门课的作业全捞上来。
 *
 * 运行：node test/edu-three-courses.js
 */
const path = require('path')
const ROOT = path.join(__dirname, '..')

const store = {}
const requests = []

const SHELL = `<!DOCTYPE html><html><head><title>计算机类课程一体化平台</title></head><body>
<form name="top" action="/main.jsp" method="post" target="mainFrame"></form>
<div id="nav">首页 课程信息 在线作业 在线考试 在线答疑 模型</div>
<a href="/index.jsp"></a>
<a href="/gitlab/index.jsp">GitLab</a>
<a href="/includes/redirect.jsp?tab=-6">个人信息</a>
<script>var tabs=['tab=0','tab=-1','tab=-2','tab=-3','tab=-4']</script>
</body></html>`

// 课程列表页：三门课，普通 <a href>，courseID 在参数里
const COURSELIST = `<!DOCTYPE html><html><head><title>我的课程</title></head><body>
<table><tr><th>课程名称</th><th>操作</th></tr>
<tr><td>离散数学</td><td><a href="courselist.jsp?courseID=40">进入</a></td></tr>
<tr><td>2025级高级语言程序设计实验（报告提交）</td><td><a href="courselist.jsp?courseID=115">进入</a></td></tr>
<tr><td>2025级认知实习报告书</td><td><a href="courselist.jsp?courseID=124">进入</a></td></tr>
</table></body></html>`

const TAB_CUR = `<!DOCTYPE html><html><head><title>在线作业</title></head><body>
<table class="list">
<tr><th>作业名称</th><th>截止时间</th><th>操作</th></tr>
<tr><td>2025级认知实习报告书</td><td>2026-12-20 23:59</td>
<td><a href="index.jsp?courseID=124&assignID=802">进入作业</a></td></tr>
</table></body></html>`

const COURSE_PAGE = (id, rows) => `<!DOCTYPE html><html><head><title>课程</title></head><body>
<table class="list"><tr><th>作业名称</th><th>截止时间</th><th>操作</th></tr>
${rows}</table></body></html>`

const ROWS = {
  40: '<tr><td>第1章 命题逻辑</td><td>2026-11-01 23:59</td><td><a href="index.jsp?courseID=40&assignID=1001">进入作业</a></td></tr>',
  115: '<tr><td>实验一 顺序结构</td><td>2026-11-03 18:00</td><td><a href="index.jsp?courseID=115&assignID=2001">进入作业</a></td></tr>',
  124: '<tr><td>2025级认知实习报告书</td><td>2026-12-20 23:59</td><td><a href="index.jsp?courseID=124&assignID=802">进入作业</a></td></tr>'
}

const TAB_EMPTY = `<!DOCTYPE html><html><head><title>栏目</title></head><body>
<table><tr><th>标题</th></tr><tr><td>当前课程的课程信息</td></tr></table></body></html>`

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
    requests.push(full)
    const reply = (status, body) =>
      setTimeout(() => opt.success({ statusCode: status, data: body, header: {} }), 0)
    const [p, q] = full.split('?')
    const query = String(q || '')

    if (p === '/indexcs/simple.jsp' || p === '/' || p === '/index.jsp' || p === '/main.jsp' || p === '/indexcs/main.jsp' || p === '/indexcs/index.jsp') return reply(200, SHELL)
    if (p === '/courselist.jsp') {
      if (query.indexOf('courseID=40') > -1) return reply(200, COURSE_PAGE(40, ROWS[40]))
      if (query.indexOf('courseID=115') > -1) return reply(200, COURSE_PAGE(115, ROWS[115]))
      if (query.indexOf('courseID=124') > -1) return reply(200, COURSE_PAGE(124, ROWS[124]))
      return reply(200, COURSELIST)
    }
    if (p === '/indexcs/courselist.jsp') return reply(404, '<html>404</html>')
    if (p === '/includes/redirect.jsp') {
      if (query.indexOf('courseID=40') > -1) return reply(200, COURSE_PAGE(40, ROWS[40]))
      if (query.indexOf('courseID=115') > -1) return reply(200, COURSE_PAGE(115, ROWS[115]))
      if (query.indexOf('courseID=124') > -1) return reply(200, COURSE_PAGE(124, ROWS[124]))
      if (query.indexOf('tab=-2') > -1) return reply(200, TAB_CUR)
      return reply(200, TAB_EMPTY)
    }
    if (p === '/api/courses/mine.json') return reply(200, '<html>not json</html>')
    return reply(404, '<html>404</html>')
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
  console.log('任务：' + r.tasks.map((t) => t.title + '（' + (t.courseName || '?') + '）').join(' | '))
  console.log('')

  const byId = {}
  r.tasks.forEach((t) => {
    byId[t.externalId] = t
  })
  const ids = Object.keys(byId).map((x) => x.split(':').pop()).sort()
  ok('三门课的作业都在（802 + 1001 + 2001）', JSON.stringify(ids) === JSON.stringify(['1001', '2001', '802']), ids)
  ok('离散数学的作业名不错位', byId['educoder:assign:1001'] && byId['educoder:assign:1001'].courseName === '离散数学', byId['educoder:assign:1001'] && byId['educoder:assign:1001'].courseName)
  ok('高级语言程序设计实验不错位', byId['educoder:assign:2001'] && byId['educoder:assign:2001'].courseName === '2025级高级语言程序设计实验（报告提交）', byId['educoder:assign:2001'] && byId['educoder:assign:2001'].courseName)
  ok('认知实习的作业还在', byId['educoder:assign:802'] && byId['educoder:assign:802'].courseName === '2025级认知实习报告书')

  console.log('\n----------------------------------------')
  console.log('通过 ' + pass + '，失败 ' + fail)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('测试崩了：', e)
  process.exit(1)
})
