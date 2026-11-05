/**
 * 扫码登录连通性测试。
 * 用法：node test/qrlogin.js
 *
 * ⚠️ 需要能访问 passport2.chaoxing.com，只验证「能拿到二维码 + 轮询返回合法状态」，
 *    不涉及你的账号，也不会产生任何登录行为。
 */

const qrlogin = require('../cloudfunctions/studyHub/lib/qrlogin')

let failed = 0
function check(name, cond, extra) {
  if (cond) {
    console.log('  ✓ ' + name)
  } else {
    failed++
    console.log('  ✗ ' + name + (extra ? '  → ' + extra : ''))
  }
}

;(async () => {
  console.log('\n扫码登录（需要网络）')

  let s
  try {
    s = await qrlogin.start('test-openid')
  } catch (e) {
    console.log('  ✗ 获取二维码失败：' + e.message)
    console.log('  （提示人机验证说明当前 IP 被学习通风控，不是代码问题）')
    process.exit(1)
  }

  check('拿到二维码 data URI', /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(s.qr))
  check(
    '二维码体积合理',
    s.qr.length > 1000 && s.qr.length < 30000,
    s.qr.length + ' 字符'
  )
  check('token 已加密', /^v1\./.test(s.token))
  check('有效期约 4 分钟', Math.abs(s.expireAt - Date.now() - qrlogin.TTL) < 5000)

  const p1 = await qrlogin.poll(s.token, 'test-openid')
  check('未扫码时状态为 waiting', p1.state === 'waiting', JSON.stringify(p1))

  const p2 = await qrlogin.poll(s.token, 'attacker-openid')
  check('他人的 token 被拒绝', p2.state === 'error', JSON.stringify(p2))

  const p3 = await qrlogin.poll('v1.x.y.z', 'test-openid')
  check('损坏 token 返回 expired 而不是崩溃', p3.state === 'expired')

  console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 扫码模块全部通过')
  process.exit(failed ? 1 : 0)
})()
