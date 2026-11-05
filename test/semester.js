/* 学期判定测试 */
const S = require('../miniprogram/utils/semester')

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

const t = (s) => new Date(s).getTime()

console.log('[按开始时间推学期]')
const a = S.of(t('2026-09-02T08:24:00'))
ok('9 月入学 → 2026-2027 秋', a.key === '2026-2027-秋' && a.short === '2026 秋', a)

const b = S.of(t('2026-03-06T09:07:00'))
ok('3 月开课 → 2025-2026 春', b.key === '2025-2026-春' && b.short === '2026 春', b)

const c = S.of(t('2026-01-15T10:00:00'))
ok('1 月归上一学年秋', c.key === '2025-2026-秋', c)

const d = S.of(t('2026-08-01T10:00:00'))
ok('8 月算新学年秋', d.key === '2026-2027-秋', d)

const e = S.of(1788308640000) // 毫秒
const f = S.of(1788308640) // 秒级也要认
ok('毫秒与秒都给同一学期', e && f && e.key === f.key, [e, f])

ok('空值返回 null', S.of(0) === null && S.of(null) === null)

console.log('[当前学期]')
const now = S.current(new Date('2026-10-24T10:00:00').getTime())
ok('2026-10-24 处于 2026-2027 秋', now.key === '2026-2027-秋', now)

console.log('[课程名兜底]')
const n1 = S.fromName('数据结构（2026春季）')
ok('中文括号 + 2026春季', n1 && n1.key === '2025-2026-春', n1)

const n2 = S.fromName('高等数学(2025-2026-2)')
ok('2025-2026-2 → 春', n2 && n2.key === '2025-2026-春', n2)

const n3 = S.fromName('高等数学(2025-2026-1)')
ok('2025-2026-1 → 秋', n3 && n3.key === '2025-2026-秋', n3)

const n4 = S.fromName('某课 2025—2026学年第一学期')
ok('全角破折号 + 第一学期 → 2025 秋', n4 && n4.key === '2025-2026-秋', n4)

const n5 = S.fromName('大学英语 2026秋')
ok('2026秋', n5 && n5.key === '2026-2027-秋', n5)

// 2 位年份 + 季节（U校园课程名「25秋25级大英1」这类）
const n6 = S.fromName('25秋25级大英1')
ok('25秋 → 2025 秋', n6 && n6.key === '2025-2026-秋', n6)
const n7 = S.fromName('26春大英2')
ok('26春 → 2026 春', n7 && n7.key === '2025-2026-春', n7)
const n8 = S.fromName('26秋25级大学英语（新时代大学英语）(基础版)')
ok('26秋 → 2026 秋（本学期）', n8 && n8.key === '2026-2027-秋', n8)

ok('没有学期字样的课名 → null', S.fromName('汇编语言') === null)

console.log('[综合判断 ofCourse]')
const c1 = S.ofCourse({ startMs: t('2026-09-02T08:24:00'), name: '汇编语言' })
ok('有时间时以时间为准', c1.key === '2026-2027-秋', c1)

const c2 = S.ofCourse({ startMs: 0, name: '数据结构（2026春季）' })
ok('没时间时用课名兜底', c2.key === '2025-2026-春', c2)

const c3 = S.ofCourse({ startMs: 0, name: '汇编语言' })
ok('都没有 → unknown', c3.key === 'unknown', c3)

console.log('[排序]')
ok('秋季比春季新', S.fall(2026).rank > S.spring(2026).rank)
ok('新学年比旧学年新', S.fall(2026).rank > S.fall(2025).rank)

console.log('[展示文案]')
ok("shortOf('2026-2027-秋') = '2026 秋'", S.shortOf('2026-2027-秋') === '2026 秋')
ok("shortOf('2025-2026-春') = '2026 春'", S.shortOf('2025-2026-春') === '2026 春')
ok('未知 key → 未知', S.shortOf('unknown') === '未知' && S.shortOf('') === '未知')

console.log('\n----------------------------------------')
console.log('通过 ' + pass + ' 失败 ' + fail)
process.exit(fail ? 1 : 0)
