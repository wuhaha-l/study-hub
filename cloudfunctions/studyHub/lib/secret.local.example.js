/*
 * 复制成 secret.local.js 后填一个随机字符串（例如 openssl rand -base64 32）。
 * 用来加密保存在云数据库里的平台账号凭据（AES-256-GCM）。
 *
 * ⚠️ 一旦有账号写入，就不要再改这个值 —— 换了会导致解密失败，所有账号需要重新绑定。
 * 也可以用环境变量 STUDYHUB_SECRET 代替这个文件（优先级更高）。
 */
module.exports = {
  SECRET: 'change-me-to-a-random-string'
}
