/**
 * 本地自检脚本（不依赖云环境）
 * 运行： node test/run.js
 */
const path = require('path')
const http = require('../cloudfunctions/studyHub/lib/http')
const secret = require('../cloudfunctions/studyHub/lib/secret')
const chaoxing = require('../cloudfunctions/studyHub/adapters/chaoxing')

let pass = 0
let fail = 0

function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + '\n    期望: ' + b + '\n    实际: ' + a)
  }
}

function truthy(name, v) {
  if (v) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name)
  }
}

/* ---------- CookieJar ---------- */
console.log('\n[CookieJar]')
const jar = new http.CookieJar('_uid=123456; _d=abcdef; fid=8888')
eq('解析初始 cookie 数量', jar.size(), 3)
eq('取 _uid', jar.get('_uid'), '123456')
truthy('header() 拼接', jar.header().indexOf('_uid=123456') > -1)
jar.setFromHeader('name=value; Path=/; HttpOnly')
eq('写入单条 cookie', jar.get('name'), 'value')
jar.setFromHeader('_uid=; Max-Age=0; Path=/')
eq('Max-Age=0 触发删除', jar.get('_uid'), undefined)

/* ---------- parseDate ---------- */
console.log('\n[parseDate]')
const d1 = new Date(http.parseDate('2026-10-30 23:59'))
eq('完整日期时间', [d1.getFullYear(), d1.getMonth() + 1, d1.getDate(), d1.getHours(), d1.getMinutes()], [2026, 10, 30, 23, 59])
const d2 = new Date(http.parseDate('2026年11月5日 08:00'))
eq('中文日期', [d2.getMonth() + 1, d2.getDate(), d2.getHours()], [11, 5, 8])
const d3 = new Date(http.parseDate('2026/12/01'))
eq('斜杠日期默认 23:59', [d3.getMonth() + 1, d3.getDate(), d3.getHours()], [12, 1, 23])
eq('空值返回 0', http.parseDate(''), 0)

/* ---------- 凭据加解密 ---------- */
console.log('\n[secret]')
const enc = secret.encrypt('my-password-123')
truthy('密文非明文', enc.indexOf('my-password') === -1)
eq('解密还原', secret.decrypt(enc), 'my-password-123')
eq('手机号打码', secret.mask('13812345678'), '138****5678')
eq('学号打码', secret.mask('202515020339'), '20***39')

/* ---------- 学习通 HTML 解析 ---------- */
console.log('\n[chaoxing.parseWorkHtml]')
const html = `
<div class="work-list">
  <ul>
    <li>
      <a href="/mooc-ans/work/doHomeWorkNew?workId=9001&courseId=100">第三章 极限与连续 作业</a>
      <span class="status">未交</span>
      <span>截止时间：2026-10-30 23:59</span>
    </li>
    <li>
      <a href="/mooc-ans/work/doHomeWorkNew?workId=9002">期中测验</a>
      <span class="status">已完成</span>
      <span>截止时间：2026-10-20 23:59</span>
    </li>
  </ul>
</div>`
const course = { courseId: '100', clazzId: '200', name: '高等数学', cpi: '333' }
const items = chaoxing._internal.parseWorkHtml(html, course)
eq('解析条数', items.length, 2)
eq('第一条标题', items[0] && items[0].title, '第三章 极限与连续 作业')
eq('第一条状态', items[0] && items[0].status, 'todo')
eq('第一条类型', items[0] && items[0].taskType, 'homework')
eq('第二条状态', items[1] && items[1].status, 'done')
eq('第二条类型识别为考试', items[1] && items[1].taskType, 'exam')
truthy('带出课程名', items[0] && items[0].courseName === '高等数学')
truthy('截止时间已解析', items[0] && items[0].deadline > 0)
truthy('externalId 唯一', items[0].externalId !== items[1].externalId)

/* ---------- 密码加密 ---------- */
console.log('\n[chaoxing.aesEncryptPassword]')
const ep = chaoxing._internal.aesEncryptPassword('123456')
truthy('输出为 base64', /^[A-Za-z0-9+/=]+$/.test(ep))
truthy('每次结果一致（确定性加密）', ep === chaoxing._internal.aesEncryptPassword('123456'))
truthy('不同密码结果不同', ep !== chaoxing._internal.aesEncryptPassword('1234567'))

/* ---------- 前端时间模型 ---------- */
console.log('\n[model.formatDeadline]')
const M = require('../miniprogram/utils/model')
const now = new Date(2026, 9, 23, 14, 0, 0).getTime()
const today = new Date(2026, 9, 23, 23, 59, 0).getTime()
const tomorrow = new Date(2026, 9, 24, 12, 0, 0).getTime()
const past = new Date(2026, 9, 21, 23, 59, 0).getTime()

const r1 = M.formatDeadline(today, now)
eq('今天 → urgent', r1.level, 'urgent')
truthy('今天文案含「今天」', r1.text.indexOf('今天') > -1)
const r2 = M.formatDeadline(tomorrow, now)
eq('明天 → urgent', r2.level, 'urgent')
const r3 = M.formatDeadline(past, now)
eq('过期 → expired', r3.level, 'expired')
eq('过期文案', r3.text, '已截止 2 天')
const r4 = M.formatDeadline(0, now)
eq('无截止', r4.level, 'none')

console.log('\n----------------------------------------')
console.log(`通过 ${pass}  失败 ${fail}`)
process.exit(fail ? 1 : 0)
