/**
 * 前端可配置项。
 * 只需要改这一个文件，别的地方不用动。
 */
module.exports = {
  /**
   * 订阅消息模板 ID。
   * 在「微信公众平台 → 功能 → 订阅消息 → 我的模板」里从公共模板库添加，形如 40 位左右的字符串。
   * 留空则首页不显示「每日提醒」入口，其余功能不受影响。
   * ⚠️ 填了之后，云函数 lib/notify.js 顶部的 TEMPLATE_ID 也要填同一个 ID，
   *    并按模板详情页的字段名核对 notify.js 里 buildData 的 thing1/time2/thing3。
   */
  SUBSCRIBE_TEMPLATE_ID: 'FQK8KQyrDRPpzin8ekp4SVtbZ3IAvj_7O-nAlFTRoLY'
}
