/**
 * 有的部署不理 `?courseID=`，只认「先打开切换页，服务端记住当前课程」。
 *
 * 真机上 `tab=-2` 由服务端按当前课程渲染，`&courseID=40` 到底灵不灵，各校版本不一样。
 * 这个测试的假服务器**故意忽略** courseID 参数，只有先请求
 * `/courselist.jsp?courseID=40` 才会把「当前课程」切过去——切完再读 tab=-2 才有别的课。
 *
 * 要求：
 *   1. 自己把「哪种切换写法有效」试出来（前面的写法 404 / 不生效都要跳过）
 *   2. 试出来之后锁定，后面的课程只按那一种走（别把 6 种写法重跑一遍）
 *   3. 两门课的作业都要上来
 *
 * 运行：node test/edu-multi-switch.js
 */
const path = require('path')
const ROOT = path.join(__dirname, '..')

const store = {}
const requests = []
let cur = 124

const SHELL = `<!DOCTYPE html><html><head><title>计算机类课程一体化平台</title></head><body>
<form name="top" action="/main.jsp" method="post" target="mainFrame"></form>
<div id="menu">首页 课程信息 在线作业 在线考试 在线答疑 模型</div>
<a href="/includes/redirect.jsp?tab=-2">在线作业</a>
</body></html>`

const page = (rows) => `<!DOCTYPE html><html><head><title>在线作业</title></head><body>
<table class="list"><tr><th>作业名称</th><th>截止时间</th><th>操作</th></tr>
${rows}
</table></body></html>`

const ROWS = {
  124: '<tr><td>2025级认知实习报告书</td><td>2026-12-20 23:59</td><td><a href="index.jsp?courseID=124&assignID=802">进入</a></td></tr>',
  40: '<tr><td>第1章 命题逻辑</td><td>2026-11-01 23:59</td><td><a href="index.jsp?courseID=40&assignID=1001">进入</a></td></tr>'
}

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

    if (p === '/indexcs/simple.jsp' || p === '/' || p === '/main.jsp') return reply(200, SHELL)
    if (p === '/includes/redirect.jsp') {
      // 关键：courseID 参数**没用**，只看服务端记着的「当前课程」
      if (query.indexOf('tab=-2') > -1) return reply(200, page(ROWS[cur] || ''))
      return reply(200, page(''))
    }
    // 唯一有效的切换写法：/courselist.jsp（/indexcs/ 下那个是 404，跟真机一样）
    if (p === '/courselist.jsp') {
      const m = /courseID=(\d+)/.exec(query)
      if (m && ROWS[m[1]]) cur = Number(m[1])
      return reply(200, page(ROWS[cur] || ''))
    }
    if (p === '/indexcs/courselist.jsp') return reply(404, '404 Not Found')
    if (p === '/indexcs/index.jsp') return reply(200, SHELL)
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

  const found = {
    courses: [
      { id: '40', name: '离散数学', href: '' },
      { id: '124', name: '2025级认知实习报告书', href: '' }
    ],
    lists: [{ label: 'tab=-2 在线作业', pagePath: '/includes/redirect.jsp', url: '/includes/redirect.jsp?tab=-2', html: page(ROWS[124]), assignCount: 1 }],
    nameById: { 40: '离散数学', 124: '2025级认知实习报告书' },
    options: [],
    docPath: '/includes/redirect.jsp',
    baseHref: ''
  }

  requests.length = 0
  const trace = []
  const pages = await edu.scanMore(found, trace, { maxMs: 20000 })

  console.log(trace.join('\n'))
  console.log('')

  const ids = []
  pages.forEach((p) => edu.assignRows(p.html).forEach((r) => ids.push(r.assignId)))
  ok('换了课程才拿到的那条也上来了', ids.indexOf('1001') > -1, ids)
  ok('切换换成 /courselist.jsp（试错试出来的）', requests.filter((u) => u.indexOf('/courselist.jsp?courseID=40') === 0).length >= 1, requests)
  ok('没把 6 种写法重跑一遍（切换页请求 ≤ 5 个）', requests.filter((u) => /switch|courselist|simple|main|index/.test(u) && /courseID=/.test(u)).length <= 5, requests)
  ok('拿到的页面打上了课程名', pages.some((p) => p.courseName === '离散数学'), pages.map((p) => p.courseName))

  console.log('\n----------------------------------------')
  console.log('通过 ' + pass + '，失败 ' + fail)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('测试崩了：', e)
  process.exit(1)
})
