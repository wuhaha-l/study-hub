/**
 * 账号与角色（本校学生 / 其他人员）
 *
 * 为什么要这一层：小程序的天然身份只有微信 openid，学校里那套（学号、教务、
 * 学习通）全是靠 openid 间接带的。想给「不是本校的人」用，就得有一张自己的表，
 * 记下这个 openid 到底是什么身份，学校相关的功能才知道该不该给。
 *
 * 集合 users：
 *   { openid, role: 'guest' | 'school', phone, pwdHash, salt, nickname,
 *     username（本校的学号）, createdAt, lastLoginAt, failCount, lockUntil }
 *
 * 安全约定：
 *   1. 密码只存 sha256(salt + 密码 + PEPPER)，不存明文，也不返回给前端；
 *   2. 对外只给 publicProfile（手机号打码），pwdHash / salt 绝不出库；
 *   3. 连错 5 次锁 10 分钟，避免有人拿字典在云端刷手机号。
 * 注意：这里没有短信验证码，手机号是否真实归属无法证明——这是刻意的取舍
 * （发短信要接第三方服务、按条计费、还得报备模板），所以密码必须自己记住。
 */
const crypto = require('crypto')
const cloud = require('wx-server-sdk')

// 固定 pepper：即使数据库整个被拖走，没有源码也算不出密码
const PEPPER = 'studyhub::zzu::v1::7f3a'
const USERS = 'users'

const MAX_FAIL = 5
const LOCK_MS = 10 * 60 * 1000

/**
 * 懒加载数据库句柄：不能在模块顶层 cloud.database()，
 * 那时 cloud.init() 还没跑，会抛 "Cloud API isn't enabled"（-504002）。
 */
let _db = null
function db() {
  if (!_db) _db = cloud.database()
  return _db
}

/** 测试用：塞一个假数据库进来 */
function _setDb(d) {
  _db = d
}

/* ---------------- 纯函数（好测） ---------------- */

/** 手机号规范化：去掉 +86、空格、连字符 */
function normPhone(v) {
  let s = String(v === undefined || v === null ? '' : v).trim()
  s = s.replace(/[\s-]/g, '')
  if (s.indexOf('+86') === 0) s = s.slice(3)
  else if (/^0086/.test(s)) s = s.slice(4)
  // 全角数字转半角（从别处粘过来常见），再只留数字
  s = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  s = s.replace(/[^\d]/g, '')
  return s
}

function validPhone(v) {
  return /^1[3-9]\d{9}$/.test(normPhone(v))
}

function validPwd(v) {
  const s = String(v === undefined || v === null ? '' : v)
  return s.length >= 6 && s.length <= 32
}

function maskPhone(v) {
  const s = normPhone(v)
  if (s.length !== 11) return s ? s.slice(0, 3) + '****' : ''
  return s.slice(0, 3) + '****' + s.slice(7)
}

function makeSalt() {
  return crypto.randomBytes(16).toString('hex')
}

function hashPwd(password, salt) {
  return crypto
    .createHash('sha256')
    .update(String(salt) + '|' + String(password) + '|' + PEPPER)
    .digest('hex')
}

/** 昵称：去首尾空格，最多 12 个字，空了就用手机号后四位 */
function normNickname(v, phone) {
  const s = String(v === undefined || v === null ? '' : v).trim()
  if (s) return s.slice(0, 12)
  const p = normPhone(phone)
  return p.length === 11 ? '用户' + p.slice(7) : '新用户'
}

/** 出库前抹掉敏感字段 */
function roleOfDoc(u) {
  if (!u) return 'school'
  if (u.loggedOut) return 'anonymous'
  return u.role === 'guest' ? 'guest' : 'school'
}

function publicProfile(u) {
  if (!u) return null
  return {
    role: roleOfDoc(u),
    phone: u.phone ? maskPhone(u.phone) : '',
    nickname: u.nickname || '',
    username: u.username || '',
    createdAt: Number(u.createdAt) || 0
  }
}

/* ---------------- 数据库 ---------------- */

/** 集合不存在时（第一次用）自动建一张，省得让人去控制台点 */
async function withCollection(fn) {
  try {
    return await fn()
  } catch (e) {
    const msg = String((e && e.message) || '') + String((e && e.errMsg) || '')
    const missing = msg.indexOf('not exist') > -1 || msg.indexOf('collection not exists') > -1
    if (!missing) throw e
    try {
      await db().createCollection(USERS)
    } catch (e2) {
      // 并发时另一个人已经建了，忽略
    }
    return await fn()
  }
}

async function findById(id) {
  try {
    const res = await db().collection(USERS).doc(id).get()
    return res.data || null
  } catch (e) {
    return null
  }
}

/** 这个微信绑定的账号（可能一条都没有） */
async function findByOpenid(openid) {
  if (!openid) return null
  try {
    const res = await db().collection(USERS).where({ openid }).limit(5).get()
    const list = res.data || []
    if (!list.length) return null
    // 正常只会有一条；万一有多条，取最近登录的那条
    list.sort((a, b) => (Number(b.lastLoginAt) || 0) - (Number(a.lastLoginAt) || 0))
    return list[0]
  } catch (e) {
    const msg = String((e && e.message) || '')
    if (msg.indexOf('not exist') > -1) return null
    throw e
  }
}

async function findByPhone(phone) {
  const p = normPhone(phone)
  if (!p) return null
  try {
    const res = await db().collection(USERS).where({ phone: p }).limit(1).get()
    return (res.data && res.data[0]) || null
  } catch (e) {
    const msg = String((e && e.message) || '')
    if (msg.indexOf('not exist') > -1) return null
    throw e
  }
}

async function update(id, data) {
  await db()
    .collection(USERS)
    .doc(id)
    .update({ data: data })
}

async function remove(id) {
  try {
    await db().collection(USERS).doc(id).remove()
  } catch (e) {
    /* 没有就算了 */
  }
}

async function insert(doc) {
  return withCollection(async () => {
    const res = await db().collection(USERS).add({ data: doc })
    return res._id
  })
}

/* ---------------- 角色 ---------------- */

/**
 * 'guest' | 'school'
 *
 * 没有记录的老用户一律算 school：他们本来就是拿学号登录进来的，
 * 不能因为加了这张表就被拦在门外。
 */
async function roleOf(openid) {
  return roleOfDoc(await findByOpenid(openid))
}

async function isGuest(openid) {
  return (await roleOf(openid)) === 'guest'
}

/** 已退出的访客：既不是访客也不能当学校账号用 */
async function isAnonymous(openid) {
  return (await roleOf(openid)) === 'anonymous'
}

/* ---------------- 数据归属键（owner key） ---------------- */

/**
 * 业务数据（账号 / 任务 / 提醒额度）都按这个键隔离，**不是**按 openid。
 *
 * 为什么必须多这一层：小程序只有一个 openid。同一个微信先登学校账号、
 * 再切到访客，openid 一模一样——只按 openid 查，访客会把学校账号同步下来的
 * 任务、绑定的平台账号照单全收。这就是「游客登进去看到学校数据」的根。
 *
 * 规则：
 *   学校账号 → 裸 openid（存量数据本来就是它，一行都不用迁）
 *   访客     → 'g::' + openid（天然落在一片空白里，什么都查不到）
 *
 * 换来两个好处：老用户零迁移；访客退出再进来，自己的任务还在（openid 没变，
 * 前缀也没变），但换成学校身份又回到学校那份数据，两边互不污染。
 */
const GUEST_NS = 'g::'

function ownerOf(openid, role) {
  const id = String(openid || '')
  // 只有明确的 school 才用裸 openid；guest 和 anonymous（已退出的访客）都落到访客命名空间，
  // 这样退出登录再登回来，自己建的任务还在，而学校那份数据碰不到
  return role === 'school' ? id : GUEST_NS + id
}

function isGuestOwner(owner) {
  return String(owner || '').indexOf(GUEST_NS) === 0
}

/** 反推真 openid（只有定时任务发订阅消息时才需要） */
function openidOfOwner(owner) {
  const s = String(owner || '')
  return isGuestOwner(s) ? s.slice(GUEST_NS.length) : s
}

async function profile(openid) {
  const u = await findByOpenid(openid)
  if (!u) return { role: 'school', phone: '', nickname: '', username: '', createdAt: 0 }
  return publicProfile(u)
}

/* ---------------- 注册 / 登录 ---------------- */

/**
 * 手机号注册（访客身份）。
 * 同一个微信只能有一个身份：如果之前登过别的手机号，直接换成这次这个。
 */
async function register(opts) {
  const o = opts || {}
  const openid = String(o.openid || '')
  if (!openid) throw new Error('无法识别用户身份')

  const phone = normPhone(o.phone)
  if (!validPhone(phone)) throw new Error('手机号格式不对，请填 11 位手机号')
  if (!validPwd(o.password)) throw new Error('密码至少 6 位，最多 32 位')

  const samePhone = await findByPhone(phone)
  if (samePhone) {
    if (samePhone.openid === openid) {
      throw new Error('这个手机号已经注册过了，直接登录就行')
    }
    throw new Error('这个手机号已注册，请直接用密码登录')
  }

  const mine = await findByOpenid(openid)
  if (mine && !mine.loggedOut) {
    // 注册不做「覆盖」：一个微信就一个身份，注册过就直接登录，
    // 免得手抖输错手机号把原来的号顶掉
    throw new Error(
      mine.role === 'school'
        ? '当前微信已绑定学校账号，不能再注册访客'
        : '这个微信已经注册过了，直接登录就行'
    )
  }

  const now = Date.now()
  const salt = makeSalt()
  const id = await insert({
    openid: openid,
    role: 'guest',
    phone: phone,
    pwdHash: hashPwd(o.password, salt),
    salt: salt,
    nickname: normNickname(o.nickname, phone),
    username: '',
    createdAt: now,
    lastLoginAt: now,
    failCount: 0,
    lockUntil: 0
  })

  const u = await findById(id)
  return publicProfile(u)
}

/**
 * 手机号 + 密码登录。
 * 登录成功会把这条记录绑到当前微信上（换手机登录，旧手机自然就失效了）。
 */
async function login(opts) {
  const o = opts || {}
  const openid = String(o.openid || '')
  if (!openid) throw new Error('无法识别用户身份')

  const phone = normPhone(o.phone)
  if (!validPhone(phone)) throw new Error('手机号格式不对，请填 11 位手机号')
  if (!String(o.password || '')) throw new Error('请填密码')

  // 当前微信已经绑着学校账号、且还没退出：不许再登访客，否则自己那条
  // school 记录会被删掉，用户会莫名其妙失去课表和同步。
  // 已经退出的（loggedOut 置位，roleOf 是 anonymous）就放行——那才是
  // 「退出学校账号后改登游客」的正常路径。
  const mine = await findByOpenid(openid)
  if (mine && mine.role === 'school' && !mine.loggedOut) {
    throw new Error('当前微信已绑定学校账号，想用访客身份请先退出登录')
  }

  const u = await findByPhone(phone)
  if (!u) throw new Error('这个手机号还没注册，先注册一个')

  const now = Date.now()
  if (Number(u.lockUntil) > now) {
    const min = Math.ceil((Number(u.lockUntil) - now) / 60000)
    throw new Error('密码错太多次，请 ' + min + ' 分钟后再试')
  }

  if (u.role === 'school') {
    throw new Error('这个手机号属于学校账号，请用学号登录')
  }

  if (hashPwd(o.password, u.salt) !== u.pwdHash) {
    const failCount = (Number(u.failCount) || 0) + 1
    const patch = { failCount: failCount }
    if (failCount >= MAX_FAIL) {
      patch.lockUntil = now + LOCK_MS
      patch.failCount = 0
      await update(u._id, patch)
      throw new Error('密码错 ' + MAX_FAIL + ' 次，锁定 10 分钟')
    }
    await update(u._id, patch)
    throw new Error('手机号或密码不对（还可以试 ' + (MAX_FAIL - failCount) + ' 次）')
  }

  // 同一个人换了微信：把记录挪到新 openid 上
  if (u.openid !== openid) {
    // 当前微信上可能还挂着另一个访客号（之前登录过没退）
    if (mine && mine._id !== u._id) {
      if (!mine.loggedOut) {
        throw new Error(
          '当前微信还登录着另一个访客账号（' + maskPhone(mine.phone) + '），先在首页退出再登录这个号'
        )
      }
      // 已退出的旧号：只解绑 openid，记录留着，以后还能登回来
      await update(mine._id, { openid: '' })
    }
    await update(u._id, { openid: openid })
  }
  // 走到这里说明密码对了，顺手把「已退出」标记清掉：
  // 就算上次退出时网络断了、云端没收到，这里也能自动恢复，不会把人卡死
  await update(u._id, { failCount: 0, lockUntil: 0, lastLoginAt: now, loggedOut: false })

  const fresh = await findById(u._id)
  return publicProfile(fresh || Object.assign({}, u, { openid: openid }))
}

/**
 * 本校学生登录成功后打个标（顺便记学号）。
 * 已经是访客的微信不允许升级——不然「访客」这道门就形同虚设。
 */
async function markSchool(opts) {
  const o = opts || {}
  const openid = String(o.openid || '')
  if (!openid) throw new Error('无法识别用户身份')

  const username = String(o.username || '').slice(0, 32)
  const now = Date.now()
  const mine = await findByOpenid(openid)

  /**
   * 访客直接换成学校账号。
   *
   * 这里以前是直接拒绝（要求先退出），结果很多人卡在「访客退不掉、学校又登不进」。
   * 统一认证已经过了，人是对的，没必要再设一道门。
   *
   * 但也不能把那条访客记录改成 school：手机号 + 密码哈希是它的全部，一改，
   * 这个手机号就永远登不回来了。做法是另写一条 school 记录，再把访客记录
   * 解绑留着（openid 置空），以后用手机号还能登回自己那份访客数据。
   */
  if (mine && mine.role === 'guest') {
    const id = await insert({
      openid: openid,
      role: 'school',
      phone: '',
      pwdHash: '',
      salt: '',
      nickname: '',
      username: username,
      createdAt: now,
      lastLoginAt: now,
      failCount: 0,
      lockUntil: 0
    })
    await update(mine._id, { openid: '', loggedOut: true })
    return publicProfile(await findById(id))
  }

  if (mine) {
    await update(mine._id, {
      role: 'school',
      username: username,
      loggedOut: false,
      lastLoginAt: now
    })
    return publicProfile(Object.assign({}, mine, { role: 'school', username: username }))
  }

  const id = await insert({
    openid: openid,
    role: 'school',
    phone: '',
    pwdHash: '',
    salt: '',
    nickname: '',
    username: username,
    createdAt: now,
    lastLoginAt: now,
    failCount: 0,
    lockUntil: 0
  })
  return publicProfile(await findById(id))
}

/**
 * 退出登录。
 *
 * 访客必须**解绑**：不然这条 guest 记录一直挂在 openid 上，
 * 用户想换回学校账号时会被 markSchool 挡住（「当前微信是访客身份」），
 * 就卡死了。
 *
 * 解绑只是把 openid 抹掉，**记录留着**——手机号和密码哈希还在，
 * 下次拿同一个手机号 + 密码照样能登回来；删整条的话号码就再也用不了了。
 * 学校记录不动（学号留着，下次登录不用重填）。
 */
/**
 * 访客退出。
 *
 * 不能把 openid 解绑掉：解绑后 findByOpenid 就查不到这条记录了，roleOf 会按
 * 「查不到 = 老用户」返回 school —— 于是刚退出的访客反而以学校身份读到了学校数据。
 * 改成保留记录、只打 loggedOut 标记，角色变成 anonymous：
 * 学校功能一律挡住，数据仍落在访客命名空间，重新登录后原样回来。
 */
async function logout(openid) {
  const u = await findByOpenid(openid)
  if (!u) return { ok: true }
  // 学校账号退出也要打 loggedOut：否则这条 school 记录一直挂在 openid 上，
  // roleOf 永远是 school，用户退掉学校账号后想登游客会被
  // 「当前微信已绑定学校账号，请先退出」永远挡住（死循环）。
  // 打标后 roleOfDoc 返回 anonymous，游客登录/注册就能放行；
  // 学校记录本身不动，下次拿学号重新登录 markSchool 会把标清掉。
  await update(u._id, { loggedOut: true, lastLoginAt: Date.now() })
  return { ok: true }
}

module.exports = {
  USERS,
  MAX_FAIL,
  LOCK_MS,
  _setDb,
  normPhone,
  validPhone,
  validPwd,
  maskPhone,
  normNickname,
  hashPwd,
  makeSalt,
  publicProfile,
  roleOf,
  roleOfDoc,
  isGuest,
  isAnonymous,
  GUEST_NS,
  ownerOf,
  isGuestOwner,
  openidOfOwner,
  profile,
  findByOpenid,
  findByPhone,
  register,
  login,
  markSchool,
  logout
}
