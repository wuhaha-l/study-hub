/* 课表解析测试 */
const S = require('../miniprogram/utils/schedule')

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (extra ? ' → ' + JSON.stringify(extra) : ''))
  }
}

console.log('[单行解析]')
const a = S.parseLine('周一 1-2节 汇编语言 松园3-201')
ok('空格分隔', a && a.day === 1 && a.start === 1 && a.end === 2 && a.name === '汇编语言' && a.place === '松园3-201', a)

const b = S.parseLine('星期二,第3-4节,大学英语,北3-105')
ok('逗号分隔 + 第X-Y节', b && b.day === 2 && b.start === 3 && b.end === 4 && b.name === '大学英语', b)

const c = S.parseLine('礼拜三 5-6 数据结构@松园2-301')
ok('@ 分隔地点', c && c.day === 3 && c.start === 5 && c.place === '松园2-301' && c.name === '数据结构', c)

const d = S.parseLine('四 7-8节 软件工程导论')
ok('单字星期 + 无地点', d && d.day === 4 && d.name === '软件工程导论' && d.place === '', d)

const e = S.parseLine('周日 第9节 班会')
ok('单节次', e && e.day === 7 && e.start === 9 && e.end === 9, e)

const f = S.parseLine('周五 1~2 大学物理A(I) 松园3-201')
ok('~ 连接符', f && f.start === 1 && f.end === 2 && f.name === '大学物理A(I)', f)

ok('无星期返回 null', S.parseLine('第一章 绪论') === null)
ok('分组标题被丢弃', S.parseLine('周一 上午') === null || S.parseLine('周一 上午').name !== '上午')

console.log('\n[整段解析]')
const text = [
  '课程表',
  '周一 1-2节 汇编语言 松园3-201',
  '周一 3-4节 大学英语',
  '周二 5-6节 数据结构@松园2-301',
  '',
  '周三 1-2节 汇编语言 松园3-201',
  '随便写的一行'
].join('\n')
const r = S.parseText(text)
ok('解析出 4 条', r.items.length === 4, r.items.length)
ok('统计噪声行', r.skipped >= 2, r.skipped)
ok('按星期+节次排序', r.items[0].day === 1 && r.items[0].start === 1, r.items[0])

const dup = S.parseText('周一 1-2 汇编语言\n周一 1-2 汇编语言')
ok('重复行去掉', dup.items.length === 1, dup.items.length)

console.log('\n[分组与今日]')
const g = S.groupByDay(r.items)
ok('固定 7 天', g.length === 7)
ok('周一 2 条', g[0].items.length === 2, g[0].items.length)

// 2026-10-24 是周六
const t = S.todayInfo(r.items, new Date(2026, 9, 24, 9, 0))
ok('周六是 day 6', t.day === 6, t.day)
const t2 = S.todayInfo(r.items, new Date(2026, 9, 26, 8, 30)) // 周一 08:30
ok('周一 8:30 正在上 1-2 节', t2.current && t2.current.start === 1, t2.current)
const t3 = S.todayInfo(r.items, new Date(2026, 9, 26, 9, 50))
ok('周一 9:50 下一节是 3-4 节', t3.next && t3.next.start === 3, t3.next)


console.log('\n[周次与单双周]')
const w1 = S.parseWeeks('1-16周')
ok('1-16周', w1 && w1.from === 1 && w1.to === 16 && w1.parity === 0, w1)
const w2 = S.parseWeeks('第1-16周(单)')
ok('第1-16周(单)', w2 && w2.parity === 1, w2)
const w3 = S.parseWeeks('双周')
ok('双周', w3 && w3.parity === 2 && w3.from === 1, w3)
const w4 = S.parseWeeks('3周')
ok('单周次 3周', w4 && w4.from === 3 && w4.to === 3, w4)
ok('没有周次返回 null', S.parseWeeks('汇编语言 松园3-201') === null)

const lineW = S.parseLine('周一 1-2节 大学英语 北3-105 1-16周(单)')
ok('行内单双周不污染地点', lineW && lineW.place === '北3-105' && lineW.name === '大学英语', lineW)
ok('单周 3 在范围内', S.inWeek(lineW, 3) === true)
ok('单周 4 不在范围内', S.inWeek(lineW, 4) === false)

const lineW2 = S.parseLine('周三 7-8节 软件工程 1-8周')
ok('第 9 周超出 1-8 周', S.inWeek(lineW2, 9) === false, lineW2)
ok('无周次信息默认每周都算', S.inWeek(S.parseLine('周四 1-2节 体育'), 12) === true)

console.log('\n[教务精确周次列表]')
// 教务导下来的散点周（实验课第 4、6、8 周各一次）
const lab = { day: 3, start: 5, end: 6, name: '大学物理实验', place: '物理实验大楼305', weeks: { from: 4, to: 8, list: [4, 6, 8], parity: 0 } }
ok('散点周：第 5 周不上（以前范围算法会误显示）', S.inWeek(lab, 5) === false)
ok('散点周：第 4 周上', S.inWeek(lab, 4) === true)
ok('散点周：第 6 周上', S.inWeek(lab, 6) === true)
ok('散点周：第 9 周不上', S.inWeek(lab, 9) === false)
ok('散点周显示成 4-8周(双)（全偶数等价于双周）', S.weeksText(lab.weeks) === '4-8周(双)', S.weeksText(lab.weeks))
// 奇偶混合的散点（连续段压缩路径）
const mixScatter = { day: 3, start: 1, end: 2, name: '实验', weeks: { from: 4, to: 9, list: [4, 7, 9], parity: 0 } }
ok('混合散点：第 5 周不上', S.inWeek(mixScatter, 5) === false)
ok('混合散点：第 7 周上', S.inWeek(mixScatter, 7) === true)
ok('混合散点显示成 4、7、9周', S.weeksText(mixScatter.weeks) === '4、7、9周', S.weeksText(mixScatter.weeks))
// 体育课只在单周
const pe = { day: 1, start: 7, end: 8, name: '体育', weeks: { from: 2, to: 17, list: [2, 4, 6, 8, 10, 12, 14, 16], parity: 2 } }
ok('纯双周列表：第 3 周不上', S.inWeek(pe, 3) === false)
ok('纯双周列表：第 4 周上', S.inWeek(pe, 4) === true)
ok('纯双周显示成 2-16周(双)', S.weeksText(pe.weeks) === '2-16周(双)', S.weeksText(pe.weeks))
// 连续段压缩
const mix = { from: 1, to: 10, list: [1, 2, 3, 5, 8, 9, 10], parity: 0 }
ok('连续段压缩成 1-3、5、8-10周', S.weeksText(mix) === '1-3、5、8-10周', S.weeksText(mix))
ok('老数据（只有 from/to/parity）不受影响', S.inWeek({ weeks: { from: 1, to: 16, parity: 1 } }, 3) === true)
ok('老数据双周不误显示', S.inWeek({ weeks: { from: 1, to: 16, parity: 2 } }, 3) === false)
ok('list 存在时优先于 from/to', S.inWeek({ weeks: { from: 1, to: 20, list: [7] } }, 7) === true)
ok('list 存在时 from/to 再宽也不算', S.inWeek({ weeks: { from: 1, to: 20, list: [7] } }, 8) === false)

console.log('\n[学期周次]')
const term = new Date(2026, 8, 7) // 2026-09-07 周一
ok('开学当周是第 1 周', S.weekNoOf(new Date(2026, 8, 7, 9, 0), term) === 1)
ok('9-13 也是第 1 周', S.weekNoOf(new Date(2026, 8, 13, 9, 0), term) === 1)
ok('9-14 是第 2 周', S.weekNoOf(new Date(2026, 8, 14, 9, 0), term) === 2)
ok('10-24 是第 7 周', S.weekNoOf(new Date(2026, 9, 24), term) === 7)
ok('周日归到当周', S.weekNoOf(new Date(2026, 8, 13), term) === 1)

console.log('\n[网格]')
const gItems = S.parseText([
  '周一 1-2节 汇编语言 松园3-201 1-16周',
  '周一 3-4节 大学英语 北3-105 1-16周(单)',
  '周二 5-6 数据结构@松园2-301 1-8周',
  '周三 7-8节 软件工程 双周',
  '周四 9-10节 大学物理A(I) 松园3-201'
].join('\n')).items
const gr = S.gridOf(gItems, 7, { termStart: term, now: new Date(2026, 9, 24, 10, 0) })
ok('当前周标记', gr.weekNo === 7 && gr.isThisWeek === true, { w: gr.weekNo })
ok('最少 10 节行', gr.maxPeriod === 10, gr.maxPeriod)
ok('体总高 = 行数 × 行高', gr.bodyH === gr.maxPeriod * gr.rowH, gr.bodyH)
ok('7 列', gr.days.length === 7)
ok('今天高亮（周六）', gr.days[5].isToday === true && gr.days[0].isToday === false)
ok('第 7 周是单周，单周课照常上', gr.days[0].items.length === 2, gr.days[0].items.map((x) => x.name))
ok('双周课第 7 周不出现', gr.days[2].items.length === 0, gr.days[2].items)
ok('块 top = (起始节-1)×行高', gr.days[0].items[0].top === 0)
ok('两节块高 = 2 行 - 间隙', gr.days[0].items[0].height === 54 * 2 - 4, gr.days[0].items[0].height)
const gr8 = S.gridOf(gItems, 8, { termStart: term, now: new Date(2026, 9, 24, 10, 0) })
ok('第 8 周是双周，单周课消失', gr8.days[0].items.length === 1, gr8.days[0].items.map((x) => x.name))
ok('第 8 周双周课出现', gr8.days[2].items.length === 1, gr8.days[2].items.map((x) => x.name))
ok('第 8 周已过 1-8 周仍在上（含第 8 周）', gr8.days[1].items.length === 1)
const gr9 = S.gridOf(gItems, 9, { termStart: term, now: new Date(2026, 9, 24, 10, 0) })
ok('第 9 周 1-8 周的课消失', gr9.days[1].items.length === 0, gr9.days[1].items)

console.log('\n[教务数据 → 本机合并 → 网格 全链路]')
// 复现物理实验的真实排法：不同实验在不同周、不同时间位
global.wx = {
  _s: {},
  getStorageSync(k) {
    return this._s[k]
  },
  setStorageSync(k, v) {
    this._s[k] = v
  }
}
const Z = require('../cloudfunctions/studyHub/lib/zzu.js')
const TT = require('../miniprogram/utils/timetable')

const e2eTable = {
  result: 0,
  data: [
    {
      course: { nameZh: '大学物理实验(2)' },
      schedules: [
        { date: '2026-09-30', weekday: 3, startUnit: 5, endUnit: 6, weekIndex: 4, room: { nameZh: '物理实验大楼305' } },
        { date: '2026-10-15', weekday: 4, startUnit: 5, endUnit: 6, weekIndex: 6, room: { nameZh: '物理实验大楼305' } },
        { date: '2026-10-31', weekday: 6, startUnit: 5, endUnit: 6, weekIndex: 8, room: { nameZh: '物理实验大楼210' } },
        { date: '2026-11-11', weekday: 3, startUnit: 5, endUnit: 6, weekIndex: 10, room: { nameZh: '物理实验大楼305' } }
      ]
    },
    {
      course: { nameZh: '概率论与数理统计' },
      schedules: [1, 2, 3, 4, 5, 6, 7, 8].map((w) => ({
        date: '2026-09-07', weekday: 1, startUnit: 1, endUnit: 2, weekIndex: w, room: { nameZh: '402' }
      }))
    }
  ]
}
const e2eParsed = Z._internal.parseCourseTable(e2eTable)
TT.mergeJw({ items: e2eParsed.items, termStart: e2eParsed.termStart || '2026-09-07' })
const e2eItems = TT.read()
const e2eTerm = new Date(2026, 8, 7)
const labOf = (weekNo, dayIdx) =>
  (S.gridOf(e2eItems, weekNo, { termStart: e2eTerm, now: new Date(2026, 9, 24) }).days[dayIdx].items || [])
    .filter((x) => x.name === '大学物理实验(2)')
ok('第 4 周周三有实验', labOf(4, 2).length === 1)
ok('第 5 周任何地方都没有实验', [0, 1, 2, 3, 4, 5, 6].every((d) => labOf(5, d).length === 0))
ok('第 6 周周四有实验', labOf(6, 3).length === 1)
ok('第 7 周（本周）没有实验（实验排在偶数周）', [0, 1, 2, 3, 4, 5, 6].every((d) => labOf(7, d).length === 0))
ok('第 8 周周六有实验', labOf(8, 5).length === 1)
ok('第 10 周周三有实验（最后一个实验周）', labOf(10, 2).length === 1)
ok('第 11 周实验结束不再出现', [0, 1, 2, 3, 4, 5, 6].every((d) => labOf(11, d).length === 0))
const stat7 = S.gridOf(e2eItems, 7, { termStart: e2eTerm, now: new Date(2026, 9, 24) })
ok('普通课第 7 周照常（概率论周一）', stat7.days[0].items.some((x) => x.name === '概率论与数理统计'))

console.log('\n[深色模式配色]')
ok('深色调色板与浅色一一对应', S.PALETTE.length === S.DARK_PALETTE.length)
ok(
  '同一个课名浅深色取同一序号',
  S.PALETTE.indexOf(S.colorOf('数据结构')) === S.DARK_PALETTE.indexOf(S.colorOf('数据结构', true))
)
ok('深色块用深色调色板', S.colorOf('数据结构', true).bg === S.DARK_PALETTE[S.PALETTE.indexOf(S.colorOf('数据结构'))].bg)
const gDark = S.gridOf(gItems, 7, { termStart: term, now: new Date(2026, 9, 24, 10, 0), dark: true })
const gLight = S.gridOf(gItems, 7, { termStart: term, now: new Date(2026, 9, 24, 10, 0) })
ok(
  '深色网格的块背景来自深色调色板',
  gDark.days[0].items[0].bg === S.colorOf(gDark.days[0].items[0].name, true).bg
)
ok('深浅网格块背景不同', gDark.days[0].items[0].bg !== gLight.days[0].items[0].bg)
ok('深浅网格块文字色不同', gDark.days[0].items[0].fg !== gLight.days[0].items[0].fg)

console.log('\n[按周拆分（实验课逐次命名）]')
// 教务补全后的物理实验：单周列表 [1,3,7,9,11,13,15,17]
const labBlock = { id: '1|1|4|大学物理实验A(Ⅰ)', day: 1, start: 1, end: 4, name: '大学物理实验A(Ⅰ)', place: '物理实验中心楼', weeks: { from: 1, to: 17, parity: 1, list: [1, 3, 7, 9, 11, 13, 15, 17] } }
ok('周列表优先精确列表', JSON.stringify(S.weekListOf(labBlock.weeks)) === JSON.stringify([1, 3, 7, 9, 11, 13, 15, 17]))
ok('没有列表时按范围+单双周展开', JSON.stringify(S.weekListOf({ from: 2, to: 8, parity: 2 })) === JSON.stringify([2, 4, 6, 8]))
ok('单周格子拆不了', S.splitByWeek({ day: 1, start: 1, end: 2, name: 'X', weeks: { from: 3, to: 3, list: [3] } }).length === 0)
const parts = S.splitByWeek(labBlock)
ok('拆成 8 个单周格子', parts.length === 8, parts.length)
ok('第一格名字带周次', parts[0].name === '大学物理实验A(Ⅰ)·第1周', parts[0].name)
ok('第一格只上第 1 周', JSON.stringify(parts[0].weeks) === JSON.stringify({ from: 1, to: 1, list: [1], parity: 0 }))
ok('最后一格是第 17 周', JSON.stringify(parts[7].weeks.list) === JSON.stringify([17]))
ok('拆出来的格子 id 不重复', new Set(parts.map((p) => p.id)).size === 8)

console.log('\n[手动改过的格子不被教务覆盖]')
global.wx._s = {} // 清掉前面的存储
TT.write([{ id: '1|1|4|示波器实验', day: 1, start: 1, end: 4, name: '示波器实验', place: '物实301', weeks: { from: 3, to: 3, list: [3] }, manual: true }])
TT.mergeJw({ items: [labBlock], termStart: '2026-09-07' })
const afterManual = TT.read()
ok('手动格子保住了', afterManual.some((x) => x.name === '示波器实验' && x.manual))
ok('教务的同时间位让位（不重复出现物理实验原格）', !afterManual.some((x) => x.name === '大学物理实验A(Ⅰ)'))

console.log('\n----------------------------------------')
console.log('通过 ' + pass + ' 失败 ' + fail)
process.exit(fail ? 1 : 0)
