/**
 * 深色模式工具测试（离线，stub 掉 wx）
 *   node test/theme.js
 */
const store = {}
const navCalls = []
const bgCalls = []

global.wx = {
  getStorageSync: (k) => store[k],
  setStorageSync: (k, v) => {
    store[k] = v
  },
  setNavigationBarColor: (c) => navCalls.push(c),
  setBackgroundColor: (c) => bgCalls.push(c)
}

const theme = require('../miniprogram/utils/theme')

let pass = 0
let fail = 0
function eq(name, got, want) {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  if (a === b) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + '\n    期望: ' + b + '\n    实际: ' + a)
  }
}

console.log('\n[深色模式：状态与切换]')
eq('没设置过 → 默认浅色', theme.get(), 'light')
store['theme_v1'] = 'dark'
eq('存过 dark → 读出深色', theme.get(), 'dark')
store['theme_v1'] = '乱七八糟的值'
eq('坏值当浅色处理', theme.get(), 'light')

eq('toggle 浅→深', theme.toggle(), 'dark')
eq('toggle 后落库', store['theme_v1'], 'dark')
eq('toggle 深→浅', theme.toggle(), 'light')
eq('再 toggle 回深', theme.toggle(), 'dark')

console.log('\n[深色模式：应用到页面]')
navCalls.length = 0
bgCalls.length = 0
const page = { data: {}, setData(p) { Object.assign(this.data, p) } }
const t = theme.apply(page)
eq('apply 写入 data.theme', page.data.theme, 'dark')
eq('apply 返回当前主题', t, 'dark')
eq('深色导航栏深底浅字', navCalls[0], { frontColor: '#F2F3F8', backgroundColor: '#1C1E28' })
eq('深色窗口底色', bgCalls[0], { color: '#101116' })

store['theme_v1'] = 'light'
navCalls.length = 0
theme.apply(page)
eq('浅色导航栏白底黑字', navCalls[0], { frontColor: '#000000', backgroundColor: '#FFFFFF' })

console.log('\n----------------------------------------')
console.log('通过 ' + pass + ' 失败 ' + fail)
process.exit(fail ? 1 : 0)
