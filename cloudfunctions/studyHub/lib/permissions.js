/**
 * 学校账户相关功能的清单 —— 只此一份。
 *
 * 云端拿它做拦截（访客调这些一律 403），测试也拿它核对，
 * 避免「前端藏了、云端忘了」这种半吊子权限。
 *
 * 判断标准：**这个功能是否必须用到学号 / 学校系统**。
 *   要 → school 专属（课表从教务导入、各学习平台绑定与同步、郑大统一认证）
 *   不要 → 访客也能用（记事本、专注、手动课表、手动待办、订阅提醒）
 */
/**
 * 登录动作：所有身份都放行。
 *
 * 这两个是「证明你是学校的人」这一步本身，不含任何学校数据——
 * 不查账号、不读课表、不碰 zzu_sessions，只是把学号密码交给统一认证。
 * 认证通过后云端会顺手把身份改成 school（见 index.js 的 zzuAuto）。
 *
 * 为什么不能让访客调不通：访客想换成学校账号，第一步就是登录；
 * 如果这里 403，用户看到的是「访客账号只能用记事本」，永远登不进学校账号，
 * 而访客又退不出去，就成了死结。
 */
const LOGIN_ANY = ['zzuAuto', 'zzuMfaVerify']

/** 剩下的学校专属功能（访客一律 403） */
const SCHOOL_ONLY = [
  // 各学习平台的账号绑定 / 抓取 / 扫码
  'saveAccount',
  'deleteAccount',
  'syncTasks',
  'testAccount',
  'pushTasks',
  'qrStart',
  'qrPoll',
  'cxSelfTest',
  'cxWorkDiag',
  // 郑大统一认证 → 门户课表（CAS / CASTGC / 短信二次验证）
  'zzuProbe',
  'zzuSchedule',
  'zzuTableDebug',
  'zzuStatus',
  'zzuLogout'
]

/** 访客能用的功能（写在这里是为了让边界一眼可见，不参与拦截） */
const GUEST_OK = [
  'getDashboard', // 访客也能有自己建的任务
  'saveCustomTask',
  'toggleTask',
  'deleteTask',
  'setTaskReminder',
  'addReminder',
  'getReminder',
  'registerPhone',
  'loginPhone',
  'whoami',
  'markSchool',
  'logoutAccount',
  'platforms' // 只是把平台名字列出来给前端建卡片，不含账号数据
]

function isSchoolOnly(action) {
  return SCHOOL_ONLY.indexOf(String(action || '')) > -1
}

module.exports = {
  LOGIN_ANY,
  SCHOOL_ONLY,
  GUEST_OK,
  isSchoolOnly
}
