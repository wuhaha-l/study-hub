/**
 * 深色模式：手动切换、记住选择。
 *
 * 实现方式：颜色全部走 CSS 变量（定义在 app.wxss 的 page 上），
 * 切到深色时给每个页面的根节点挂 .theme-dark 类，变量整组换掉；
 * 导航栏颜色跟着同步。页面在 onShow 里调 apply(this) 即可。
 */
const KEY = 'theme_v1'

function get() {
  const v = wx.getStorageSync(KEY)
  return v === 'dark' ? 'dark' : 'light'
}

function navColors(t) {
  return t === 'dark'
    ? { frontColor: '#F2F3F8', backgroundColor: '#1C1E28' }
    : { frontColor: '#000000', backgroundColor: '#FFFFFF' }
}

/** 页面 onShow / onLoad 时调：写 data.theme（根节点类）+ 同步导航栏和窗口底色 */
function apply(page) {
  const t = get()
  page.setData({ theme: t })
  try {
    wx.setNavigationBarColor(navColors(t))
    if (wx.setBackgroundColor) {
      wx.setBackgroundColor({ color: t === 'dark' ? '#101116' : '#F4F5F9' })
    }
    // 下拉刷新的三个点也得跟着换，否则深色下是墨点掉进黑底、看不见
    if (wx.setBackgroundTextStyle) {
      wx.setBackgroundTextStyle({ textStyle: t === 'dark' ? 'light' : 'dark' })
    }
  } catch (e) {
    /* 部分环境不支持时不影响主题本身 */
  }
  return t
}

/** 切换并保存，返回新主题名 */
function toggle() {
  const next = get() === 'dark' ? 'light' : 'dark'
  wx.setStorageSync(KEY, next)
  return next
}

module.exports = { get, apply, toggle, navColors }
