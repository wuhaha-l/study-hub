const cloud = require('wx-server-sdk')

/**
 * 订阅消息。
 *
 * 微信的「一次性订阅」规则：用户每点一次授权，你只能给他推一条消息。
 * 所以这里用 remaining 计数，推一条扣一次，扣完就不再推，等用户下次手动授权。
 *
 * ⚠️ TEMPLATE_ID 必须和 miniprogram/utils/config.js 里的保持一致，
 *    并且 config.json 里要声明 openapi 权限，否则调用会报 -604101。
 */
const TEMPLATE_ID = 'FQK8KQyrDRPpzin8ekp4SVtbZ3IAvj_7O-nAlFTRoLY'

/**
 * 按你申请到的模板字段改这里。
 * 例如模板是「待办事项提醒」，字段为 待办事项(thing1) / 截止时间(time2) / 备注(thing3)，
 * 就去公众平台模板详情页看实际字段名，照着填。
 */
function buildData(ctx) {
  return {
    thing1: { value: ctx.summary },
    time2: { value: ctx.deadline },
    thing3: { value: ctx.detail }
  }
}

function isConfigured() {
  return !!TEMPLATE_ID
}

/**
 * @param {string} openid 接收人
 * @param {{summary:string, deadline:string, detail:string}} ctx
 */
async function sendTodoDigest(openid, ctx) {
  if (!isConfigured()) {
    return { ok: false, skipped: true, reason: '未配置订阅消息模板 ID' }
  }
  try {
    await cloud.openapi.subscribeMessage.send({
      touser: openid,
      templateId: TEMPLATE_ID,
      page: 'pages/index/index',
      lang: 'zh_CN',
      miniprogramState: 'formal',
      data: buildData(ctx)
    })
    return { ok: true }
  } catch (e) {
    const code = e && e.errCode
    // 43101：用户拒收/未授权；43104：模板与小程序不匹配
    return { ok: false, errCode: code, reason: (e && e.errMsg) || (e && e.message) || '发送失败' }
  }
}

module.exports = { sendTodoDigest, isConfigured, TEMPLATE_ID }
