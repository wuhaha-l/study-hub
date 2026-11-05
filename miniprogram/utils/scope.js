/**
 * 本机数据的归属命名空间
 *
 * 云端那层用 users.ownerOf() 隔离，本机这层也得隔离一次——课表、便签、番茄
 * 都存在 wx.setStorageSync 里，只有一份。同一个微信切成访客后，如果键不变，
 * 访客会直接看到学校账号的课表、便签和番茄记录（和云端那个 bug 是同一个道理）。
 *
 * 规则和云端保持一致：
 *   学校账号 → 原键名（'timetable_v1'），存量数据一行都不用迁
 *   访客 / 已退出 → 加 'g::' 前缀（'g::timetable_v1'），天然空白一片
 *
 * 用法：把原来的 `const KEY = 'notes_v1'` 改成 `S.key('notes_v1')`，
 * **每次读写都算一次**——身份会变，别在模块顶层算好存成常量。
 */
const AUTH = require('./auth.js')

const NS = 'g::'

/** 当前身份要不要单独一份本机数据 */
function isScoped() {
  return AUTH.get().role !== 'school'
}

/** 把逻辑键名换成本次身份真正用的存储键 */
function key(name) {
  const k = String(name || '')
  return isScoped() ? NS + k : k
}

/** 把某个命名空间下的键清空（访客退出时用，避免残留） */
function clearGuest() {
  const info = wx.getStorageInfoSync ? wx.getStorageInfoSync() : { keys: [] }
  ;(info.keys || []).forEach((k) => {
    if (String(k).indexOf(NS) === 0) {
      try {
        wx.removeStorageSync(k)
      } catch (e) {
        /* ignore */
      }
    }
  })
}

module.exports = {
  NS,
  key,
  isScoped,
  clearGuest
}
