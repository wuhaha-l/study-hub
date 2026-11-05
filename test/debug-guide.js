/**
 * 调试模式体检（离线静态检查）
 *   node test/debug-guide.js
 *
 * 约束：不在启动时自动开「开发调试」。
 *   wx.setEnableDebug({enableDebug:true}) 会让每台机器右下角常驻一个 vConsole，
 *   不需要连内网的人也被迫开着；正式版还根本不生效。
 *   正确做法是：用户真去登录希冀时，弹一次「在哪开」的引导（每台机器只弹一次），
 *   卡片上再留一个随时能点的入口。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

let pass = 0
let fail = 0
function ok(name) {
  pass++
  console.log('  ✓ ' + name)
}
function bad(name, detail) {
  fail++
  console.log('  ✗ ' + name + '\n    ' + detail)
}

const appJs = read('miniprogram/app.js')
const accJs = read('miniprogram/pages/accounts/accounts.js')
const accWxml = read('miniprogram/pages/accounts/accounts.wxml')

console.log('\n[启动时不许自动开调试]')
const appSrc = appJs.replace(/\/\/.*$/gm, '')
if (/enableDebug\s*:\s*true/.test(appSrc)) {
  bad('app.js', 'onLaunch 里又在开调试：会强制所有人挂 vConsole')
} else {
  ok('app.js 不会自动打开调试')
}
// 旧版开过的开关微信记在本机，删掉调用不会自己关回去，所以要一次性收尾
if (/DEBUG_FIX_KEY/.test(appSrc) && /enableDebug\s*:\s*false/.test(appSrc)) {
  ok('有一次性收尾（升级后第一次启动关掉历史遗留的调试）')
} else {
  bad('app.js', '缺一次性关闭：老用户手机上绿标会一直在')
}

console.log('\n[登录希冀时给出「在哪开」的引导]')
if (/DEBUG_GUIDE_KEY/.test(accJs) && /function\s+debugGuideSeen/.test(accJs)) {
  ok('引导只弹一次（本机存储记标记）')
} else {
  bad('accounts.js', '缺 DEBUG_GUIDE_KEY / debugGuideSeen，会每次登录都拦一道')
}
if (/eduShowDebugGuide\s*\(/.test(accJs)) ok('有 eduShowDebugGuide 弹窗方法')
else bad('accounts.js', '缺 eduShowDebugGuide')
if (/_eduSubmitLogin\s*\(/.test(accJs)) ok('登录请求拆到 _eduSubmitLogin（引导确认后才发）')
else bad('accounts.js', '缺 _eduSubmitLogin，引导与请求没法串起来')
if (/debugGuideSeen\(\)/.test(accJs)) ok('eduLogin 里有「先看引导」的判断')
else bad('accounts.js', 'eduLogin 没接引导判断')
if (/isDomainBlocked\s*\(/.test(accJs)) ok('被微信拦地址时转去引导（不是干巴巴的报错）')
else bad('accounts.js', '缺 isDomainBlocked 分支')
if (/bindtap="eduShowDebugGuide"/.test(accWxml)) ok('卡片上有常驻入口')
else bad('accounts.wxml', '缺 bindtap="eduShowDebugGuide" 的入口')

console.log('\n' + (fail ? '✗ ' + fail + ' 处问题' : '✓ 全部通过') + '（' + pass + ' 项）')
process.exit(fail ? 1 : 0)
