/**
 * 身份（本机记录）
 *
 * 小程序天然只有微信 openid，看不出这个人是本校学生还是外人。
 * 云端 users 集合才是权威，这里存一份只为了两件事：
 *   1. 首页/账号页不用每次都等网络就知道该显示哪些入口；
 *   2. 冷启动时判断有没有登过（和 app_registered_v1 配套）。
 *
 * role:
 *   'school' 本校学生：学号登录，课表、平台任务、同步全都能用
 *   'guest'  其他人员：手机号注册，只能用记事本、专注、手动课表和手动待办
 */
const KEY = 'auth_v1'

/**
 * 身份只有三种：
 *   school    本校学生：学号登录，一切功能
 *   guest     访客：手机号注册，只有记事本 / 专注 / 手动课表
 *   anonymous 已经退出登录的访客：比访客更受限，学校功能一律挡住
 *
 * 为什么要有 anonymous：云端认出「这个微信注册过访客但已退出」之后不能把他
 * 当成本校学生（那会把学校那份数据放出来），也不能当访客（他已经退了）。
 * 不确定的、认不出的，一律按 school 处理——老用户不能被关在门外。
 */
function normRole(v) {
  if (v === 'guest' || v === 'anonymous') return v
  return 'school'
}

function get() {
  let raw = null
  try {
    raw = wx.getStorageSync(KEY)
  } catch (e) {
    raw = null
  }
  const o = raw && typeof raw === 'object' ? raw : {}
  return {
    role: normRole(o.role),
    // 只存掩码，本机不留手机号明文
    phone: String(o.phone || ''),
    nickname: String(o.nickname || ''),
    username: String(o.username || ''),
    since: Number(o.since) || 0
  }
}

function save(patch) {
  const next = Object.assign({}, get(), patch || {})
  const clean = {
    role: normRole(next.role),
    phone: String(next.phone || ''),
    nickname: String(next.nickname || ''),
    username: String(next.username || ''),
    since: Number(next.since) || Date.now()
  }
  try {
    wx.setStorageSync(KEY, clean)
  } catch (e) {
    /* ignore */
  }
  return clean
}

function clear() {
  try {
    wx.removeStorageSync(KEY)
  } catch (e) {
    /* ignore */
  }
}

/**
 * 「不能用学校功能」= 不是 school。
 * guest 和 anonymous 都算——前端靠它决定藏哪些入口，别只判 === 'guest'，
 * 否则退出登录那一瞬间会漏出学校入口。
 */
function isGuest() {
  return get().role !== 'school'
}

function isSchool() {
  return get().role === 'school'
}

function isAnonymous() {
  return get().role === 'anonymous'
}

/** 顶在名字旁边的那个小标签 */
function label() {
  if (isAnonymous()) return '未登录'
  return isGuest() ? '访客' : '本校'
}

/** 一行说明：「138****8000 · 访客，仅记事本 / 专注 / 手动课表」 */
function describe() {
  const a = get()
  if (a.role === 'anonymous') return '已退出登录，重新登录后继续用'
  if (a.role === 'guest') {
    return (a.phone || '访客') + ' · 访客身份，只能用记事本、专注和手动课表'
  }
  return a.username ? '学号 ' + a.username : '本校学生'
}

/** 头像位上那个字：访客取昵称首字，学生取「学」 */
function initial() {
  const a = get()
  if (a.role === 'anonymous') return '退'
  if (a.role === 'guest') {
    const n = a.nickname || ''
    return n ? n.slice(0, 1) : '访'
  }
  return '学'
}

module.exports = {
  KEY,
  normRole,
  get,
  save,
  clear,
  isGuest,
  isSchool,
  isAnonymous,
  label,
  describe,
  initial
}
