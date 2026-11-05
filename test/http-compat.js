/**
 * 验证 Node 16 兼容路径：把全局 fetch 干掉，强制走内置 http/https 实现。
 * 运行： node test/http-compat.js
 */
globalThis.fetch = undefined // 模拟 Node 16.13

const http = require('../cloudfunctions/studyHub/lib/http')

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (extra ? '  → ' + extra : ''))
  }
}

;(async () => {
  console.log('\n[确认已降级]')
  check('全局 fetch 不可用', typeof fetch !== 'function')

  console.log('\n[GET 真实请求]')
  try {
    const jar = new http.CookieJar()
    const res = await http.request('https://www.baidu.com/', { jar, timeout: 15000 })
    check('拿到 200', res.status === 200, 'status=' + res.status)
    check('响应体非空', res.text.length > 100, 'len=' + res.text.length)
    check('headers.get 可用', !!res.headers.get('content-type'), res.headers.get('content-type'))
    check('json() 方法存在', typeof res.json === 'function')
    check('CookieJar 可写入', typeof jar.header() === 'string')
  } catch (e) {
    fail++
    console.log('  ✗ 请求失败 → ' + e.message)
  }

  console.log('\n[重定向 + POST]')
  try {
    const jar = new http.CookieJar()
    // httpbin 类的公共端点可能不稳定，这里用 POST 到国内可访问的地址测试请求体
    const res = await http.request('https://www.baidu.com/s', {
      method: 'POST',
      body: 'wd=test',
      jar,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      timeout: 15000
    })
    check('POST 返回有效状态码', res.status > 0, 'status=' + res.status)
  } catch (e) {
    fail++
    console.log('  ✗ POST 失败 → ' + e.message)
  }

  console.log('\n----------------------------------------')
  console.log(`通过 ${pass}  失败 ${fail}`)
  process.exit(fail ? 1 : 0)
})()
