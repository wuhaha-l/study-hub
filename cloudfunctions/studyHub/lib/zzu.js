/**
 * 郑州大学统一身份认证（APP /token/ API）→ 综合信息门户 → 课表  【云端版】
 *
 * 2026-10-24 大改版：整个登录通道从「网页版 CAS」换到「郑大 APP 的 /token/ API」。
 * 换的原因：
 *   - 网页版强制短信二次验证、会话靠 CASTGC（14 天），而且网页 ticket 塞给门户
 *     API 会直接被拒（「无效token」，门户是 Sa-Token，认的是 APP 下发的 idToken）。
 *   - APP 的 /token/ API 是纯 JSON 协议：passwordLogin 直接返回 idToken（约一个月
 *     有效）+ refreshToken（约两个月），短信二次验证的信任绑定在 deviceId 上，
 *     验证过一次之后，同一 deviceId 再登录就不再要验证码。
 *
 * 协议来源：开源项目 Illustar0/ZZU.Py（苏亚星 SuperApp 抓包逆向），逐条核对过：
 *   GET  .../token/jwt/publicKey                       → RSA 公钥（UA okhttp/3.12.1）
 *   POST .../token/mfa/detect
 *          ?username=<__RSA__加密账号>&password=<__RSA__加密密码>&deviceId=<设备号>
 *          → {code:0, data:{state, need, mfaTypeSecurePhone}}     （UA SWSuperApp/1.1.1()）
 *   GET  .../token/mfa/initByType/securephone?state=<state>
 *          → {code:0, data:{gid, attestServerUrl, securePhone?}}
 *   POST {attest}/api/guard/securephone/send   JSON {gid}
 *   POST {attest}/api/guard/securephone/valid  JSON {gid, code} → data.status===2 才算过
 *   POST .../token/password/passwordLogin
 *          ?username=<__RSA__>&password=<__RSA__>&appId=com.supwisdom.zzu&osType=android
 *          &geo=&deviceId=<设备号>&clientId=&mfaState=<state>      （空 body，POST）
 *          → {code:0, data:{idToken, refreshToken}}
 *   课表数据源（2026-10-24 定稿）：不走门户聚合接口（字段无文档、之前解析不出），
 *   直接走「新本科教务系统」eams-micro-server（jwxt.zzu.edu.cn，公网可达）：
 *     GET .../eams-micro-server/api/v1/semester/current-semester
 *     GET .../eams-micro-server/api/v1/lesson/student/course-table/<学期号>
 *       认证：Authorization: <idToken> + cookie userToken=<idToken>
 *       返回 {result:0, data:[{course:{nameZh}, schedules:[{date, weekday,
 *         startUnit, endUnit, weekIndex, room:{nameZh}, teacherName}]}]}
 *
 * 两个加密细节（和网页版不同，别混）：
 *   - 账号和密码都要 RSA 加密。填充方式是学校服务端规定的 PKCS#1 v1.5
 *     （JSEncrypt 兼容格式），不能换 OAEP —— 换了解密不了；而且我们只用公钥
 *     加密、从不持有私钥解密，不存在 padding oracle 的暴露面。
 *   - detect / passwordLogin 的参数全在 query string 上，POST body 为空。
 *
 * 云函数无状态，中间态靠 zzu_sessions 按 openid 接力：
 *   - deviceId：首次登录生成后固定（MFA 信任绑它，绝不能每次换新的）
 *   - appToken/appRefresh：idToken/refreshToken，SECRET 加密落库
 *   - 等短信期间：mfaState/mfaGid/mfaAttest + 双层加密的账号密码密文（10 分钟 TTL）
 */

const crypto = require('crypto')
const cloud = require('wx-server-sdk')

const HTTP = require('./http')
const secret = require('./secret')

const CAS_BASE = 'https://cas.s.zzu.edu.cn'
const PORTAL_BASE = 'https://info.s.zzu.edu.cn'
const PORTAL_API = PORTAL_BASE + '/portal-api/'

/** APP 客户端标识（苏亚星 SuperApp，服务端按 UA 区分通道） */
const APP_UA = 'SWSuperApp/1.1.1()'
const APP_ID = 'com.supwisdom.zzu'
const OS_TYPE = 'android'

/** 会话落在哪个集合 */
const COLL = 'zzu_sessions'

/** 短信接力态的有效窗口 */
const FORM_TTL = 10 * 60 * 1000

/** 郑大作息：钟点 → 节次。遇到只给时间的日程，用它换算 */
const PERIODS = [
  { p: 1, from: '08:00', to: '08:45' },
  { p: 2, from: '08:55', to: '09:40' },
  { p: 3, from: '10:00', to: '10:45' },
  { p: 4, from: '10:55', to: '11:40' },
  { p: 5, from: '14:00', to: '14:45' },
  { p: 6, from: '14:55', to: '15:40' },
  { p: 7, from: '16:00', to: '16:45' },
  { p: 8, from: '16:55', to: '17:40' },
  { p: 9, from: '19:00', to: '19:45' },
  { p: 10, from: '19:55', to: '20:40' },
  { p: 11, from: '20:50', to: '21:35' },
  { p: 12, from: '21:45', to: '22:30' }
]

/* ------------------------------------------------------------------ */
/* 数据库（懒加载，不能放模块顶层，否则 cloud.init 还没跑就崩）           */
/* ------------------------------------------------------------------ */

let _db = null
function db() {
  if (!_db) _db = cloud.database()
  return _db
}

async function readDoc(openid) {
  try {
    const r = await db().collection(COLL).where({ openid }).limit(1).get()
    return (r.data && r.data[0]) || null
  } catch (e) {
    // 集合还没建过，当成没有会话；写的时候会自动建
    return null
  }
}

/** 把库里的文档还原成可用的会话状态 */
function state(doc) {
  const out = {
    doc: doc,
    deviceId: '',
    appToken: '',
    appRefresh: '',
    appTokenAt: 0,
    name: '',
    org: '',
    // 二次验证（MFA）接力字段：detect 之后到 valid 之间的中间态
    mfaState: '',
    mfaGid: '',
    mfaAttest: '',
    mfaPhone: '',
    mfaPass: '',
    mfaUser: '',
    formAt: 0
  }
  if (!doc) return out

  const dec = (v) => {
    if (!v) return ''
    try {
      return secret.decrypt(v)
    } catch (e) {
      // SECRET 被改过 / 数据损坏：当作没登录，让它重新登一次，别把功能卡死
      return ''
    }
  }

  out.deviceId = doc.deviceId || ''
  out.appToken = dec(doc.appToken)
  out.appRefresh = dec(doc.appRefresh)
  out.appTokenAt = Number(doc.appTokenAt) || 0
  out.name = doc.name || ''
  out.org = doc.org || ''
  out.mfaState = doc.mfaState || ''
  out.mfaGid = dec(doc.mfaGid)
  out.mfaAttest = doc.mfaAttest || ''
  out.mfaPhone = doc.mfaPhone || ''
  out.mfaPass = dec(doc.mfaPass)
  out.mfaUser = doc.mfaUser || ''
  out.formAt = Number(doc.formAt) || 0
  out.lastTableSummary = doc.lastTableSummary || null
  return out
}

/** 手机号打码：只留前 3 后 4，别把完整号码存库里 */
function maskPhone(s) {
  const t = String(s || '').trim()
  const m = t.match(/^(\d{3})\d*(\d{4})$/)
  if (m) return m[1] + '****' + m[2]
  return t || ''
}

async function save(openid, patch) {
  const now = Date.now()
  const data = Object.assign({}, patch, { updatedAt: now })

  const exist = await readDoc(openid)
  if (exist) {
    await db()
      .collection(COLL)
      .doc(exist._id)
      .update({ data })
    return exist._id
  }
  try {
    const r = await db()
      .collection(COLL)
      .add({ data: Object.assign({ openid, createdAt: now }, data) })
    return r._id
  } catch (e) {
    // 首次使用时集合不存在：建一个再写，省掉手动去控制台点一遍
    try {
      await db().createCollection(COLL)
    } catch (e2) {
      /* 已存在就忽略 */
    }
    const r = await db()
      .collection(COLL)
      .add({ data: Object.assign({ openid, createdAt: now }, data) })
    return r._id
  }
}

async function clear(openid) {
  const exist = await readDoc(openid)
  if (exist) {
    await db()
      .collection(COLL)
      .doc(exist._id)
      .remove()
      .catch(() => null)
  }
  return true
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** RSA 加密密码，和浏览器里 JSEncrypt 的行为一致：PKCS#1 v1.5 + base64 */
function rsaEncrypt(plain, publicKeyPem) {
  return crypto
    .publicEncrypt(
      { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(String(plain), 'utf8')
    )
    .toString('base64')
}

/** JWT 中间段解出来（不验签，只为了读 idToken / 身份 / 学校） */
function jwtPayload(token) {
  const parts = String(token || '').split('.')
  if (parts.length < 2) return null
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    return JSON.parse(Buffer.from(pad, 'base64').toString('utf8'))
  } catch (e) {
    return null
  }
}

/** APP 协议的加密格式：__RSA__ 前缀 + base64 密文 */
function rsaWrap(plain, pem) {
  return '__RSA__' + rsaEncrypt(plain, pem)
}

/** idToken 是否已过期（exp 是秒级时间戳；读不出来视为过期，宁可让人重登） */
function tokenExpired(token) {
  const payload = jwtPayload(token)
  if (!payload || !payload.exp) return true
  return payload.exp * 1000 <= Date.now()
}

/** 取一张稳定的设备号：MFA 信任绑在它上面，同一用户必须一直用同一个 */
function deviceIdOf(st) {
  return st.deviceId || 'zzu-mini-' + crypto.randomBytes(12).toString('hex')
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch (e) {
    return null
  }
}

/** CAS_BASE + 相对路径（避免手拼字符串） */
function casUrl(path) {
  return new URL(path, CAS_BASE + '/').toString()
}

/** attest 服务地址 + 相对路径（attest 基址来自服务端下发） */
function attestUrl(base, path) {
  const b = String(base || CAS_BASE + '/attest').replace(/\/+$/, '')
  return new URL(path, b + '/').toString()
}

/* ------------------------------------------------------------------ */
/* APP /token/ 协议                                                    */
/* ------------------------------------------------------------------ */

/** 拿 RSA 公钥（APP 通道；UA 要装成 okhttp，网页那个 UA 服务端不认） */
async function appGetPublicKey() {
  const r = await HTTP.request(casUrl('token/jwt/publicKey'), {
    timeout: 9000,
    maxRedirect: 2,
    headers: { 'user-agent': 'okhttp/3.12.1' }
  })
  const pem = String(r.text || '').trim()
  if (!/BEGIN PUBLIC KEY/.test(pem)) {
    throw new Error('公钥格式不认识，CAS 可能改版了')
  }
  return pem
}

/**
 * MFA 探测。返回 {state, need, securePhoneOk}；失败抛错。
 * 注意：账号密码都要加密，参数在 query string 上，body 为空。
 */
async function appDetect(pem, account, password, deviceId) {
  const u = new URL(casUrl('token/mfa/detect'))
  u.searchParams.set('username', rsaWrap(account, pem))
  u.searchParams.set('password', rsaWrap(password, pem))
  u.searchParams.set('deviceId', deviceId)
  const r = await HTTP.request(u.toString(), {
    method: 'POST',
    timeout: 10000,
    maxRedirect: 0,
    headers: { 'user-agent': APP_UA }
  })
  const j = parseJson(r.text)
  if (!j || j.code !== 0 || !j.data) {
    throw new Error((j && (j.message || j.msg)) || 'detect 无返回')
  }
  return {
    state: String(j.data.state || ''),
    need: j.data.need === true,
    securePhoneOk: j.data.mfaTypeSecurePhone === true
  }
}

/** 初始化安全手机验证：拿 gid / attest 服务地址 / 打码手机号 */
async function appInitSms(stateToken) {
  const u = new URL(casUrl('token/mfa/initByType/securephone'))
  u.searchParams.set('state', stateToken)
  const r = await HTTP.request(u.toString(), {
    timeout: 9000,
    maxRedirect: 2,
    headers: { 'user-agent': APP_UA }
  })
  const j = parseJson(r.text)
  if (!j || j.code !== 0 || !j.data) {
    throw new Error((j && (j.message || j.msg)) || '安全手机初始化失败')
  }
  const attest = String(j.data.attestServerUrl || '') || casUrl('attest')
  return {
    gid: String(j.data.gid || ''),
    attestBase: attest,
    securePhone: String(j.data.securePhone || '')
  }
}

/** 让 attest 服务把短信发出去 */
async function appSendSms(attestBase, gid) {
  const r = await HTTP.request(attestUrl(attestBase, 'api/guard/securephone/send'), {
    method: 'POST',
    body: JSON.stringify({ gid }),
    timeout: 9000,
    maxRedirect: 0,
    headers: { 'content-type': 'application/json;charset=UTF-8', 'user-agent': APP_UA }
  })
  const j = parseJson(r.text)
  if (j && j.code === 0) return { ok: true }
  return { ok: false, error: (j && (j.message || j.msg)) || '服务端拒绝' }
}

/** 校验短信验证码。status===2 才算通过 */
async function appValidSms(attestBase, gid, code) {
  const r = await HTTP.request(attestUrl(attestBase, 'api/guard/securephone/valid'), {
    method: 'POST',
    body: JSON.stringify({ gid, code: String(code || '').trim() }),
    timeout: 9000,
    maxRedirect: 0,
    headers: { 'content-type': 'application/json;charset=UTF-8', 'user-agent': APP_UA }
  })
  return parseJson(r.text) || {}
}

/**
 * 密码登录（APP 通道）。账号和密码传「已经 __RSA__ 包装过的密文」——
 * mfaVerify 复用接力态里存的密文时不能再包一层（对密钥长度来说会爆）。
 * mfaState 是 detect 发的那个；MFA 验证通过后带同一个 state 重发就能拿到 token。
 * 返回 {idToken, refreshToken} 或抛错（带服务端原文）。
 */
async function appPasswordLogin(encAccount, encPassword, deviceId, mfaState) {
  const u = new URL(casUrl('token/password/passwordLogin'))
  u.searchParams.set('username', encAccount)
  u.searchParams.set('password', encPassword)
  u.searchParams.set('appId', 'com.supwisdom.zzu')
  u.searchParams.set('osType', 'android')
  u.searchParams.set('geo', '')
  u.searchParams.set('deviceId', deviceId)
  u.searchParams.set('clientId', '')
  u.searchParams.set('mfaState', mfaState || '')
  const r = await HTTP.request(u.toString(), {
    method: 'POST',
    timeout: 12000,
    maxRedirect: 0,
    headers: { 'user-agent': APP_UA }
  })
  const j = parseJson(r.text)
  if (!j) throw new Error('passwordLogin 返回的不是 JSON（HTTP ' + r.status + '）')
  if (j.code !== 0 || !j.data || !j.data.idToken) {
    throw new Error(String(j.message || j.msg || '登录被拒绝'))
  }
  return { idToken: String(j.data.idToken), refreshToken: String(j.data.refreshToken || '') }
}

/* ------------------------------------------------------------------ */
/* 探测                                                                */
/* ------------------------------------------------------------------ */

async function probe() {
  const out = {
    casReachable: false,
    portalReachable: false,
    error: '',
    hint: ''
  }

  try {
    const r = await HTTP.request(casUrl('token/jwt/publicKey'), {
      timeout: 9000,
      maxRedirect: 2,
      headers: { 'user-agent': 'okhttp/3.12.1' }
    })
    if (r.status === 200 && /BEGIN PUBLIC KEY/.test(r.text)) {
      out.casReachable = true
    } else {
      out.error = '统一认证 token 接口返回 HTTP ' + r.status
    }
  } catch (e) {
    out.error = String((e && e.message) || e)
    out.hint = '云函数连不上统一认证，检查云开发环境是否允许出网。'
  }

  try {
    // 教务接口未带凭据时应回 401/JSON 错误 —— 只要有响应就说明公网可达
    const r = await HTTP.request(EAMS_MICRO + '/semester/current-semester', {
      timeout: 8000,
      maxRedirect: 2
    })
    out.portalReachable = r.status > 0 && r.status < 500
  } catch (e) {
    if (!out.error) out.error = String((e && e.message) || e)
  }

  if (out.casReachable && out.portalReachable) {
    out.hint = '公网可达，直接学号密码登录即可（短信验证码会发到你手机，填一次管约一个月）。'
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 登录                                                                */
/* ------------------------------------------------------------------ */

/** 登录成功后的统一收尾：token 落库、MFA 接力态清空 */
async function finishLogin(openid, deviceId, tokens, chain) {
  const payload = jwtPayload(tokens.idToken) || {}
  await save(openid, {
    deviceId,
    appToken: secret.encrypt(tokens.idToken),
    appRefresh: tokens.refreshToken ? secret.encrypt(tokens.refreshToken) : '',
    appTokenAt: Date.now(),
    name: payload.name || payload.userName || payload.accountName || '',
    org: payload.organizationName || payload.schoolName || '',
    formAt: 0,
    mfaState: '',
    mfaGid: '',
    mfaAttest: '',
    mfaPhone: '',
    mfaPass: '',
    mfaUser: ''
  })
  return {
    success: true,
    name: payload.name || payload.userName || payload.accountName || '',
    trustDays: 30,
    chain
  }
}

/**
 * 学号密码登录（APP 通道）。两种结果：
 *   {success:true}                     → 拿到 idToken，已落库
 *   {needMfaCode:true, phone}          → 验证码已发到手机，等用户填
 *   {success:false, message/hint}      → 密码错 / 没绑安全手机 / 服务端拒绝
 */
async function login(o) {
  const openid = o.openid
  const st = state(await readDoc(openid))
  const chain = []
  const deviceId = deviceIdOf(st)

  let pem = ''
  try {
    pem = await appGetPublicKey()
  } catch (e) {
    return { success: false, error: '取加密公钥失败：' + String((e && e.message) || e) }
  }

  const encAccount = rsaWrap(o.username, pem)
  const encPassword = rsaWrap(o.password, pem)

  // ① MFA 探测：拿 state 和 need。need=true 且绑了安全手机 → 走短信接力
  let det = null
  try {
    det = await appDetect(pem, o.username, o.password, deviceId)
    chain.push('detect: need=' + String(det.need))
  } catch (e) {
    return { success: false, error: '统一认证探测失败：' + String((e && e.message) || e), chain }
  }

  if (det.need) {
    if (!det.securePhoneOk) {
      return {
        success: false,
        message: '统一认证要求二次验证，但这个账号没绑安全手机',
        hint: '去学校 App 或网页门户里绑一个手机号再回来。'
      }
    }
    let init = null
    try {
      init = await appInitSms(det.state)
    } catch (e) {
      return { success: false, message: '安全手机初始化失败：' + String((e && e.message) || e), chain }
    }
    if (!init.gid) {
      return { success: false, message: '安全手机初始化没返回 gid，接口可能改版了', chain }
    }
    const sent = await appSendSms(init.attestBase, init.gid)
    await save(openid, {
      deviceId,
      formAt: Date.now(),
      mfaState: det.state,
      mfaGid: secret.encrypt(init.gid),
      mfaAttest: init.attestBase,
      mfaPhone: maskPhone(init.securePhone),
      // 账号+密码的 RSA 密文，外层再套 SECRET 落库；验证完立即清掉。
      // RSA 密文只有 CAS 服务端私钥解得开，且绑死本次登录会话。
      mfaPass: secret.encrypt(JSON.stringify({ a: encAccount, p: encPassword })),
      mfaUser: String(o.username || '')
    })
    return {
      success: false,
      needMfaCode: true,
      phone: maskPhone(init.securePhone),
      message: sent.ok
        ? '验证码已发送' + (init.securePhone ? '到 ' + maskPhone(init.securePhone) : '')
        : '验证码发送失败：' + (sent.error || '原因未知') + '，收到后直接填，或点「重发验证码」',
      hint:
        '学校强制短信二次验证，验证码在你手机上。填进来点「验证并导入」，' +
        '通过后云端会存约一个月的免密登录态，之后拉课表不用再验（同一设备也不再有短信）。',
      chain
    }
  }

  // ② 设备已信任（或账号没开 MFA）：直接密码登录
  try {
    const tokens = await appPasswordLogin(encAccount, encPassword, deviceId, det.state)
    chain.push('passwordLogin 成功')
    const r = await finishLogin(openid, deviceId, tokens, chain)
    return r
  } catch (e) {
    const msg = String((e && e.message) || e)
    return {
      success: false,
      message: /密码|账号|用户/.test(msg) ? '账号或密码不对（' + msg + '）' : msg,
      hint: '确认学号和统一身份认证密码都填对了。',
      chain
    }
  }
}

/**
 * 二次验证的下半场：用户把短信验证码交上来。
 *   - o.resend → 只重发短信
 *   - o.code   → 校验 + 带原 state 重新 passwordLogin + 落库
 * 全程依赖库里 save() 存下的接力态（mfaState / gid / attest / 账号密码密文），
 * 超过 FORM_TTL 没验证就得重新走一遍密码登录（服务端会话已经没了）。
 */
async function mfaVerify(o) {
  const openid = o.openid
  const st = state(await readDoc(openid))
  const chain = []

  if (!st.mfaGid || !st.mfaAttest || !st.mfaState || !st.mfaPass) {
    return {
      success: false,
      needRestart: true,
      message: '没有进行中的验证',
      hint: '先填学号密码点一次「登录并导入课表」，收到短信再回来填验证码。'
    }
  }
  if (Date.now() - st.formAt > FORM_TTL) {
    await save(openid, { mfaState: '', mfaGid: '', mfaAttest: '', mfaPhone: '', mfaPass: '', mfaUser: '', formAt: 0 })
    return {
      success: false,
      needRestart: true,
      message: '验证会话过期了（超过 10 分钟）',
      hint: '重新点一次「登录并导入课表」，短信会重新发。'
    }
  }

  if (o.resend) {
    const sent = await appSendSms(st.mfaAttest, st.mfaGid)
    if (!sent.ok) {
      return { success: false, message: '重发失败：' + sent.error, hint: '过一会再试，或重新走一遍密码登录。' }
    }
    return { success: false, needMfaCode: true, phone: st.mfaPhone, message: '已重发验证码' }
  }

  const code = String(o.code || '').trim()
  if (!code) {
    return { success: false, needMfaCode: true, phone: st.mfaPhone, message: '验证码别空着' }
  }

  let j = null
  try {
    j = await appValidSms(st.mfaAttest, st.mfaGid, code)
  } catch (e) {
    return { success: false, message: '验证接口连不上：' + String((e && e.message) || e) }
  }

  const status = j && j.data && j.data.status
  if (!(j && j.code === 0 && status === 2)) {
    if (j && j.data && j.data.result === 'expired') {
      return {
        success: false,
        needMfaCode: true,
        phone: st.mfaPhone,
        message: '验证码已过期',
        hint: '点「重发验证码」再来一次。'
      }
    }
    return {
      success: false,
      needMfaCode: true,
      phone: st.mfaPhone,
      message: '验证码不对' + (j && (j.message || j.msg) ? '（' + (j.message || j.msg) + '）' : ''),
      hint: '检查有没有抄错，或点「重发验证码」。'
    }
  }

  // 验证通过：用存的密文 + 原 mfaState 重新 passwordLogin（ZZU.Py 的做法，
  // 校验成功后 login 直接复用当前 state，不需要重新 detect）
  let creds = null
  try {
    creds = JSON.parse(st.mfaPass)
  } catch (e) {
    return { success: false, needRestart: true, message: '接力态损坏，重新登录一次即可' }
  }
  try {
    const tokens = await appPasswordLogin(creds.a, creds.p, st.deviceId, st.mfaState)
    chain.push('passwordLogin 成功（MFA 后）')
    const fr = await finishLogin(openid, st.deviceId, tokens, chain)
    // 和 auto() 收尾一致：登录完顺手把课表拉回来，前端一次拿到可展示的结果
    const r = await schedule({ openid })
    r.loggedIn = true
    r.loginName = fr.name || ''
    return r
  } catch (e) {
    const msg = String((e && e.message) || e)
    return {
      success: false,
      message: '验证码对了但登录没成：' + msg,
      hint: '重新点一次「登录并导入课表」即可，一般不用再收短信（设备已被信任）。',
      chain
    }
  }
}

/* ------------------------------------------------------------------ */
/* 新本科教务系统（eams-micro-server，公网可达）                         */
/* ------------------------------------------------------------------ */

const EAMS_MICRO = 'https://jwxt.zzu.edu.cn/eams-micro-server/api/v1'

/**
 * 教务接口的认证方式（ZZU.Py 核对过）：APP 的 idToken 走两路——
 *   Authorization 头 + 名为 userToken 的 cookie（.zzu.edu.cn 域）。
 */
function eamsHeaders(token) {
  return {
    authorization: token,
    cookie: 'userToken=' + encodeURIComponent(token),
    accept: 'application/json, text/plain, */*'
  }
}

/** 当前学期：返回 {result, msg, data}（data.id 就是学期号） */
async function eamsCurrentSemester(token) {
  const r = await HTTP.request(EAMS_MICRO + '/semester/current-semester', {
    timeout: 12000,
    maxRedirect: 2,
    headers: eamsHeaders(token)
  })
  let json = null
  try {
    json = JSON.parse(r.text)
  } catch (e) {
    json = null
  }
  return { status: r.status, json, text: r.text }
}

/** 学生的某学期课表：返回 {result, msg, data: [教学班...]} */
async function eamsCourseTable(semesterId, token) {
  // 学期号强制 parseInt + encodeURIComponent 成纯数字路径段
  const seg = encodeURIComponent(parseInt(semesterId, 10))
  const r = await HTTP.request(EAMS_MICRO + '/lesson/student/course-table/' + seg, {
    timeout: 15000,
    maxRedirect: 2,
    headers: eamsHeaders(token)
  })
  let json = null
  try {
    json = JSON.parse(r.text)
  } catch (e) {
    json = null
  }
  return { status: r.status, json, text: r.text }
}

/**
 * 钟点 → 节次。只给时间的日程靠它定位。
 *   mode='start' 拿上课时间比（08:00 → 第 1 节）
 *   mode='end'   拿下课时间比（09:40 → 第 2 节）
 */
function timeToPeriod(hhmm, mode) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim())
  if (!m) return 0
  const mins = Number(m[1]) * 60 + Number(m[2])
  const field = mode === 'end' ? 'to' : 'from'
  let best = 0
  let diff = 1e9
  PERIODS.forEach((x) => {
    const [fh, fm] = x[field].split(':').map(Number)
    const d = Math.abs(fh * 60 + fm - mins)
    if (d < diff) {
      diff = d
      best = x.p
    }
  })
  return diff <= 45 ? best : 0
}

function pick(obj, keys) {
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k]
  }
  return ''
}

function dayFromDate(s) {
  const t = Date.parse(String(s || '').replace(/\//g, '-'))
  if (isNaN(t)) return 0
  const d = new Date(t).getDay()
  return d === 0 ? 7 : d
}

function normTime(s) {
  const m = /(\d{1,2}):(\d{2})/.exec(String(s || ''))
  return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : ''
}

/** "2026-09-08" 往前/往后挪整数天，返回 "YYYY-MM-DD" */
function dateShift(dateStr, days) {
  const t = Date.parse(String(dateStr || '').replace(/\//g, '-') + 'T00:00:00')
  if (isNaN(t)) return ''
  const d = new Date(t + days * 86400000)
  const p = (x) => (x < 10 ? '0' + x : '' + x)
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

/**
 * 教务排课声明里的周次语法 → 精确周列表。
 * 真实语法比想象丰富（逗号分段、段内可带单双周、#分组号）：
 *   「1~4,6~8(双),9~16周」  → [1,2,3,4,6,8,9..16]
 *   「1~3(单),7~13(单),17周」→ [1,3,7,9,11,13,17]
 *   「2,7~8,10~16(双)周」    → [2,7,8,10,12,14,16]
 * 解析不了返回空数组 —— 宁可不补，不能补错。
 */
function parseWeekList(s) {
  let t = String(s || '').trim()
  if (!t) return []
  const tail = t.match(/[\(（]\s*([单双])\s*[\)）]\s*$/)
  const tailParity = tail ? (tail[1] === '单' ? 1 : 2) : 0
  if (tail) t = t.slice(0, tail.index).trim()
  t = t.replace(/^第/, '').trim()
  if (!/周$/.test(t)) return []
  const body = t.slice(0, -1).trim()
  if (!body) return []

  const out = []
  const pieces = body.split(/[,，、;]/)
  for (let i = 0; i < pieces.length; i++) {
    const pm = pieces[i]
      .trim()
      .match(/^(\d{1,2})(?:\s*[-~—－]\s*(\d{1,2}))?(?:\s*[\(（]([单双])[\)）])?$/)
    if (!pm) return []
    const a = Number(pm[1])
    const b = pm[2] !== undefined ? Number(pm[2]) : a
    const from = Math.min(a, b)
    const to = Math.max(a, b)
    const parity = pm[3] ? (pm[3] === '单' ? 1 : 2) : tailParity
    for (let w = from; w <= to; w++) {
      if (parity === 1 && w % 2 === 0) continue
      if (parity === 2 && w % 2 === 1) continue
      if (out.indexOf(w) < 0) out.push(w)
    }
  }
  if (!out.length) return []
  return out.sort((a, b) => a - b)
}

/**
 * 教学班「排课文字描述」→ 课表条目（兜底用）。
 * 段与段之间用分号隔开，每段形如
 * 「#1 1~3(单),7~13(单),17周 星期一 1~4节 主校区 物理实验中心楼」。
 * 个别教学班（分组实验课）schedules 明细只有占位的一两条，
 * 整门课的真实排法只在这段文字里 —— 不解析它，实验课就会从课表里消失。
 */
function parseScheduleText(name, text) {
  const out = []
  const body = String(text || '').replace(/天/g, '日')
  body.split(/[;；\n]+/).forEach((seg) => {
    const s0 = seg.trim().replace(/^#\d+\s*/, '').trim()
    if (!s0) return
    const dayM = s0.match(/星期([一二三四五六日])/)
    const unitM = s0.match(/(\d{1,2})\s*[-~—－]\s*(\d{1,2})\s*节/)
    if (!dayM || !unitM) return // 放不进格子的描述（纯时间制等）跳过
    const day = '一二三四五六日'.indexOf(dayM[1]) + 1
    const start = Number(unitM[1])
    const end = Math.max(start, Number(unitM[2]))

    // 星期前面的部分都是周次声明
    const dayIdx = s0.indexOf(dayM[0])
    const list = dayIdx > 0 ? parseWeekList(s0.slice(0, dayIdx)) : []

    let weeks
    if (list.length) {
      weeks = { from: list[0], to: list[list.length - 1], parity: 0, list }
    } else {
      // 老写法兜底：单一范围 / 单一周次
      const parityM = s0.match(/[\(（]([单双])[\)）]/)
      const parity = parityM ? (parityM[1] === '单' ? 1 : 2) : 0
      const rangeM = s0.match(/(\d{1,2})\s*[-~—－]\s*(\d{1,2})\s*周/)
      if (rangeM) {
        weeks = {
          from: Math.min(Number(rangeM[1]), Number(rangeM[2])),
          to: Math.max(Number(rangeM[1]), Number(rangeM[2])),
          parity
        }
      } else {
        const oneM = s0.match(/第?(\d{1,2})\s*周/)
        weeks = oneM
          ? { from: Number(oneM[1]), to: Number(oneM[1]), parity }
          : { from: 1, to: 30, parity }
      }
    }

    const place = s0
      .slice(dayIdx + dayM[0].length)
      .replace(unitM[0], ' ')
      .replace(/^[\s,，、;；:：|]+|[\s,，、;；:：|]+$/g, '')
      .trim()
    out.push({ day, start, end, name, place, weeks })
  })
  return out
}

/**
 * 把教务 course-table 拍平成课表条目。
 * 教务的粒度是「每一节课一条记录」（date + weekday + startUnit/endUnit + weekIndex），
 * 同一门课拆成几十条；这里按「周几 + 起止节 + 课程名」聚合成课表格子。
 *
 * 周次必须保留精确列表（weeks.list）：实验课、体育课这类不是每周都上，
 * 教务给的是散点的周次（比如第 4、6、8 周各一次），只记最小/最大周
 * 会把中间没课的周也显示成有课 —— 那是「课表不准」的主要来源。
 */
function parseCourseTable(json) {
  const items = []
  const meta = {
    courses: 0,
    lessons: 0,
    weeks: null,
    noSchedule: [],
    textBased: [],
    textByName: {},
    // 明细稀疏的课（分组实验课这类）：把教务给的原始记录和排课组存下来，
    // 诊断时看教务到底知不知道「每次课各自叫什么」
    sparseRaw: {},
    groupsByName: {},
    sampleKeys: []
  }
  if (!json || json.result !== 0 || !Array.isArray(json.data)) return { items, meta }

  meta.courses = json.data.length
  const slots = {}
  let termStartFrom = null // weekIndex===1 里最早的那节课，用来推开学周一

  /**
   * 落一个格子。schedules 展开的传 week（逐次累加进精确列表）；
   * 文字兜底的传 weeksObj（整段周次描述）。同一个格子两边都来时，
   * schedules 是权威，文字不覆盖。
   */
  const putSlot = (day, start, end, name, place, week, weeksObj) => {
    const key = [day, start, end, name].join('|')
    if (!slots[key]) {
      slots[key] = {
        id: key,
        day,
        start,
        end: end >= start ? end : start,
        name,
        place,
        weeks: week ? { from: week, to: week, list: [week] } : null
      }
      items.push(slots[key])
    }
    const slot = slots[key]
    if (week) {
      if (!slot.weeks) slot.weeks = { from: week, to: week, list: [week] }
      if (week < slot.weeks.from) slot.weeks.from = week
      if (week > slot.weeks.to) slot.weeks.to = week
      if (!Array.isArray(slot.weeks.list)) slot.weeks.list = []
      if (slot.weeks.list.indexOf(week) < 0) slot.weeks.list.push(week)
    } else if (weeksObj && !(slot.weeks && Array.isArray(slot.weeks.list) && slot.weeks.list.length)) {
      slot.weeks = {
        from: weeksObj.from,
        to: weeksObj.to,
        parity: weeksObj.parity || 0,
        list: Array.isArray(weeksObj.list) && weeksObj.list.length ? weeksObj.list : undefined
      }
      slot.viaText = true
    }
    // 有的条目不带教室，别让空串一直占着位
    if (!slot.place && place) slot.place = place
    return slot
  }

  json.data.forEach((datum) => {
    if (!datum || typeof datum !== 'object') return
    const name = String(pick(datum.course || {}, ['nameZh', 'name']) || '').trim()
    if (!name) return
    const schedules = Array.isArray(datum.schedules) ? datum.schedules : []
    const before = items.length
    let valid = 0 // 这门课教务给了几条能用的排课明细

    schedules.forEach((s) => {
      if (!s || typeof s !== 'object') return
      meta.lessons++
      const day = Number(s.weekday)
      const start = Number(s.startUnit)
      const end = Number(s.endUnit) || Number(s.startUnit)
      const week = Number(s.weekIndex)
      if (!(day >= 1 && day <= 7) || !(start >= 1)) return
      if (!(week >= 1)) return
      valid++
      const place = String(
        (s.room && pick(s.room, ['nameZh', 'name'])) || s.customPlace || ''
      ).trim()

      putSlot(day, start, end, name, place, week)

      // 教务数据实际覆盖到第几周（用户反馈课表不完整时，一眼看出是不是只给了一半）
      if (!meta.weeks) meta.weeks = [week, week]
      if (week < meta.weeks[0]) meta.weeks[0] = week
      if (week > meta.weeks[1]) meta.weeks[1] = week

      // 用第 1 周的课反推开学周一：date 往前挪 (weekday-1) 天
      if (week === 1 && s.date) {
        const monday = dateShift(s.date, -(day - 1))
        if (monday && (!termStartFrom || monday < termStartFrom)) termStartFrom = monday
      }
    })

    // 排课文字声明（如「1~17周 星期一 1~4节 物理实验大楼」）。
    // 分组轮转的实验课经常只有一两条明细（占位），文字反而是全的 ——
    // 明细太稀（≤2 条）的教学班以文字为准补全；明细丰富的课不动，
    // 因为逐次明细里有调课/停课的精确信息，文字给不了。
    const st = datum.scheduleText || {}
    const dtPlace = st.dateTimePlaceText || {}
    const txt = String(dtPlace.textZh || dtPlace.text || '')
    if (txt) meta.textByName[name] = txt.slice(0, 200)
    if (valid <= 2) {
      // 教务的原始明细记录（截到 3 条）+ 排课组，诊断用
      meta.sparseRaw[name] = schedules.slice(0, 3)
      if (Array.isArray(datum.scheduleGroups) && datum.scheduleGroups.length) {
        meta.groupsByName[name] = datum.scheduleGroups
      }
    }
    if (valid <= 2 && txt) {
      let usedText = false
      parseScheduleText(name, txt).forEach((r) => {
        const key = [r.day, r.start, r.end, name].join('|')
        const slot = slots[key]
        const rList = (r.weeks && r.weeks.list) || []
        if (!slot) {
          // 明细里根本没有这个时间位 → 按文字补
          putSlot(r.day, r.start, r.end, name, r.place, 0, r.weeks)
          usedText = true
          return
        }
        // 文字补出来的格子：多段声明（分号隔开）取并集，如 1~3(单),7~13(单),17 + 15
        if (slot.viaText) {
          if (rList.length) {
            const merged = Array.isArray(slot.weeks.list) ? slot.weeks.list.slice() : []
            rList.forEach((w) => {
              if (merged.indexOf(w) < 0) merged.push(w)
            })
            merged.sort((a, b) => a - b)
            slot.weeks = { from: merged[0], to: merged[merged.length - 1], parity: 0, list: merged }
            usedText = true
          }
          return
        }
        // 明细给的同一时间位，但只有占位的一两条，而文字声明了长得多的周列表 → 以文字为准
        const observed = Array.isArray(slot.weeks.list) ? slot.weeks.list.length : 0
        if (rList.length >= 5 && rList.length >= observed + 3) {
          slot.weeks = {
            from: rList[0],
            to: rList[rList.length - 1],
            parity: 0,
            list: rList.slice()
          }
          slot.viaText = true
          usedText = true
        }
      })
      if (usedText && meta.textBased.indexOf(name) < 0) meta.textBased.push(name)
    }

    if (items.length === before) meta.noSchedule.push(name)
  })

  // 周次排个序；纯单周/纯双周的格子打上奇偶标记，
  // 这样就算某个端没带上 list、退回 from/to 兜底，单双周也不会错
  items.forEach((it) => {
    const list = (it.weeks && it.weeks.list) || []
    if (list.length) list.sort((a, b) => a - b)
    if (list.length > 1) {
      it.weeks.parity =
        list.every((w) => w % 2 === 1) ? 1 : list.every((w) => w % 2 === 0) ? 2 : 0
    }
  })

  if (items.length) meta.sampleKeys = Object.keys(json.data[0]).slice(0, 20)
  return { items, meta, termStart: termStartFrom || '' }
}

/** 本学期大致范围：8 月 1 日 ~ 次年 3 月底（跨半年，足够覆盖秋春两学期） */
function defaultRange(now) {
  const d = now ? new Date(now) : new Date()
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  const startYear = m >= 8 ? y : y - 1
  return { from: startYear + '-08-01', to: startYear + 1 + '-03-31' }
}

/* ------------------------------------------------------------------ */
/* 对外：拉课表（不需要密码，靠库里的 idToken 走教务接口）                */
/* ------------------------------------------------------------------ */

/**
 * 拉课表。数据源是「新本科教务系统」eams-micro-server（jwxt.zzu.edu.cn，
 * 公网可达，ZZU.Py 核对过）——不是门户的聚合接口（那个字段结构没对外文档，
 * 之前「门户返回了数据但没解析出课程」就是栽在它身上）。
 * 过期 / 教务拒绝 → 清掉 idToken 并要求重新登录。
 */
async function schedule(o) {
  const openid = o.openid
  const st = state(await readDoc(openid))

  const token = st.appToken
  if (!token || tokenExpired(token)) {
    return {
      success: false,
      needLogin: true,
      error: '还没登录过（或者登录态过期了）',
      hint: '填学号 + 统一身份认证密码，点「登录并导入课表」。'
    }
  }

  // ① 当前学期（拿学期号）
  let sem = null
  try {
    sem = await eamsCurrentSemester(token)
  } catch (e) {
    return { success: false, error: '连不上教务系统：' + String((e && e.message) || e) }
  }
  const semRej = !sem.json || (sem.json.result !== 0 && sem.json.result !== undefined)
  const semMsg = String((sem.json && (sem.json.msg || sem.json.message)) || '')
  if (sem.json && sem.json.result === 0 && !(sem.json.data && sem.json.data.id)) {
    return {
      success: false,
      error: '教务没返回学期号（返回结构：' + JSON.stringify(sem.json).slice(0, 150) + '）'
    }
  }
  if (semRej || /token|无效|登录|auth|401/i.test(semMsg) || sem.status === 401 || sem.status === 403) {
    await save(openid, { appToken: '', appRefresh: '', appTokenAt: 0 })
    return {
      success: false,
      needLogin: true,
      error: semMsg || '教务不认这次登录态了（HTTP ' + sem.status + '）',
      hint: '登录态过期了。重新填学号密码点「登录并导入课表」；设备已被信任，一般不会再收短信。'
    }
  }

  // ② 课表（本学期）
  let tab = null
  try {
    tab = await eamsCourseTable(sem.json.data.id, token)
  } catch (e) {
    return { success: false, error: '拉课表失败：' + String((e && e.message) || e) }
  }
  if (!tab.json) {
    return {
      success: false,
      error: '教务返回的不是 JSON（HTTP ' + tab.status + '）',
      detail: String(tab.text || '').slice(0, 200)
    }
  }
  if (tab.json.result !== 0) {
    const msg = String(tab.json.msg || tab.json.message || '')
    if (/token|无效|登录|auth/i.test(msg) || tab.status === 401 || tab.status === 403) {
      await save(openid, { appToken: '', appRefresh: '', appTokenAt: 0 })
      return {
        success: false,
        needLogin: true,
        error: msg || '教务不认这次登录态了',
        hint: '重新填学号密码点「登录并导入课表」即可，一般不用再收短信。'
      }
    }
    return { success: false, error: msg || '教务拒绝了这次请求' }
  }

  const parsed = parseCourseTable(tab.json)
  await save(openid, { lastPullAt: Date.now() })

  // 给用户看的一句话结论：课表不完整时能直接看出是教务只给了一部分数据
  const notes = []
  if (parsed.meta.weeks) {
    notes.push('教务数据覆盖第 ' + parsed.meta.weeks[0] + '-' + parsed.meta.weeks[1] + ' 周')
  }
  if ((parsed.meta.noSchedule || []).length) {
    notes.push(
      '没有排课时间（可能是网课）：' + parsed.meta.noSchedule.slice(0, 3).join('、')
    )
  }
  if ((parsed.meta.textBased || []).length) {
    notes.push('明细不全、已按教务排课声明补全：' + parsed.meta.textBased.slice(0, 3).join('、'))
  }

  const out = {
    success: parsed.items.length > 0,
    count: parsed.items.length,
    items: parsed.items,
    meta: parsed.meta,
    via: 'eams',
    termStart: parsed.termStart,
    name: st.name,
    org: st.org,
    message: parsed.items.length
      ? '已从教务拉取 ' +
        parsed.meta.courses +
        ' 门课排成 ' +
        parsed.items.length +
        ' 个格子' +
        (notes.length ? '；' + notes.join('；') : '')
      : '教务返回了数据但没解析出课程（把 meta 发我看下字段名）'
  }
  // 解析 0 条时把原始结构带回去，方便一眼看出字段名对不上
  if (!parsed.items.length) out.raw = tab.json

  // 存一份「教务到底给了什么」的摘要，课表不对时一键诊断用
  const byName = {}
  parsed.items.forEach((it) => {
    const w = it.weeks || {}
    const wk =
      Array.isArray(w.list) && w.list.length
        ? w.list.join(',')
        : w.from === w.to
          ? String(w.from)
          : w.from + '-' + w.to
    const tag = '周' + '一二三四五六日'.charAt(it.day - 1) + ' ' + it.start + '-' + it.end + '节 [' + wk + ']'
    ;(byName[it.name] = byName[it.name] || []).push(tag)
  })
  await save(openid, {
    lastTableSummary: {
      at: Date.now(),
      courses: parsed.meta.courses,
      lessons: parsed.meta.lessons,
      weeks: parsed.meta.weeks,
      noSchedule: parsed.meta.noSchedule,
      textBased: parsed.meta.textBased,
      textByName: parsed.meta.textByName,
      sparseRaw: parsed.meta.sparseRaw,
      groupsByName: parsed.meta.groupsByName,
      termStart: parsed.termStart,
      byName
    }
  })
  return out
}

/**
 * 课表诊断：把上次拉取时教务实际返回的内容摘要出来。
 * 用户反馈「课表不完整」时，看一眼就知道是教务给的数据缺、还是解析丢的。
 */
async function tableDebug(o) {
  const st = state(await readDoc(o.openid))
  const s = st.lastTableSummary
  if (!s) {
    return { success: false, message: '还没有拉过课表的记录，先点一次「拉取课表」' }
  }
  return { success: true, summary: s }
}

/* ------------------------------------------------------------------ */
/* 一步到位 + 状态                                                     */
/* ------------------------------------------------------------------ */

/**
 * 前端只需要调这一个：
 *   - 库里的 idToken 还有效 → 直接拉课表
 *   - 没有或失效 → 有账号密码就走 APP 登录（MFA 需要时先发短信），没有就引导
 */
async function auto(o) {
  const openid = o.openid
  const st = state(await readDoc(openid))

  // 已登录过、这次也没打算重登 → 直接拉
  if (st.appToken && !o.forceLogin) {
    const r = await schedule({ openid, from: o.from, to: o.to })
    if (r.success || !r.needLogin) return r
    // idToken 真的失效了：清掉，让用户重新登录
    await save(openid, { appToken: '', appRefresh: '', appTokenAt: 0 })
  }

  if (!o.username || !o.password) {
    return {
      success: false,
      needCredentials: true,
      message: '需要学号和密码',
      hint:
        '填学号和统一身份认证密码，点「登录并导入课表」：短信验证码会发到你手机，' +
        '填一次之后约一个月免密，同一设备也不再收短信。'
    }
  }

  const lr = await login({ openid, username: o.username, password: o.password })
  if (!lr.success) return lr

  const r = await schedule({ openid, from: o.from, to: o.to })
  r.loggedIn = true
  r.loginName = lr.name
  return r
}

async function status(o) {
  const st = state(await readDoc(o.openid))
  const loggedIn = !!st.appToken && !tokenExpired(st.appToken)
  return {
    loggedIn,
    hasToken: !!st.appToken,
    name: st.name,
    org: st.org,
    lastPullAt: (st.doc && st.doc.lastPullAt) || 0,
    // 卡在短信验证这一步：前端据此把「验证码」输入框亮出来
    pendingMfa: !!st.mfaGid && Date.now() - st.formAt <= FORM_TTL,
    mfaPhone: st.mfaPhone || ''
  }
}

async function logout(o) {
  await clear(o.openid)
  return { loggedIn: false }
}

module.exports = {
  CAS_BASE,
  PORTAL_BASE,
  PORTAL_API,
  COLL,
  probe,
  auto,
  login,
  mfaVerify,
  schedule,
  tableDebug,
  status,
  logout,
  _internal: {
    rsaEncrypt,
    jwtPayload,
    tokenExpired,
    parseCourseTable,
    parseScheduleText,
    parseWeekList,
    timeToPeriod,
    defaultRange,
    state,
    maskPhone,
    deviceIdOf
  }
}
