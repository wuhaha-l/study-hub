/**
 * 「哪些平台该重新登录了」—— 判定规则
 *
 * 这块很容易做错：把「网络超时」也当成「要重新登录」，用户就会去重填一个
 * 本来没错的密码，然后更困惑。所以测试重点在两件事：
 *   1. 只有凭据类错误才算数
 *   2. 老模式账号（proxy / intranet）不是「过期」，文案要分开
 */
const R = require('../miniprogram/utils/relogin.js')

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (extra === undefined ? '' : '  →  ' + JSON.stringify(extra)))
  }
}
function eq(name, a, b) {
  ok(name + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）', JSON.stringify(a) === JSON.stringify(b))
}

const NOW = new Date('2026-10-28T16:00:00').getTime()
const DAY = 86400000

function acc(o) {
  return Object.assign({ platform: 'chaoxing', mode: 'cookie', status: 'ok', lastError: '', lastSyncAt: NOW - DAY }, o || {})
}

R.reset()

console.log('\n[1] 云端说失效：直接算「要重新登录」')
{
  const r = R.inspect(acc({ status: 'invalid', lastError: 'Cookie 已过期' }), {}, NOW)
  eq('要处理', r.need, true)
  eq('原因是过期', r.reason, 'expired')
  eq('带上原始错误', r.detail, 'Cookie 已过期')
}

console.log('\n[2] 云端 lastError 是凭据类错误')
{
  const cases = [
    '账号或密码不正确',
    '登录已失效，请重新登录',
    '未登录',
    'Cookie 不完整，缺少 _d',
    '401 Unauthorized',
    '凭据读取失败'
  ]
  cases.forEach((msg) => {
    const r = R.inspect(acc({ lastError: msg }), {}, NOW)
    eq('「' + msg + '」算登录问题', r.reason, 'cred')
  })
}

console.log('\n[3] 网络类错误不算：重登也救不了，别让用户白跑')
{
  const cases = ['请求超时', '网络异常，请稍后再试', '云函数 studyHub 尚未部署', 'HTTP 502', 'DNS 解析失败']
  cases.forEach((msg) => {
    const r = R.inspect(acc({ lastError: msg }), {}, NOW)
    eq('「' + msg + '」不提醒', r.need, false)
  })
}

console.log('\n[4] 老模式账号：云端没有凭据，说法必须不一样')
{
  ;['proxy', 'intranet'].forEach((mode) => {
    const r = R.inspect(acc({ mode: mode }), {}, NOW)
    eq(mode + ' 要处理', r.need, true)
    eq(mode + ' 归到 legacy', r.reason, 'legacy')
    ok(mode + ' 的文案说清是「没有凭据」', /凭据/.test(r.reasonText), r.reasonText)
  })
}

console.log('\n[5] 失效压过老模式：已经是 invalid 就别再说「没有凭据」')
{
  const r = R.inspect(acc({ mode: 'proxy', status: 'invalid' }), {}, NOW)
  eq('按过期算', r.reason, 'expired')
}

console.log('\n[6] 本地记下的凭据错误（诊断 / 同步当场抓到的）')
{
  R.reset()
  eq('密码错误会记下来', R.note('chaoxing', '账号或密码不正确', NOW), true)
  const r = R.inspect(acc({ status: 'ok' }), R.readSeen(NOW), NOW)
  eq('账号本身没问题也提醒', r.need, true)
  eq('原因是凭据', r.reason, 'cred')
  ok('带上那句话', /账号或密码不正确/.test(r.detail), r.detail)

  eq('超时不记', R.note('unipus', '请求超时', NOW), false)
  eq('记完还能清', (R.clear('chaoxing'), R.inspect(acc({}), R.readSeen(NOW), NOW).need), false)
}

console.log('\n[7] 本地记录会过期，不会挂着一条陈年旧错')
{
  R.reset()
  R.note('chaoxing', '登录已失效', NOW)
  const fresh = R.inspect(acc({}), R.readSeen(NOW), NOW + 1000)
  eq('刚记的有效', fresh.need, true)
  const old = R.inspect(acc({}), R.readSeen(NOW + 31 * DAY), NOW + 31 * DAY)
  eq('31 天后自动失效', old.need, false)
}

console.log('\n[8] 汇总：真的过期的排在老模式前面')
{
  R.reset()
  const list = [
    acc({ platform: 'chaoxing', mode: 'proxy' }),
    acc({ platform: 'unipus', status: 'invalid' }),
    acc({ platform: 'icourse163', lastError: '请求超时' })
  ]
  const s = R.survey(list, { now: NOW, seen: {} })
  eq('两个要处理（超时的那个不算）', s.count, 2)
  eq('顺序：先过期、后重绑', s.keys, ['unipus', 'chaoxing'])
  eq('标题带数字', s.title, '2 个平台需要重新登录')
  ok('一句话里说清各是哪种问题', /U校园 登录过期/.test(s.text) && /学习通 要重绑/.test(s.text), s.text)
  eq('平台名取中文', s.items.map((x) => x.name), ['U校园', '学习通'])
  eq('动作分两种', s.items.map((x) => x.action), ['重新登录', '重绑'])
}

console.log('\n[9] 一切正常时不该冒出提醒')
{
  const s = R.survey([acc({ platform: 'chaoxing' }), acc({ platform: 'unipus' })], { now: NOW, seen: {} })
  eq('没有待处理', s.count, 0)
  eq('标题空着（页面据此判断显不显示）', s.title, '')
}

console.log('\n[10] 「今天稍后」只管今天')
{
  R.reset()
  eq('默认没静音', R.isMuted(NOW), false)
  R.muteToday(NOW)
  eq('点了就静音', R.isMuted(NOW), true)
  eq('同一天还是静音', R.isMuted(NOW + 3600000), true)
  eq('第二天自动恢复', R.isMuted(NOW + DAY), false)
  R.unmute()
  eq('手动取消也行', R.isMuted(NOW), false)
}

console.log('\n[11] 账号为空不炸')
{
  eq('空数组', R.survey([], { now: NOW, seen: {} }).count, 0)
  eq('null', R.survey(null, { now: NOW, seen: {} }).count, 0)
  eq('单条 null', R.inspect(null, {}, NOW).need, false)
}

/*
 * 静态接线检查。这套判定只要有一头没接上就等于白做：
 *   首页不显示 → 用户永远不知道哪个平台掉线了
 *   账号页不给入口 → 看见了也没处点
 *   同步失败不记 → 云端不落库的那类错误（老模式、诊断）永远进不来
 */
console.log('\n[12] 页面接线（少一处提醒就断了）')
{
  const fs = require('fs')
  const path = require('path')
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
  const idxJs = read('miniprogram/pages/index/index.js')
  const idxWxml = read('miniprogram/pages/index/index.wxml')
  const accJs = read('miniprogram/pages/accounts/accounts.js')
  const accWxml = read('miniprogram/pages/accounts/accounts.wxml')
  const syncJs = read('miniprogram/utils/syncall.js')

  ok('首页引了 relogin', /require\('\.\.\/\.\.\/utils\/relogin'\)/.test(idxJs))
  ok('首页有提醒条', /class="relogin"[^>]*wx:if="\{\{reloginShow/.test(idxWxml))
  ok('提醒条点得进账号页', /goRelogin/.test(idxJs) && /bindtap="goRelogin"/.test(idxWxml))
  ok('点「稍后」只静音今天', /muteToday\(\)/.test(idxJs) && /catchtap="onReloginLater"/.test(idxWxml))
  ok('同步失败会记下来', /markRelogin\(r\)/.test(idxJs) && /relogin\.note/.test(idxJs))

  ok('账号页引了 relogin', /require\('\.\.\/\.\.\/utils\/relogin'\)/.test(accJs))
  ok('账号页有汇总卡', /class="relogin"/.test(accWxml))
  ok('汇总卡每行能点开登录表单', /reloginOne/.test(accJs) && /bindtap="reloginOne"/.test(accWxml))
  ok('已绑定行也有「重新登录」', /op warn[^>]*catchtap="reloginOne"/.test(accWxml))
  ok('重登成功才清标记（按抓取结果，不按保存成功）', /errs\.length[\s\S]{0,200}relogin\.note/.test(accJs))

  ok('同步弹窗把登录类失败单独标出来', /需要重新登录/.test(syncJs))
}

console.log('\n----------------------------------------')
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
if (fail) process.exit(1)
