/*
 * 云开发环境 ID 放在 env.js（不进仓库），仓库里只有 env.example.js。
 * 这样公开代码时不会把自己的环境 ID 一起带出去；本地开发照旧，env.js 一直在。
 */
let CLOUD_ENV = 'your-cloud-env-id'
try {
  const local = require('./env')
  if (local && local.CLOUD_ENV) CLOUD_ENV = local.CLOUD_ENV
} catch (e) {
  // 没建 env.js 就用占位值，首次跑起来会在云开发初始化时报错提示
  console.warn('未找到 miniprogram/env.js，云开发环境 ID 用占位值')
}

/** 旧版自动开过「开发调试」，这个开关微信记在本机，删掉调用不会自己关回去 */
const DEBUG_FIX_KEY = 'debug_autoclose_v1'

App({
  globalData: {
    envId: CLOUD_ENV,
    statusBarHeight: 20,
    navBarHeight: 44,
    accounts: [],
    needRefresh: false
  },

  onLaunch() {
    // 这里曾经在启动时自动调 wx.setEnableDebug 打开「开发调试」，
    // 为的是让内网 http + IP（希冀 10.67.x.x）在真机上不被合法域名拦掉。
    // 现在去掉了：不需要它的人也被强制开，右下角一直挂个 vConsole，
    // 而且正式版本来就不生效。改成用户真要登录希冀时再弹一次引导，
    // 告诉他去哪开（见 pages/accounts 的 eduLogin / eduShowDebugGuide）。
    //
    // 但「调试模式」这个开关是微信按用户+小程序记在本机的：把上面那句调用
    // 删掉，之前被自动打开的机器并不会自己关回去，绿标还在。所以这里做一次性收尾——
    // 升级后第一次启动关一次，关完打标记，以后用户为了连内网自己开的调试不再动。
    try {
      if (!wx.getStorageSync(DEBUG_FIX_KEY)) {
        wx.setEnableDebug({ enableDebug: false })
        wx.setStorageSync(DEBUG_FIX_KEY, 1)
      }
    } catch (e) {
      /* 正式版没这个能力，忽略 */
    }

    // 状态栏 / 胶囊按钮尺寸，用于自定义导航栏
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      this.globalData.statusBarHeight = info.statusBarHeight || 20
      const menu = wx.getMenuButtonBoundingClientRect
        ? wx.getMenuButtonBoundingClientRect()
        : null
      if (menu && menu.height) {
        this.globalData.navBarHeight =
          (menu.top - this.globalData.statusBarHeight) * 2 + menu.height
      }
    } catch (e) {
      console.warn('获取窗口信息失败', e)
    }

    if (!wx.cloud) {
      console.error('当前基础库版本过低，请使用 2.2.3 及以上版本')
      return
    }
    wx.cloud.init({
      env: CLOUD_ENV,
      traceUser: true,
      // 拉课表要先在云端走完「CAS 登录 + 门户取数」，十几秒是正常值，
      // 默认 15 秒的调用超时会在慢网络下先把请求掐掉
      timeout: 60000
    })
  }
})
