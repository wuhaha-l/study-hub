/**
 * 访客账号（手机号注册）+ 角色权限的本地自检
 *
 * 跑法：node test/auth.js
 *
 * 三块：
 *   1. 手机号 / 密码 / 掩码这些纯函数
 *   2. 注册与登录的流程（用内存假数据库，不连云）
 *   3. 「哪些功能只给学校账号」这份清单本身——两边漏一个就是安全洞
 */
const path = require('path')
const ROOT = path.join(__dirname, '..')

/* ------------------------------------------------------------------ */
/* 内存版 wx 存储（前端 utils/auth.js 用）                             */
/* ------------------------------------------------------------------ */
const store = {}
global.wx = {
  getStorageSync(k) {
    return Object.prototype.hasOwnProperty.call(store, k) ? JSON.parse(JSON.stringify(store[k])) : ''
  },
  setStorageSync(k, v) {
    store[k] = JSON.parse(JSON.stringify(v))
  },
  removeStorageSync(k) {
    delete store[k]
  }
}

const users = require(path.join(ROOT, 'cloudfunctions', 'studyHub', 'lib', 'users'))
const perms = require(path.join(ROOT, 'cloudfunctions', 'studyHub', 'lib', 'permissions'))
const AUTH = require(path.join(ROOT, 'miniprogram', 'utils', 'auth'))

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
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected })
}
function throws(name, fn, keyword) {
  try {
    fn()
  } catch (e) {
    const msg = String((e && e.message) || e)
    ok(name + '（' + msg + '）', !keyword || msg.indexOf(keyword) > -1)
    return
  }
  ok(name, false, '没有抛错')
}
async function rejects(name, fn, keyword) {
  try {
    await fn()
  } catch (e) {
    const msg = String((e && e.message) || e)
    ok(name + '（' + msg + '）', !keyword || msg.indexOf(keyword) > -1)
    return
  }
  ok(name, false, '没有抛错')
}

/* ------------------------------------------------------------------ */
/* 假数据库：行为和云开发保持一致（集合不存在时报 not exists）         */
/* ------------------------------------------------------------------ */
function makeDb() {
  const cols = {}
  let seq = 0
  function rows(name) {
    if (!cols[name]) cols[name] = []
    return cols[name]
  }
  function missing() {
    const e = new Error('database collection not exists')
    e.errCode = -502005
    return e
  }
  function q(name, filter) {
    const query = {
      where(f) {
        return q(name, f)
      },
      limit() {
        return query
      },
      skip() {
        return query
      },
      async get() {
        let list = rows(name).slice()
        if (filter && Object.keys(filter).length) {
          list = list.filter((r) => Object.keys(filter).every((k) => r[k] === filter[k]))
        }
        return { data: list }
      },
      async add({ data }) {
        const _id = 'u' + ++seq
        rows(name).push(Object.assign({ _id }, data))
        return { _id }
      },
      doc(id) {
        return {
          async get() {
            const row = rows(name).find((r) => r._id === id)
            if (!row) throw new Error('document.get:fail document not exist')
            return { data: row }
          },
          async update({ data }) {
            const row = rows(name).find((r) => r._id === id)
            if (row) Object.assign(row, data)
            return { stats: { updated: row ? 1 : 0 } }
          },
          async remove() {
            const i = rows(name).findIndex((r) => r._id === id)
            if (i > -1) rows(name).splice(i, 1)
            return { stats: { removed: i > -1 ? 1 : 0 } }
          }
        }
      }
    }
    return query
  }
  return {
    _cols: cols,
    collection(name) {
      if (!cols[name]) {
        // 集合不存在：get / add / doc 都要抛，和线上一致
        return {
          where() {
            return {
              limit() {
                return this
              },
              async get() {
                throw missing()
              }
            }
          },
          async add() {
            throw missing()
          },
          doc() {
            throw missing()
          }
        }
      }
      return q(name, null)
    },
    async createCollection(name) {
      rows(name)
      return { errMsg: 'createCollection:ok' }
    }
  }
}

/* ================================================================== */
/* 一、手机号 / 密码 / 掩码                                            */
/* ================================================================== */
console.log('\n【访客：手机号与密码】')
{
  eq('普通 11 位', users.normPhone('13800138000'), '13800138000')
  eq('带 +86', users.normPhone('+8613800138000'), '13800138000')
  eq('带 0086', users.normPhone('008613800138000'), '13800138000')
  eq('带空格和连字符', users.normPhone('138 0013-8000'), '13800138000')
  eq('全角数字也能救', users.normPhone('１３８'), '138')
  eq('空值不崩', users.normPhone(null), '')

  eq('合法手机号', users.validPhone('13800138000'), true)
  eq('10 位不合法', users.validPhone('1380013800'), false)
  eq('12 位不合法', users.validPhone('138001380000'), false)
  eq('1 开头但第二位是 2', users.validPhone('12800138000'), false)
  eq('带分隔符也认', users.validPhone('138-0013-8000'), true)

  eq('密码 6 位可以', users.validPwd('123456'), true)
  eq('密码 5 位不行', users.validPwd('12345'), false)
  eq('密码 33 位不行', users.validPwd('a'.repeat(33)), false)
  eq('密码空不行', users.validPwd(''), false)
  eq('密码非字符串不行', users.validPwd(null), false)

  eq('掩码', users.maskPhone('13800138000'), '138****8000')
  eq('掩码：不规范只留前三位', users.maskPhone('138'), '138****')
  eq('掩码：空值', users.maskPhone(''), '')

  eq('昵称去空格', users.normNickname('  小明  ', '13800138000'), '小明')
  eq('昵称太长截断', users.normNickname('一二三四五六七八九十一二三', '13800138000').length, 12)
  eq('没填昵称就用手机尾号', users.normNickname('', '13800138000'), '用户8000')

  const salt = 'abc123'
  const h1 = users.hashPwd('123456', salt)
  eq('同一个盐结果稳定', h1, users.hashPwd('123456', salt))
  ok('换个盐结果不同', h1 !== users.hashPwd('123456', 'zzz'))
  ok('密码不同结果不同', h1 !== users.hashPwd('123457', salt))
  ok('哈希里看不到明文', h1.indexOf('123456') === -1 && h1.length === 64)
}

/* ================================================================== */
/* 二、注册 / 登录（假数据库）                                         */
/* ================================================================== */
;(async () => {
  console.log('\n【访客：注册】')
  {
    users._setDb(makeDb()) // 全新环境，users 集合还不存在

    const p = await users.register({
      openid: 'openid_A',
      phone: '13800138000',
      password: 'abc123',
      nickname: '小明'
    })
    eq('注册后是访客', p.role, 'guest')
    eq('返回的是掩码手机号', p.phone, '138****8000')
    eq('昵称带出来', p.nickname, '小明')
    ok('不返回密码哈希', p.pwdHash === undefined && p.salt === undefined, p)

    eq('角色查得到', await users.roleOf('openid_A'), 'guest')
    eq('isGuest 对得上', await users.isGuest('openid_A'), true)

    const row = (await users.findByPhone('13800138000')) || {}
    ok('密码没有明文落库', row.pwdHash && row.pwdHash !== 'abc123')
    ok('存了独立的盐', !!row.salt && row.salt.length === 32)

    await rejects(
      '手机号格式不对要拦',
      () => users.register({ openid: 'openid_B', phone: '12345', password: 'abc123' }),
      '手机号'
    )
    await rejects(
      '密码太短要拦',
      () => users.register({ openid: 'openid_B', phone: '13900139000', password: '123' }),
      '密码'
    )
    await rejects(
      '同一个手机号不能注册两次',
      () => users.register({ openid: 'openid_B', phone: '13800138000', password: 'abc123' }),
      '已注册'
    )
    await rejects(
      '同一个微信不能注册两个号',
      () => users.register({ openid: 'openid_A', phone: '13900139000', password: 'abc123' }),
      '注册过'
    )

    // 同一个微信换手机号：旧记录换掉，不会攒一堆身份
    const p2 = await users.register({
      openid: 'openid_C',
      phone: '13700137000',
      password: 'abc123'
    })
    eq('没填昵称自动补', p2.nickname, '用户7000')
  }

  console.log('\n【访客：登录】')
  {
    // 登录：换个微信（模拟换手机）
    const p = await users.login({
      openid: 'openid_X',
      phone: '13800138000',
      password: 'abc123'
    })
    eq('登录成功还是访客', p.role, 'guest')
    eq('换微信后新 openid 能查到', await users.roleOf('openid_X'), 'guest')
    eq('旧微信已经解绑（回到默认 school）', await users.roleOf('openid_A'), 'school')

    // 这条用另一个号，别把下面「连错锁定」的计数搅浑
    await rejects(
      '密码不对要拦',
      () => users.login({ openid: 'openid_X', phone: '13700137000', password: 'wrong1' }),
      '不对'
    )
    await rejects(
      '没注册的手机号要拦',
      () => users.login({ openid: 'openid_X', phone: '13600136000', password: 'abc123' }),
      '还没注册'
    )
    await rejects(
      '手机号格式不对要拦',
      () => users.login({ openid: 'openid_X', phone: '111', password: 'abc123' }),
      '手机号'
    )

    // 连错 5 次锁 10 分钟
    for (let i = 0; i < 4; i++) {
      try {
        await users.login({ openid: 'openid_X', phone: '13800138000', password: 'bad' + i })
      } catch (e) {
        /* 前 4 次都在提示还剩几次 */
      }
    }
    await rejects(
      '第 5 次错直接锁',
      () => users.login({ openid: 'openid_X', phone: '13800138000', password: 'bad9' }),
      '锁定'
    )
    await rejects(
      '锁住之后正确密码也进不来',
      () => users.login({ openid: 'openid_X', phone: '13800138000', password: 'abc123' }),
      '分钟'
    )

    // 盯一下：锁定时长写进记录了，不是只靠记在内存里
    const row = await users.findByPhone('13800138000')
    ok('锁到 10 分钟后才解', Number(row.lockUntil) > Date.now() + 9 * 60 * 1000, row.lockUntil)
  }

  console.log('\n【访客：一个微信上只挂一个号】')
  {
    const db = makeDb()
    db.createCollection('users')
    users._setDb(db)

    await users.register({ openid: 'wHome', phone: '13500135001', password: 'abc123' })
    await users.register({ openid: 'wHome2', phone: '13500135002', password: 'abc123' })
    // 假的「另一个微信」上挂着 001，现在这个微信要登 002
    eq('001 先登在这台微信上', (await users.login({
      openid: 'wOne', phone: '13500135001', password: 'abc123'
    })).role, 'guest')

    await rejects(
      '同一微信换号登录：旧号没退出就拦住',
      () => users.login({ openid: 'wOne', phone: '13500135002', password: 'abc123' }),
      '另一个访客账号'
    )
    const still = await users.findByPhone('13500135001')
    ok('旧号记录没被删', !!still)
    eq('旧号还绑在这个微信上（没被顶掉）', still && still.openid, 'wOne')

    // 退出之后就能换号：旧号只解绑，记录留着以后还能登回来
    await users.logout('wOne')
    const p = await users.login({ openid: 'wOne', phone: '13500135002', password: 'abc123' })
    eq('退出后能登另一个号', p.role, 'guest')
    const old = await users.findByPhone('13500135001')
    ok('旧号记录还在（没被删）', !!old)
    eq('旧号只是解绑了 openid', old && old.openid, '')
    eq('旧号仍是访客', old && old.role, 'guest')

    // 登回旧号：解绑过的记录能重新挂回来
    const back = await users.login({ openid: 'wOne2', phone: '13500135001', password: 'abc123' })
    eq('旧号能在别的微信上登回来', back.role, 'guest')
  }

  console.log('\n【访客：老用户与身份升级】')
  {
    const db = makeDb()
    db.createCollection('users')
    users._setDb(db)

    eq('没有记录的老用户默认是 school', await users.roleOf('openid_OLD'), 'school')
    eq('isGuest 对老用户是 false', await users.isGuest('openid_OLD'), false)
    eq('profile 兜底也给 school', (await users.profile('openid_OLD')).role, 'school')

    // 学校账号登录成功 → 打标
    const s = await users.markSchool({ openid: 'openid_OLD', username: '202515020339' })
    eq('打标后是 school', s.role, 'school')
    eq('学号记下来了', s.username, '202515020339')
    eq('roleOf 也变了', await users.roleOf('openid_OLD'), 'school')

    // 访客能直接换成学校账号：统一认证已经过了，不该再拿「先退出」卡人
    await users.register({ openid: 'openid_G', phone: '13500135000', password: 'abc123' })
    const g = await users.markSchool({ openid: 'openid_G', username: '202515020340' })
    eq('访客能直接换成学校账号', g.role, 'school')
    eq('学号记下来了', g.username, '202515020340')
    eq('这个微信现在是 school', await users.roleOf('openid_G'), 'school')
    const keep = await users.findByPhone('13500135000')
    ok('访客记录还在（以后能用手机号登回来）', !!keep)
    eq('只是把 openid 解绑了', keep && keep.openid, '')
    eq('访客记录本身还是 guest', keep && keep.role, 'guest')
    // 再登一次不会堆出第二条 school 记录
    const g2 = await users.markSchool({ openid: 'openid_G', username: '202515020340' })
    eq('重复打标是幂等的', g2.username, '202515020340')

    // 学校账号没有手机号，手机号登录这条路找不到人
    await rejects(
      '手机号登录找不到学校账号',
      () => users.login({ openid: 'openid_Z', phone: '13300133000', password: 'abc123' }),
      '还没注册'
    )
  }

  console.log('\n【身份切换】')
  {
    const db = makeDb()
    db.createCollection('users')
    users._setDb(db)

    await users.register({ openid: 'o1', phone: '13600136000', password: 'abc123', nickname: '访客甲' })
    eq('先是访客', await users.roleOf('o1'), 'guest')

    // 学校账号已经登录着，就别再拿手机号登访客（否则自己那条 school 记录会被顶掉）
    await users.markSchool({ openid: 'o2', username: '202515020339' })
    await rejects(
      '学校账号去登访客会被拦',
      () => users.login({ openid: 'o2', phone: '13600136000', password: 'abc123' }),
      '学校账号'
    )
    eq('拦下来后学校身份没变', await users.roleOf('o2'), 'school')

    // 访客退出 → 打「已退出」标记（不解绑），才换得回学校账号
    await users.logout('o1')
    eq('退出后不再是访客', await users.isGuest('o1'), false)
    eq('退出后是 anonymous，不是学校账号', await users.roleOf('o1'), 'anonymous')
    const back = await users.findByPhone('13600136000')
    ok('手机号记录还留着（以后能登回来）', !!back)
    eq('openid 仍挂在记录上（解绑就认不出他了）', back && back.openid, 'o1')
    eq('标记为已退出', back && back.loggedOut, true)
    eq('已退出的人拿不到学校数据', users.ownerOf('o1', 'anonymous'), 'g::o1')

    const again = await users.login({ openid: 'o1', phone: '13600136000', password: 'abc123' })
    eq('同一个号能重新登回来', again.role, 'guest')

    // 再退一次，这回换成学校账号
    await users.logout('o1')
    const up = await users.markSchool({ openid: 'o1', username: '202599999999' })
    eq('同一个微信能换成学校账号了', up.role, 'school')
    eq('学号记下来了', up.username, '202599999999')

    // 学校账号退出：打「已退出」标记（这样用户才能登游客，不再被
    // 「当前微信已绑定学校账号」卡死），学号记录留着，下次登录不用重填
    await users.logout('o2')
    eq('学校记录退出后变成 anonymous', await users.roleOf('o2'), 'anonymous')
    eq('学号还在（重新登录不用重填）', (await users.profile('o2')).username, '202515020339')

    // 退出学校账号后，能直接注册访客（这是本次修复的核心：不再被
    // 「当前微信已绑定学校账号，不能再注册访客」拦住）
    const reg2 = await users.register({ openid: 'o2', phone: '13500135001', password: 'abc123', nickname: '游客乙' })
    eq('退出学校后能注册访客', reg2.role, 'guest')

    // 再换回学校账号：markSchool 清掉 loggedOut，回到 school
    await users.markSchool({ openid: 'o2', username: '202515020339' })
    eq('重新登录学校回到 school', await users.roleOf('o2'), 'school')
  }

  console.log('\n【权限清单】')
  {
    const must = [
      'saveAccount',
      'deleteAccount',
      'syncTasks',
      'qrStart',
      'qrPoll',
      'cxSelfTest',
      'zzuSchedule'
    ]
    must.forEach((a) => ok('学校功能：' + a, perms.isSchoolOnly(a)))
    ok('访客不能绑平台', perms.isSchoolOnly('saveAccount'))
    ok('访客不能同步', perms.isSchoolOnly('syncTasks'))
    ok('访客不能拉教务课表', perms.isSchoolOnly('zzuSchedule'))

    // 登录动作本身必须对所有身份放行：否则访客想换成学校账号，
    // 第一步就被 403 挡住，而访客又退不出去 → 死结
    ;['zzuAuto', 'zzuMfaVerify'].forEach((a) => {
      ok('登录动作不拦：' + a, !perms.isSchoolOnly(a))
      ok('登录动作列在 LOGIN_ANY 里：' + a, perms.LOGIN_ANY.indexOf(a) > -1)
    })

    ;['getDashboard', 'saveCustomTask', 'toggleTask', 'addReminder', 'loginPhone'].forEach((a) =>
      ok('访客可用：' + a, !perms.isSchoolOnly(a))
    )

    const dup = perms.SCHOOL_ONLY.filter((a) => perms.GUEST_OK.indexOf(a) > -1)
    eq('两份清单纯净不重叠', dup, [])
    eq('LOGIN_ANY 不重复', perms.LOGIN_ANY.length, Array.from(new Set(perms.LOGIN_ANY)).length)
  }

  /* ================================================================== */
  /* 三、前端本机身份                                                   */
  /* ================================================================== */
  console.log('\n【前端：本机身份】')
  {
    AUTH.clear()
    eq('默认是学校身份', AUTH.get().role, 'school')
    eq('默认不是访客', AUTH.isGuest(), false)

    AUTH.save({ role: 'guest', phone: '138****8000', nickname: '小明' })
    eq('存得住角色', AUTH.get().role, 'guest')
    eq('isGuest 认得', AUTH.isGuest(), true)
    eq('标签', AUTH.label(), '访客')
    eq('头像字取昵称首字', AUTH.initial(), '小')
    ok('说明里有手机号', AUTH.describe().indexOf('138****8000') > -1, AUTH.describe())

    // 只改一部分字段，别的不能被清空
    AUTH.save({ nickname: '小红' })
    eq('部分更新不清空手机号', AUTH.get().phone, '138****8000')
    eq('新昵称生效', AUTH.get().nickname, '小红')

    AUTH.save({ role: 'school', username: '202515020339' })
    eq('切回学校身份', AUTH.isGuest(), false)
    eq('学校标签', AUTH.label(), '本校')
    eq('学生头像字', AUTH.initial(), '学')
    ok('学校说明带学号', AUTH.describe().indexOf('202515020339') > -1, AUTH.describe())

    AUTH.clear()
    eq('清掉回到默认', AUTH.get().role, 'school')
    eq('清掉后手机号也没了', AUTH.get().phone, '')

    // 退出登录落的是 anonymous，不是 clear —— 后者等于又变回学校账号
    AUTH.save({ role: 'guest', phone: '138****8000', nickname: '小红' })
    AUTH.save({ role: 'anonymous' })
    eq('退出后是 anonymous', AUTH.get().role, 'anonymous')
    eq('anonymous 也算「不能用学校功能」', AUTH.isGuest(), true)
    eq('anonymous 不算学校身份', AUTH.isSchool(), false)
    eq('标签是「未登录」', AUTH.label(), '未登录')
    eq('头像字', AUTH.initial(), '退')
    ok('说明文案表示已退出', AUTH.describe().indexOf('已退出') > -1, AUTH.describe())
    ok('退出后不会变成 school', AUTH.get().role !== 'school')
  }

  console.log('\n----------------------------------------')
  console.log(`通过 ${pass}  失败 ${fail}`)
  process.exit(fail ? 1 : 0)
})()
