/**
 * 作业 / 考试列表解析测试。
 *
 * 用的都是 2026-10 真实页面里摘出来的结构（课程名和 id 已换掉），
 * 覆盖三种 id 写法、两种时间写法、以及各种状态值。
 */
const path = require('path')
const I = require(path.join(__dirname, '..', 'cloudfunctions/studyHub/adapters/chaoxing'))._internal

let pass = 0
let fail = 0
function eq(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
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

const course = { courseId: '111111', clazzId: '222222', name: '测试课程' }

/* ---------- 1. 作业：id 在 data 属性（汇编语言那种） ---------- */
console.log('\n[作业 · data 属性写法]')
const workData = `
<div class="ulDiv"><ul>
<li style="padding:30px 0">
  <div class="titTxt" data="0">
    <p class="clearfix" style="padding-top:11px;">
      <a href="javascript:void(0);" class="inspectTask" style="float: left" data="57451962"
         data2="0" data3="0" title="实验报告3 C语言程序的机器表示">
        实验报告3 C语言程序的机器 ...
      </a>
    </p>
    <span title="" class="pt5"><span class="fl">开始时间：</span>2026-10-23 19:39</span>
    <span title="" class="pt5"><span class="fl">截止时间：</span>2026-11-15 23:59</span>
    <span title="" class="pt5">
      <span class="fl">作业状态：</span>
      <strong>
        待做
      </strong>
    </span>
  </div>
</li>
<li style="padding:30px 0">
  <div class="titTxt" data="0">
    <p class="clearfix">
      <a href="javascript:void(0);" class="inspectTask" data="57320368" title="实验报告2 数据表示与存储">实验报告2 …</a>
    </p>
    <span class="pt5"><span class="fl">截止时间：</span>2026-11-15 23:59</span>
    <span class="pt5"><span class="fl">作业状态：</span><strong>待批阅</strong></span>
  </div>
</li>
</ul></div>`

const w1 = I.parseWorkListHtml(workData, course, 'work')
eq('解析出 2 条', w1.length, 2)
eq('标题取 title 属性（完整，不被省略号截断）', w1[0] && w1[0].title, '实验报告3 C语言程序的机器表示')
eq('workId 来自 data 属性', w1[0] && w1[0].externalId.indexOf('57451962') > -1, true)
eq('待做 → todo', w1[0] && w1[0].status, 'todo')
eq('待批阅 → done（已交）', w1[1] && w1[1].status, 'done')
truthy('截止时间解析出来了', w1[0] && w1[0].deadline > 0)
eq(
  '截止时间正确（2026-11-15 23:59）',
  w1[0] && new Date(w1[0].deadline).getMonth() + 1 + '-' + new Date(w1[0].deadline).getDate(),
  '11-15'
)
eq('作业类型', w1[0] && w1[0].taskType, 'homework')
truthy('做题链接带 workId', w1[0] && w1[0].url.indexOf('workId=57451962') > -1)

/* ---------- 2. 作业：id 在 href 里（园林艺术赏析那种） ---------- */
console.log('\n[作业 · href workId 写法]')
const workHref = `
<div class="ulDiv"><ul>
<li class="lookLi" style="padding:30px 0">
  <div class="titTxt" data="1">
    <p class="clearfix">
      <a href="/mooc-ans/work/selectWorkQuestionYiPiYue?courseId=111111&classId=222222&workId=52762044&workAnswerId=54820392&isdisplaytable=2&mooc=1&ut=s&enc=abc123&workSystem=0&cpi=999" title="结课论文" >
        结课论文
      </a>
    </p>
    <span class="pt5"><span class="fl">开始时间：</span>2026-04-23 08:33</span>
    <span class="pt5"><span class="fl">截止时间：</span>2026-06-01 22:22</span>
    <span class="pt5">
      <span class="fl">作业状态：</span>
      <strong>
        已完成
      </strong>
    </span>
  </div>
</li>
</ul></div>`

const w2 = I.parseWorkListHtml(workHref, course, 'work')
eq('解析出 1 条', w2.length, 1)
eq('workId 来自 href', w2[0] && w2[0].externalId.indexOf('52762044') > -1, true)
eq('已完成 → done', w2[0] && w2[0].status, 'done')
eq('链接用页面里真实的 href', w2[0] && w2[0].url.indexOf('selectWorkQuestionYiPiYue') > -1, true)

/* ---------- 3. 考试：考试时间 + 至 + 无 id ---------- */
console.log('\n[考试 · 考试时间区间]')
const examHtml = `
<div class="ulDiv" style="padding-top:10px;"><ul>
<li>
  <div class="titTxt" style="height:128px;">
    <p>
      <a href="javascript:void(0)" title="Quiz 3 ">Quiz 3 </a>
    </p>
    <span title="" class="pt5"><span class="fl">考试时间：</span>2026-10-28 10:10 至 2026-10-28 10:25</span>
    <span title="" class="pt5"><span class="fl">考试状态：</span>
      <strong>
        未开始
      </strong>
    </span>
  </div>
  <div class="titOper"><p><a class="aBtn bRed_1" href="#"></a></p></div>
</li>
<li class="lookLi">
  <div class="titTxt" style="height:128px;">
    <p><a href="javascript:void(0)" title="期中测试">期中测试</a></p>
    <span class="pt5"><span class="fl">考试时间：</span>2026-09-01 10:00 至 2026-09-01 10:30</span>
    <span class="pt5"><span class="fl">考试状态：</span><strong>已结束</strong></span>
  </div>
</li>
</ul></div>`

const e1 = I.parseWorkListHtml(examHtml, course, 'exam')
eq('解析出 2 场考试', e1.length, 2)
eq('标题尾部空格被清掉', e1[0] && e1[0].title, 'Quiz 3')
eq('未开始 → todo', e1[0] && e1[0].status, 'todo')
eq('已结束 → done', e1[1] && e1[1].status, 'done')
eq('考试类型', e1[0] && e1[0].taskType, 'exam')
eq(
  '截止时间取区间的结束时间（10-28），不是开始时间（10-28 也是同天，换个验证）',
  e1[0] && new Date(e1[0].deadline).getDate(),
  28
)
truthy('考试也有截止时间了', e1[0] && e1[0].deadline > 0)

/* ---------- 4. HTML 实体 ---------- */
console.log('\n[HTML 实体]')
const entHtml = `
<div class="titTxt">
  <p><a href="javascript:void(0)" class="inspectTask" data="12345" title="实验一&nbsp; 鲲鹏处理器 &amp; 汇编">实验一</a></p>
  <span class="pt5"><span class="fl">截止时间：</span>2026-11-05 23:59</span>
</div>`
const w3 = I.parseWorkListHtml(entHtml, course, 'work')
eq('&nbsp; 变空格、&amp; 变 &', w3[0] && w3[0].title, '实验一 鲲鹏处理器 & 汇编')

/* ---------- 5. 去重与噪声 ---------- */
console.log('\n[去重与噪声]')
const dupHtml = `
<div class="titTxt"><p><a data="999" title="同一个作业">x</a></p><span class="fl">截止时间：</span></span></div>
<div class="titTxt"><p><a data="999" title="同一个作业">x</a></p><span class="fl">截止时间：</span></span></div>`
eq('相同 id 只留一条', I.parseWorkListHtml(dupHtml, course, 'work').length, 1)

const noiseHtml = `<div class="titTxt"><p><a title="做作业">做作业</a></p></div>`
eq('按钮文字不算任务', I.parseWorkListHtml(noiseHtml, course, 'work').length, 0)

eq('空输入不报错', I.parseWorkListHtml('', course, 'work').length, 0)
eq('null 不报错', I.parseWorkListHtml(null, course, 'work').length, 0)
eq('没有 titTxt 的页面返回空', I.parseWorkListHtml('<html><body>暂无内容</body></html>', course, 'work').length, 0)

/* ---------- 6. 课程公共查询串 ---------- */
console.log('\n[courseQuery]')
const q = I.courseQuery(
  { courseId: '111', clazzId: '222', cpi: '333' },
  { enc: 'abc', openc: 'def' }
)
truthy('带 classId', q.indexOf('classId=222') > -1)
truthy('带 courseId', q.indexOf('courseId=111') > -1)
truthy('带 enc（关键，缺了会拿到通用模板）', q.indexOf('enc=abc') > -1)
truthy('带 cpi', q.indexOf('cpi=333') > -1)
truthy('带 openc', q.indexOf('openc=def') > -1)

const q2 = I.courseQuery({ courseId: '111', clazzId: '222', cpi: '333' }, { enc: 'abc' })
truthy('没有 openc 时不硬塞', q2.indexOf('openc=') === -1)

/* ---------- 7. 状态栏的各种包法（「交了却没变已完成」的元凶） ---------- */
console.log('\n[状态判定的各种写法]')
function statusOf(html) {
  const r = I.parseWorkListHtml(html, course, 'work')
  return r[0] && r[0].status
}
function row(inner) {
  return `<div class="titTxt"><p><a data="888" title="实验报告">实验报告</a></p>${inner}</div>`
}

eq(
  '状态包在 span 里 → done',
  statusOf(row('<span class="pt5"><span class="fl">作业状态：</span><span class="status">已完成</span></span>')),
  'done'
)
eq(
  '状态是纯文字、没有标签 → done',
  statusOf(row('<span class="pt5"><span class="fl">作业状态：</span> 待批阅 </span>')),
  'done'
)
eq(
  'strong 带 class → done',
  statusOf(row('<span class="pt5"><span class="fl">作业状态：</span><strong class="green">已提交</strong></span>')),
  'done'
)
eq(
  '改版后整行都没有状态栏，但写着「已完成」→ done',
  statusOf(row('<p class="clearfix"><span>已完成</span></p>')),
  'done'
)
eq(
  '未交 → todo',
  statusOf(row('<span class="pt5"><span class="fl">作业状态：</span><span class="status">未交</span></span>')),
  'todo'
)
eq(
  '未通过（含「通过」两个字）→ todo',
  statusOf(row('<span class="pt5"><span class="fl">作业状态：</span><span>未通过</span></span>')),
  'todo'
)
eq(
  '待重做 → todo',
  statusOf(row('<span class="pt5"><span class="fl">作业状态：</span><span>待重做</span></span>')),
  'todo'
)

/* ---------- 8. 抓取明细里的状态统计 ---------- */
console.log('\n[statusCount]')
eq('全待做', I.statusCount([{ status: 'todo' }, { status: 'todo' }]), '（待做 2）')
eq('全完成', I.statusCount([{ status: 'done' }]), '（已完成 1）')
eq('混合', I.statusCount([{ status: 'done' }, { status: 'todo' }]), '（已完成 1 / 待做 1）')
eq('空列表不写括号', I.statusCount([]), '')

/* ---------- 9. 诊断：把平台原文状态带回来 ---------- */
console.log('\n[workRows 诊断]')
const diagHtml = `
<div class="titTxt">
  <p><a data="777" title="已交的作业">已交的作业</a></p>
  <span class="pt5"><span class="fl">作业状态：</span><span class="status">待批阅</span></span>
</div>
<div class="titTxt">
  <p><a data="778" title="还没做的作业">还没做的作业</a></p>
  <span class="pt5"><span class="fl">作业状态：</span><strong>待做</strong></span>
</div>`
const rows = I.workRows(diagHtml, course)
eq('诊断抓两行', rows.length, 2)
eq('原文就是平台写的字', rows[0] && rows[0].raw, '待批阅')
eq('原文对应已完成', rows[0] && rows[0].status, 'done')
eq('待做仍是未完成', rows[1] && rows[1].status, 'todo')

/* ---------- 同一份作业被渲染两次：必须合并 ---------- */
console.log('\n[同一份作业出现在「未交」和「已交」两个区块]')
const twoBlockHtml = `
<div class="ulDiv"><ul>
<li>
  <div class="titTxt">
    <p><a href="javascript:void(0);" class="inspectTask" data="57451962" title="实验报告3 C语言程序的机器表示">实验报告3 …</a></p>
    <span class="pt5"><span class="fl">截止时间：</span>2026-11-15 23:59</span>
    <span class="pt5"><span class="fl">作业状态：</span><strong>待做</strong></span>
  </div>
</li>
<li>
  <div class="titTxt">
    <p><a href="/mooc-ans/work/selectWorkQuestionYiPiYue?workId=57451999" title="实验报告3 C语言程序的机器表示">实验报告3 …</a></p>
    <span class="pt5"><span class="fl">截止时间：</span>2026-11-15 23:59</span>
    <span class="pt5"><span class="fl">作业状态：</span><strong>待批阅</strong></span>
  </div>
</li>
</ul></div>`

const d1 = I.parseWorkListHtml(twoBlockHtml, course, 'work')
eq('合并成 1 条（不会同时挂着一条待做）', d1.length, 1)
eq('留下已完成那条', d1[0] && d1[0].status, 'done')
eq('标题还是那个作业', d1[0] && d1[0].title, '实验报告3 C语言程序的机器表示')
eq('链接指向已交作业（能点开看提交内容）', d1[0] && /selectWorkQuestionYiPiYue/.test(d1[0].url), true)

console.log('\n[dedupeWorks 本体]')
eq(
  '同名同截止：合一条，已完成优先',
  I.dedupeWorks([
    { courseId: 'c1', title: '实验一', deadline: 100, status: 'todo' },
    { courseId: 'c1', title: '实验一', deadline: 100, status: 'done' }
  ]).map((x) => x.status),
  ['done']
)
eq(
  '都未完成、截止时间差得远：两份真作业，不许合',
  I.dedupeWorks([
    { courseId: 'c1', title: '小测 1', deadline: 100, status: 'todo' },
    { courseId: 'c1', title: '小测 1', deadline: 100 + 2 * 86400000, status: 'todo' }
  ]).length,
  2
)
eq(
  '一盘交了、截止时间对不上：也要合（两个区块渲染的截止时间经常不一样）',
  I.dedupeWorks([
    { courseId: 'c1', title: '小测 1', deadline: 100, status: 'todo' },
    { courseId: 'c1', title: '小测 1', deadline: 100 + 10 * 86400000, status: 'done' }
  ]).map((x) => x.status),
  ['done']
)
eq(
  '三条分身（两待做 + 一已完成）：只留已完成',
  I.dedupeWorks([
    { courseId: 'c1', title: '实验报告3', deadline: 100, status: 'todo' },
    { courseId: 'c1', title: '实验报告3', deadline: 500, status: 'todo' },
    { courseId: 'c1', title: '实验报告3', deadline: 0, status: 'done' }
  ]).map((x) => x.status),
  ['done']
)
eq(
  '两条都没完成：保留先来的那条',
  I.dedupeWorks([
    { courseId: 'c1', title: '实验二', deadline: 0, status: 'todo', url: 'a' },
    { courseId: 'c1', title: '实验二', deadline: 0, status: 'todo', url: 'b' }
  ]).map((x) => x.url),
  ['a']
)
eq(
  '不同课程同名不算重复',
  I.dedupeWorks([
    { courseId: 'c1', title: '作业1', deadline: 0, status: 'todo' },
    { courseId: 'c2', title: '作业1', deadline: 0, status: 'done' }
  ]).length,
  2
)
eq(
  '一边没解析出截止时间：照样合并（否则永远合不进来）',
  I.dedupeWorks([
    { courseId: 'c1', title: '实验报告3', deadline: 0, status: 'todo' },
    { courseId: 'c1', title: '实验报告3', deadline: 100, status: 'done' }
  ]).map((x) => x.status),
  ['done']
)
eq(
  '标题里多几个空格也认得出是同一份',
  I.dedupeWorks([
    { courseId: 'c1', title: '实验报告3  C语言', deadline: 0, status: 'todo' },
    { courseId: 'c1', title: '实验报告3 C语言', deadline: 0, status: 'done' }
  ]).map((x) => x.status),
  ['done']
)

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项\n')
process.exit(fail ? 1 : 0)
