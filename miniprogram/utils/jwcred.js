/**
 * 教务系统登录凭据（只存手机本地）。
 *
 * 存什么：学校、学号、密码。
 * 存哪：wx.setStorageSync，只在这台手机上，**不上传云端**。
 * 传哪儿：只在点「登录并导入」时传给本机局域网里的 localserver，
 *         代理拿到就当次用完丢掉，不写磁盘。所以密码不会留在电脑上。
 *
 * 这里的 mask/unmask 不是加密 —— 小程序沙箱已经很隔离了，
 * 它只是避免密码明晃晃躺在 storage 里被截图 / 调试面板一眼看穿。
 */

const KEY = 'jw_cred_v1'

/** 目前只支持郑大；留 schools 结构，后面加别的学校改这里就行 */
const SCHOOLS = [
  { id: 'zzu', name: '郑州大学', base: 'https://jw.v.zzu.edu.cn', note: 'EAMS · 需校园网' }
]

const XOR = 'studyhub-jw'

function mask(s) {
  const src = String(s || '')
  let out = ''
  for (let i = 0; i < src.length; i++) {
    out += String.fromCharCode(src.charCodeAt(i) ^ XOR.charCodeAt(i % XOR.length))
  }
  // 转成 base64 时要先转 latin1，否则中文/高位字符会炸
  try {
    return wx.arrayBufferToBase64
      ? wx.arrayBufferToBase64(new Uint8Array(Array.from(out).map((c) => c.charCodeAt(0) & 0xff)).buffer)
      : out
  } catch (e) {
    return out
  }
}

function unmask(s) {
  const raw = String(s || '')
  let buf = raw
  try {
    if (wx.base64ToArrayBuffer) {
      const arr = new Uint8Array(wx.base64ToArrayBuffer(raw))
      let str = ''
      for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i])
      buf = str
    }
  } catch (e) {
    buf = raw
  }
  let out = ''
  for (let i = 0; i < buf.length; i++) {
    out += String.fromCharCode(buf.charCodeAt(i) ^ XOR.charCodeAt(i % XOR.length))
  }
  return out
}

function schoolOf(id) {
  return SCHOOLS.find((x) => x.id === id) || SCHOOLS[0]
}

function get() {
  let raw = null
  try {
    raw = wx.getStorageSync(KEY) || null
  } catch (e) {
    raw = null
  }
  if (!raw || typeof raw !== 'object') {
    return { schoolId: SCHOOLS[0].id, base: SCHOOLS[0].base, username: '', password: '', saved: false }
  }
  const sch = schoolOf(raw.schoolId)
  return {
    schoolId: raw.schoolId || SCHOOLS[0].id,
    base: raw.base || sch.base,
    username: raw.username || '',
    password: unmask(raw.pw),
    saved: !!raw.username
  }
}

function save(cred) {
  const c = cred || {}
  const sch = schoolOf(c.schoolId)
  const payload = {
    schoolId: sch.id,
    base: String(c.base || sch.base).replace(/\/+$/, ''),
    username: String(c.username || '').trim(),
    pw: mask(c.password || ''),
    at: Date.now()
  }
  try {
    wx.setStorageSync(KEY, payload)
  } catch (e) {
    /* 存不下就算了，本次还能用 */
  }
  return payload
}

function clear() {
  try {
    wx.removeStorageSync(KEY)
  } catch (e) {
    /* ignore */
  }
}

module.exports = { SCHOOLS, schoolOf, get, save, clear, KEY }
