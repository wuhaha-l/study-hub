/**
 * 列表页的截止时间写在锚的**兄弟节点**里——只解析 `<a>…</a>` 永远拿不到日期。
 *
 * 真机现象（2026-10-27）：直连同步写入 12 项，toast 显示「12 条还没截止时间」，
 * 一条都没有。原因是老逻辑在「锚列表」分支里只把锚本身交给 readAssignBlock，
 * 而这一版平台的列表长这样：
 *     <li><a href="index.jsp?courseID=40&assignID=861">序偶和关系</a>
 *         <span class="time">2026-12-20 23:59</span></li>
 * 日期在 <span> 里，锚里只有标题。
 *
 * 修法：把锚扩成「能装下它、且正好只有 1 条作业」的最大容器（containerOf），
 * 标题仍用锚自己的文字（hint），不会被状态/导航带偏。
 *
 * 运行：node test/edu-row-date.js
 */
const path = require('path')
const ROOT = path.join(__dirname, '..')

const store = {}
// 每个小节可以换一套「服务器」：默认什么都返回空页
let route = () => ({ statusCode: 200, data: '<html></html>' })

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
    const r = route(opt)
    setTimeout(() => opt.success({ statusCode: r.statusCode, data: r.data, header: {} }), 0)
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
    console.log('  ✗ ' + name + ' → ' + (extra === undefined ? '' : JSON.stringify(extra)))
  }
}

function main() {
  console.log('[1] <li> 里：锚 + 兄弟 span 写日期')
  const LI = `<!DOCTYPE html><html><body><ul>
<li><a href="index.jsp?courseID=40&assignID=861">序偶和关系</a><span class="time">2026-12-20 23:59</span></li>
<li><a href="index.jsp?courseID=40&assignID=858">命题逻辑</a><span class="time">2026-12-25 23:59</span></li>
</ul></body></html>`
  const li = edu.assignRows(LI)
  ok('两条都解析出来', li.length === 2, li.length)
  ok('第一条拿到截止时间', li[0].deadline > 0, li[0].deadline)
  ok('第二条拿到截止时间', li[1].deadline > 0, li[1].deadline)
  ok('标题还是锚文字（没混进日期）', li[0].title === '序偶和关系', li[0].title)
  ok('两条日期各自独立（没串行）', li[0].deadline !== li[1].deadline, [li[0].deadline, li[1].deadline])

  console.log('\n[2] 嵌套 div：日期在外层，锚在内层')
  const NEST = `<!DOCTYPE html><html><body><div class="list">
<div class="row"><div class="t"><a href="index.jsp?courseID=40&assignID=900">第一次作业</a></div><div class="d">2026-11-05 23:59</div></div>
<div class="row"><div class="t"><a href="index.jsp?courseID=40&assignID=901">第二次作业</a></div><div class="d">2026-11-12 23:59</div></div>
</div></body></html>`
  const ne = edu.assignRows(NEST)
  ok('两条都解析出来', ne.length === 2, ne.map((r) => r.assignId))
  ok('第一条拿到日期', ne[0].deadline > 0, ne[0].deadline)
  ok('标题是「第一次作业」', ne[0].title === '第一次作业', ne[0].title)
  ok('第二条拿到日期', ne[1].deadline > 0, ne[1].deadline)
  ok('两条日期不同（各自匹配到自己那行）', ne[0].deadline !== ne[1].deadline)

  console.log('\n[3] 日期只写在属性里（title / data-*）')
  const ATTR = `<!DOCTYPE html><html><body><ul>
<li><a href="index.jsp?courseID=40&assignID=861">序偶和关系</a><i title="截止时间：2026-12-20 23:59"></i></li>
<li><a href="index.jsp?courseID=40&assignID=858">命题逻辑</a><i title="截止时间：2026-12-21 23:59"></i></li>
</ul></body></html>`
  const at = edu.assignRows(ATTR)
  ok('属性里的日期也读到了', at[0].deadline > 0, at[0].deadline)
  ok('标题没被属性污染', at[0].title === '序偶和关系', at[0].title)

  console.log('\n[4] 没年份的月日也认（列表页常见写法）')
  const SHORT = `<!DOCTYPE html><html><body><ul>
<li><a href="index.jsp?courseID=40&assignID=861">序偶和关系</a><span>12-20 23:59</span></li>
<li><a href="index.jsp?courseID=40&assignID=858">命题逻辑</a><span>12-25 23:59</span></li>
</ul></body></html>`
  const st = edu.assignRows(SHORT)
  ok('月日无年份也能补上', st[0].deadline > 0, st[0].deadline)
  const d0 = new Date(st[0].deadline)
  ok('补的是 12 月 20 日', d0.getMonth() === 11 && d0.getDate() === 20, d0.toString())

  console.log('\n[5] 状态在兄弟节点：已提交')
  const DONE = `<!DOCTYPE html><html><body><ul>
<li><a href="index.jsp?courseID=40&assignID=861">序偶和关系</a><span>2026-12-20 23:59</span><span>已提交</span></li>
<li><a href="index.jsp?courseID=40&assignID=858">命题逻辑</a><span>2026-12-25 23:59</span><span>未提交</span></li>
</ul></body></html>`
  const dn = edu.assignRows(DONE)
  ok('已提交那条 done=true', dn[0].done === true, dn[0].done)
  ok('未提交那条 done=false', dn[1].done === false, dn[1].done)

  console.log('\n[6] 没有任何容器信息时，行为与以前一致（不瞎编日期）')
  const BARE = `<!DOCTYPE html><html><body>
<a href="index.jsp?courseID=40&assignID=861">序偶和关系</a>
<a href="index.jsp?courseID=40&assignID=858">命题逻辑</a>
</body></html>`
  const br = edu.assignRows(BARE)
  ok('仍然解析出 2 条', br.length === 2, br.length)
  ok('没有日期就是 0，不猜', br.every((r) => r.deadline === 0), br.map((r) => r.deadline))
  ok('标题正常', br[0].title === '序偶和关系', br[0].title)

  console.log('\n[7] containerOf 只收「正好 1 条作业」的容器')
  const TWO = `<div class="row"><a href="index.jsp?assignID=861">A</a><span>2026-12-20</span>
<a href="index.jsp?assignID=858">B</a><span>2026-12-25</span></div>`
  const seg = edu.containerOf(TWO, TWO.indexOf('<a'), 40)
  ok('装了两条作业的容器不算（返回空）', seg === '', seg.slice(0, 60))
  const ONE = `<div class="row"><a href="index.jsp?assignID=861">A</a><span>2026-12-20</span></div>`
  ok('只有一条作业的容器收下', /assignID=861/.test(edu.containerOf(ONE, ONE.indexOf('<a'), 40)))

  console.log('\n[8] rowProbe：诊断串里能看到首行原文')
  const probe = edu.rowProbe(LI)
  ok('说了容器多少字', /容器 \d+ 字/.test(probe), probe.slice(0, 60))
  ok('带上了锚原文', probe.indexOf('序偶和关系') > -1)
  ok('带上了容器原文（能看见日期）', probe.indexOf('2026-12-20') > -1)
  ok('说明了是否在 tr 内', /在 tr 内：否/.test(probe))
  // 没有容器可扩时，要能看到锚**前后**的原文（日期可能就写在旁边）
  const bareProbe = edu.rowProbe(`<body><a href="index.jsp?courseID=40&assignID=861">序偶</a> 2026-12-20 23:59 未提交</body>`)
  ok('没有容器时改看锚前后原文', bareProbe.indexOf('锚前后原文') > -1, bareProbe.slice(0, 80))

  console.log('\n[9] 表格结构照旧（锚在 tr 里，走 tr 分支）')
  const TABLE = `<!DOCTYPE html><html><body><table>
<tr><th>作业</th><th>截止</th><th>状态</th></tr>
<tr><td><a href="index.jsp?courseID=124&assignID=802">2025级认知实习报告书</a></td><td>2026-12-20 23:59</td><td>未提交</td></tr>
<tr><td><a href="index.jsp?courseID=124&assignID=803">实习总结</a></td><td>2026-12-21 23:59</td><td>已提交</td></tr>
</table></body></html>`
  const tb = edu.assignRows(TABLE)
  ok('表格 2 条', tb.length === 2, tb.length)
  ok('表格行日期没丢', tb[0].deadline > 0, tb[0].deadline)
  ok('表格行标题没变（不是「进入作业」）', tb[0].title.indexOf('认知实习') > -1, tb[0].title)

  console.log('\n[10] 详情页相对地址拼歪时，换根路径再试一次')
  edu.saveCfg({ base: 'http://10.0.0.1:8080', cookie: 'JSESSIONID=abc' })
  const tried = []
  route = (opt) => {
    const u = String(opt.url || '').replace(/^https?:\/\/[^/]+/, '')
    tried.push(u)
    // /includes/index.jsp 是拼歪的地址（真机上就是个外壳/404）
    if (u.indexOf('/includes/index.jsp') === 0) return { statusCode: 404, data: 'not found' }
    if (u.indexOf('/index.jsp') === 0) {
      return { statusCode: 200, data: '<div>提交截止时间：2026-12-20 23:59</div>' }
    }
    return { statusCode: 200, data: '<html></html>' }
  }
  const t = {
    externalId: 'educoder:assign:861',
    courseId: '40',
    deadline: 0,
    url: 'http://10.0.0.1:8080/includes/index.jsp?courseID=40&assignID=861'
  }
  const tr2 = []
  return edu.fillDeadlines([t], tr2).then((got) => {
    ok('换了根路径后补到日期', got === 1 && t.deadline > 0, { got, deadline: t.deadline })
    ok('确实去试了根路径', tried.some((u) => u.indexOf('/index.jsp') === 0), tried)
    ok('补上后地址换成能用的那个', t.url.indexOf('/includes/') < 0, t.url)

    route = () => ({ statusCode: 200, data: '<html></html>' })
    const t2 = {
      externalId: 'educore:assign:999',
      courseId: '40',
      deadline: 0,
      url: 'http://10.0.0.1:8080/includes/index.jsp?courseID=40&assignID=999'
    }
    return edu.fillDeadlines([t2], []).then((g2) => {
      ok('两边都拿不到就保持 0，不编造', g2 === 0 && t2.deadline === 0, { g2, d: t2.deadline })

      console.log('\n[11] 详情页是外壳页时：试几种写法就收手，不拿 12 条空跑')
      const SHELL = '<html><body><iframe name="mainFrame" src=""></iframe>' + 'x'.repeat(20000) + '</body></html>'
      const hits = []
      route = (opt) => {
        hits.push(String(opt.url || ''))
        return { statusCode: 200, data: SHELL }
      }
      const many = []
      for (let i = 0; i < 12; i++) {
        many.push({
          externalId: 'educoder:assign:' + (860 + i),
          courseId: '40',
          deadline: 0,
          url: 'http://10.0.0.1:8080/index.jsp?courseID=40&assignID=' + (860 + i)
        })
      }
      const trail = []
      return edu.fillDeadlines(many, trail).then((g3) => {
        ok('一条都没补到', g3 === 0, g3)
        // 探路最多 7 次（6 种写法，其中「先点作业再读列表页」要两次请求）；
        // 12 条若挨个发请求就会是几十次
        ok('只探路，不给每条都发请求（≤9 次）', hits.length <= 9, hits.length)
        ok('轨迹里说明了试过几种地址', /种详情页写法都没绑上/.test(trail.join('；')), trail)
        ok('识别出外壳页', /外壳页/.test(trail.join('；')), trail.filter((x) => /外壳/.test(x)))
        done()
      })
    })
  })
}

function done() {
  console.log('\n----------------------------------------')
  console.log('通过 ' + pass + '，失败 ' + fail)
  process.exit(fail ? 1 : 0)
}

main()
