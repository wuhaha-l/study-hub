/* 教务系统（EAMS）课表解析测试
 *
 * 重点不是测网络（那要真账号 + 校园网），而是测「格子里的字能不能认干净」。
 * 样本照 EAMS 真实结构写：每个 td 一个 timetable_con，里面 title + festival + 地点。
 */
const path = require('path')
const E = require(path.join(__dirname, '..', 'localserver', 'eams'))

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

/* ---------------- 样本：标准版（复旦 EAMS 经典结构） ---------------- */

function cell(id, inner) {
  return '<td id="' + id + '" class="automatic" align="center" valign="middle">' + inner + '</td>'
}

function con(title, festival, rest) {
  return (
    '<div class="timetable_con text-left">' +
    '<span class="title" title="' + title + '">' + title + '</span>' +
    '<p class="festival">' + festival + '</p>' +
    (rest || '') +
    '</div>'
  )
}

const HTML_STD =
  '<html><body><table id="timetable" class="timetable">' +
  '<tr><td class="odd">1</td>' +
  cell('td_1_1', '') +
  cell('td_1_2', con('高等数学A(I)', '周二第1,2节{第1-16周}', '<p>张三</p><p>二教101</p>')) +
  cell('td_1_3', '') +
  cell('td_1_4', con('汇编语言', '周四第1,2节{第1-16周}', '<p>穆玲玲</p><p>松园3-201</p>')) +
  cell('td_1_5', '') + cell('td_1_6', '') + cell('td_1_7', '') +
  '</tr>' +
  '<tr><td class="odd">3</td>' +
  cell('td_3_1', '') +
  cell('td_3_2', '') +
  cell('td_3_3', con('大学英语', '周三第3,4节{第1-16周}(单)', '<p>李四</p><p>北3-105</p>')) +
  cell('td_3_4', '') +
  cell('td_3_5', con('数据结构', '周五第3,4节{第1-15周}', '<p>王五</p><p>松园2-301</p>')) +
  cell('td_3_6', '') + cell('td_3_7', '') +
  '</tr>' +
  '</table></body></html>'

console.log('[标准结构]')
const r1 = E.parseTableHtml(HTML_STD)
ok('认得 4 门', r1.length === 4, r1.length)

const cs = r1.find((x) => x.name === '高等数学A(I)')
ok('课程名 / 星期 / 节次', cs && cs.day === 2 && cs.start === 1 && cs.end === 2, cs)
ok('地点', cs && cs.place === '二教101', cs && cs.place)
ok('周次 1-16 每周', cs && cs.weeks && cs.weeks.from === 1 && cs.weeks.to === 16 && cs.weeks.parity === 0, cs && cs.weeks)

const eng = r1.find((x) => x.name === '大学英语')
ok('单周识别', eng && eng.weeks && eng.weeks.parity === 1, eng && eng.weeks)
ok('单周课地点', eng && eng.place === '北3-105', eng && eng.place)

const asm = r1.find((x) => x.name === '汇编语言')
ok('周四这节课也在', asm && asm.day === 4 && asm.start === 1, asm)

const ds = r1.find((x) => x.name === '数据结构')
ok('1-15 周', ds && ds.weeks && ds.weeks.to === 15, ds && ds.weeks)

ok('按星期排序', r1.map((x) => x.day).join(',') === '2,3,4,5', r1.map((x) => x.day))

/* ---------------- 样本：变体写法 ---------------- */

console.log('\n[变体写法]')

// ① 星期在文字里用「星期X」；② 节次用 3-4 而不是 3,4；③ 地点直接一行没前缀
const HTML_V1 =
  '<table><tr>' +
  cell('td_5_1', con('线性代数', '星期五 第5-6节 第1-16周', '<p>松园1-101</p>')) +
  cell('td_5_4', con('操作系统', '礼拜一第9,10节{第2-18周}', '<p>地点：松园4-502</p>')) +
  '</tr></table>'

const r2 = E.parseTableHtml(HTML_V1)
ok('变体共 2 门', r2.length === 2, r2)

const la = r2.find((x) => x.name === '线性代数')
ok('星期五 → day 5', la && la.day === 5, la)
ok('5-6 节', la && la.start === 5 && la.end === 6, la)
ok('无前缀地点也能抓', la && la.place === '松园1-101', la && la.place)

const os = r2.find((x) => x.name === '操作系统')
ok('礼拜一 → day 1', os && os.day === 1, os)
ok('9-10 节', os && os.start === 9 && os.end === 10, os)
ok('2-18 周', os && os.weeks && os.weeks.from === 2 && os.weeks.to === 18, os && os.weeks)
ok('「地点：」前缀被剥掉', os && os.place === '松园4-502', os && os.place)

/* ---------------- 一格两门课（不同周次） ---------------- */

console.log('\n[一格多课]')
const HTML_MULTI =
  '<table><tr>' +
  cell(
    'td_7_3',
    con('软件工程导论', '周三第7,8节{第1-8周}', '<p>松园2-201</p>') +
      con('专业英语', '周三第7,8节{第9-16周}', '<p>松园2-202</p>')
  ) +
  '</tr></table>'

const r3 = E.parseTableHtml(HTML_MULTI)
ok('一格拆成 2 门', r3.length === 2, r3)
ok('第一门第 1-8 周', r3[0] && r3[0].name === '软件工程导论' && r3[0].weeks.to === 8, r3[0])
ok('第二门第 9-16 周', r3[1] && r3[1].name === '专业英语' && r3[1].weeks.from === 9, r3[1])
ok('两门地点不串', r3[0].place === '松园2-201' && r3[1].place === '松园2-202', [r3[0].place, r3[1].place])

/* ---------------- 脏数据 ---------------- */

console.log('\n[脏数据]')
ok('空串 → []', E.parseTableHtml('').length === 0)
ok('null → []', E.parseTableHtml(null).length === 0)
ok('纯文字表格 → []', E.parseTableHtml('<table><tr><td>节次</td><td>星期一</td></tr></table>').length === 0)
ok('登录页 → []', E.parseTableHtml('<html><form><input name="password"></form></html>').length === 0)

/* ---------------- normalizeFestival ---------------- */

console.log('\n[时间串归一化]')
ok('第1,2节 → 第1-2节', E.normalizeFestival('第1,2节{第1-16周}') === '第1-2节 第1-16周', E.normalizeFestival('第1,2节{第1-16周}'))
ok('全角逗号', E.normalizeFestival('第3，4节') === '第3-4节', E.normalizeFestival('第3，4节'))
ok('已规范的不动', E.normalizeFestival('第5-6节') === '第5-6节', E.normalizeFestival('第5-6节'))

/* ---------------- JSON 课表（ws/schedule/table） ---------------- */

console.log('\n[JSON 课表]')
const json = {
  std: {
    activities: [
      {
        lessonId: 'L1',
        courseName: '离散数学',
        weekIndex: 3,
        startUnit: 1,
        endUnit: 2,
        room: '二教201',
        weeks: '1-16周'
      },
      {
        lessonId: 'L2',
        courseName: '计算机网络',
        weekIndex: 5,
        startUnit: 3,
        endUnit: 4,
        roomId: 88,
        weekBit: '1010101010101010'
      }
    ]
  },
  arragements: [{ id: 88, name: '松园3-301' }]
}
const r4 = E.parseWsJson(json)
ok('JSON 认得 2 门', r4.length === 2, r4)
ok('离散数学 周三 1-2 节', r4[0] && r4[0].name === '离散数学' && r4[0].day === 3 && r4[0].start === 1, r4[0])
ok('roomId 映射成名字', r4[1] && r4[1].place === '松园3-301', r4[1] && r4[1].place)
ok('weekBit 转周次文本', r4[1] && r4[1].weeks && r4[1].weeks.from === 1, r4[1] && r4[1].weeks)
ok('空 JSON → []', E.parseWsJson(null).length === 0 && E.parseWsJson({}).length === 0)

/* ---------------- 学期下拉 ---------------- */

console.log('\n[学期解析]')
const semHtml =
  '<select name="semester.id">' +
  '<option value="118">2026-2027学年秋季学期</option>' +
  '<option value="117" selected>2025-2026学年春季学期</option>' +
  '<option value="116">2025-2026学年秋季学期</option>' +
  '<option value="">请选择</option>' +
  '</select>'
const sem = E.parseSemesters(semHtml)
ok('捞出 3 个学期', sem.semesters.length === 3, sem.semesters.length)
ok('当前学期是选中的那个', sem.current && sem.current.id === '117', sem.current)
ok('「请选择」被过滤', !sem.semesters.some((x) => x.name === '请选择'), sem.semesters)

/* ---------------- studentId / 开学日 ---------------- */

console.log('\n[辅助字段]')
ok('从 ids= 里挖学号', E.findStudentId('<a href="/eams/courseTableForStd!courseTable.action?ids=202515020339">x</a>') === '202515020339')
ok('从 input 里挖学号', E.findStudentId('<input name="student.id" value="202515020339"/>') === '202515020339')
ok('挖不到给空串', E.findStudentId('<div>nothing</div>') === '')
ok('开学日 2026-09-07', E.findTermStart('<p>2026-09-07 开学</p>') === '2026-09-07', E.findTermStart('<p>2026-09-07 开学</p>'))
ok('月份补零', E.findTermStart('<p>2026-9-7 开学</p>') === '2026-09-07', E.findTermStart('<p>2026-9-7 开学</p>'))
ok('没有就是空串', E.findTermStart('<p>hi</p>') === '')

/* ---------------- 粘贴兜底 ---------------- */

console.log('\n[粘贴兜底]')
const r5 = E.parseText('周一 1-2节 高数 二教101 1-16周\n周三 5-6节 英语 北3-105')
ok('整段文本走共享解析器', r5.length === 2 && r5[0].name === '高数', r5)

/* ---------------- 登录页探测（离线，只看报错翻译） ---------------- */

console.log('\n[错误文案]')
const em = E._internal.errorMessageOf('<div class="errorMessage">用户名或密码错误，请重新输入</div>')
ok('抽得出「用户名或密码错误」', /用户名或密码错误/.test(em), em)
ok('没错误时返回空串', E._internal.errorMessageOf('<div>ok</div>') === '')

console.log('\n' + '─'.repeat(46))
console.log('通过 ' + pass + '，失败 ' + fail)
process.exit(fail ? 1 : 0)
