/**
 * 「同步成功，但只来了一条」——其他的作业在别的课程里。
 *
 * 真机（2026-10-26）报的是：登录正常、会话正常，同步下来只有「2025级认知实习报告书」
 * 这一条，学生本人说「预期是对的，但少其他的」。
 *
 * 原因是这套 JSP 平台的 `/includes/redirect.jsp?tab=-2` 由服务端按**当前课程**渲染，
 * 一次只列一门课；课程清单在别处（下拉框 / 课程链接），谁都没读过其他课程。
 *
 * 这个测试用一台「假希冀」还原现场：
 *   · 首页只有课程下拉框（`<option value="40">离散数学</option>`），一个 `<a>` 都没有
 *   · 不带 courseID 的 tab=-2 只给课程 124 的 802
 *   · 带 courseID=40 / 115 才给另外两门课的作业
 *   · 课程 40 还有「下一页」
 * 要求：一次同步把 5 条全捞上来，且课程名不错位、同一页不重复读。
 *
 * 运行：node test/edu-multi-course.js
 */
const path = require('path')
const ROOT = path.join(__dirname, '..')

const store = {}
const requests = []

const SHELL = `<!DOCTYPE html><html><head><title>计算机类课程一体化平台</title></head><body>
<form name="top" action="/main.jsp" method="post" target="mainFrame"></form>
<div id="nav">首页 课程信息 在线作业 在线考试 在线答疑</div>
<select name="courseID" onchange="go(this.value)">
<option value="40">离散数学</option>
<option value="115">2025级高级语言程序设计实验</option>
<option value="124" selected>2025级认知实习报告书</option>
</select>
<script>function go(v){location.href='/includes/redirect.jsp?tab=-2&courseID='+v}</script>
</body></html>`

const TAB_CUR = `<!DOCTYPE html><html><head><title>在线作业</title></head><body>
<table class="list">
<tr><th>作业名称</th><th>截止时间</th><th>操作</th></tr>
<tr><td class="n">2025级认知实习报告书</td><td>2026-12-20 23:59</td>
<td><a href="index.jsp?courseID=124&assignID=802">进入作业</a></td></tr>
</table></body></html>`

const TAB_40 = `<!DOCTYPE html><html><head><title>在线作业</title></head><body>
<table class="list">
<tr><th>作业名称</th><th>截止时间</th><th>操作</th></tr>
<tr><td class="n">第1章 命题逻辑</td><td>2026-11-01 23:59</td>
<td><a href="index.jsp?courseID=40&assignID=1001">进入作业</a></td></tr>
<tr><td class="n">第2章 谓词逻辑</td><td>2026-11-08 23:59</td>
<td><a href="index.jsp?courseID=40&assignID=1002">进入作业</a></td></tr>
</table>
<div class="pager"><a href="redirect.jsp?tab=-2&courseID=40&pageNo=2">下一页</a></div>
</body></html>`

const TAB_40_P2 = `<!DOCTYPE html><html><head><title>在线作业</title></head><body>
<table class="list">
<tr><th>作业名称</th><th>截止时间</th><th>操作</th></tr>
<tr><td class="n">第3章 集合论</td><td>2026-11-15 23:59</td>
<td><a href="index.jsp?courseID=40&assignID=1003">进入作业</a></td></tr>
</table></body></html>`

const TAB_115 = `<!DOCTYPE html><html><head><title>在线作业</title></head><body>
<table class="list">
<tr><th>作业名称</th><th>截止时间</th><th>操作</th></tr>
<tr><td class="n">实验一 顺序结构</td><td>2026-11-03 18:00</td>
<td><a href="index.jsp?courseID=115&assignID=2001">进入作业</a></td></tr>
</table></body></html>`

const EMPTY = `<!DOCTYPE html><html><head><title>在线答疑</title></head><body>
<table><tr><th>标题</th></tr><tr><td>暂无内容</td></tr></table></body></html>`

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

    if (p === '/indexcs/simple.jsp' || p === '/') return reply(200, SHELL)
    if (p === '/main.jsp') return reply(200, SHELL)
    if (p === '/includes/redirect.jsp') {
      if (query.indexOf('courseID=40') > -1) {
        return reply(200, query.indexOf('pageNo=2') > -1 ? TAB_40_P2 : TAB_40)
      }
      if (query.indexOf('courseID=115') > -1) return reply(200, TAB_115)
      if (query.indexOf('tab=-2') > -1) return reply(200, TAB_CUR)
      return reply(200, EMPTY)
    }
    if (p === '/api/courses/mine.json') return reply(200, '<html><body>not json</body></html>')
    // 课程页 / 详情页在这套平台上是 JS 外壳，这里直接当不存在
    return reply(404, '<html><body>404</body></html>')
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
  console.log('[1] 纯函数')
  ok(
    '下拉框里的课程就是课程清单',
    JSON.stringify(edu.optionRefs(SHELL).map((x) => x.id + ':' + x.name)) ===
      JSON.stringify(['40:离散数学', '115:2025级高级语言程序设计实验', '124:2025级认知实习报告书']),
    edu.optionRefs(SHELL)
  )
  ok('「下一页」认得出来', edu.nextPagePaths(TAB_40, '/includes/redirect.jsp')[0] === '/includes/redirect.jsp?tab=-2&courseID=40&pageNo=2', edu.nextPagePaths(TAB_40, '/includes/redirect.jsp'))
  ok('作业号指纹按集合算（顺序无关）', edu.assignKey(TAB_40) === '1001,1002', edu.assignKey(TAB_40))
  ok('没有作业号 → 空指纹', edu.assignKey(EMPTY) === '')
  // 真机「切换课程」是 <span value> 下拉菜单项，不是 <option>（2026-10-26 探测实锤）
  const SPAN_DROP = `<div class="dropdown-menu"><span class='dropdown-item dropdown-item-course ' value="40">离散数学</span><span class='dropdown-item dropdown-item-course ' value="115">2025级高级语言程序设计实验（报告提交）</span></div>`
  ok(
    'span 下拉菜单项也能认出课程号',
    JSON.stringify(edu.optionRefs(SPAN_DROP).map((x) => x.id + ':' + x.name)) ===
      JSON.stringify(['40:离散数学', '115:2025级高级语言程序设计实验（报告提交）']),
    edu.optionRefs(SPAN_DROP)
  )

  console.log('\n[2] 一次同步把其他课程也捞上来')
  edu.saveCfg({ base: 'http://10.67.4.14', cookie: 'educg_session=SESS1A1B2C3', stid: '202515020339' })
  requests.length = 0

  const r = await edu.sync()
  const byId = {}
  r.tasks.forEach((t) => {
    byId[t.externalId] = t
  })
  const ids = Object.keys(byId).map((x) => x.split(':').pop()).sort()
  ok('5 条全在（124 一条 + 40 两页三条 + 115 一条）', JSON.stringify(ids) === JSON.stringify(['1001', '1002', '1003', '2001', '802']), ids)
  ok('课程 40 的作业名是「离散数学」', byId['educoder:assign:1001'].courseName === '离散数学', byId['educoder:assign:1001'] && byId['educoder:assign:1001'].courseName)
  ok('课程 115 的作业名不错位', byId['educoder:assign:2001'].courseName === '2025级高级语言程序设计实验', byId['educoder:assign:2001'].courseName)
  ok('课程 124 的作业名照旧', byId['educoder:assign:802'].courseName === '2025级认知实习报告书', byId['educoder:assign:802'].courseName)
  ok('截止时间解析到了', byId['educoder:assign:2001'].deadline > 0)
  ok('任务都打了当前学期（否则首页默认看不到）', !!byId['educoder:assign:1002'].semesterKey)

  console.log('\n[3] 别把请求烧光')
  ok(
    '不带参数的 tab=-2 只读一次',
    requests.filter((u) => /redirect\.jsp\?tab=-2$/.test(u)).length === 1,
    requests.filter((u) => /tab=-2/.test(u))
  )
  ok('课程 124（当前课程）没被重复读', requests.filter((u) => /courseID=124/.test(u)).length === 0, requests.filter((u) => /courseID=124/.test(u)))
  ok('翻页只多读一页', requests.filter((u) => /pageNo=2/.test(u)).length === 1)

  console.log('\n----------------------------------------')
  console.log('通过 ' + pass + '，失败 ' + fail)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('测试崩了：', e)
  process.exit(1)
})
