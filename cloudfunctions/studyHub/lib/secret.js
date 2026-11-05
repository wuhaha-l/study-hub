const crypto = require('crypto')

/**
 * 账号凭据的对称加密（AES-256-GCM）。
 *
 * SECRET 不进仓库：
 *   1. 优先读环境变量 STUDYHUB_SECRET（云开发控制台可配）
 *   2. 其次读同目录的 secret.local.js —— 本机开发用，已被 .gitignore 忽略
 *   3. 都没有就用占位值，能跑但等于没加密，公开部署前必须换掉
 *
 * ⚠️ 换掉 SECRET 会导致已保存的账号无法解密，需要重新绑定。
 */
function pickSecret() {
  if (process.env.STUDYHUB_SECRET) return process.env.STUDYHUB_SECRET
  try {
    const local = require('./secret.local')
    if (local && local.SECRET) return local.SECRET
  } catch (e) {
    /* 没有本地覆盖，用占位值 */
  }
  return 'change-me-to-a-random-string'
}

const SECRET = pickSecret()
const KEY = crypto.createHash('sha256').update(SECRET, 'utf8').digest()

function encrypt(plain) {
  if (!plain) return ''
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv)
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.')
}

function decrypt(payload) {
  if (!payload) return ''
  const parts = String(payload).split('.')
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('凭据格式异常，请重新绑定账号')
  const iv = Buffer.from(parts[1], 'base64')
  const tag = Buffer.from(parts[2], 'base64')
  const data = Buffer.from(parts[3], 'base64')
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch (e) {
    throw new Error('凭据解密失败，SECRET 可能已被修改，请重新绑定账号')
  }
}

/** 手机号 / 学号打码 */
function mask(str) {
  const s = String(str || '')
  if (s.length <= 4) return s ? s[0] + '***' : ''
  if (/^\d{11}$/.test(s)) return s.slice(0, 3) + '****' + s.slice(-4)
  return s.slice(0, 2) + '***' + s.slice(-2)
}

module.exports = { encrypt, decrypt, mask }
