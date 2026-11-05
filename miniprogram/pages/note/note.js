const N = require('../../utils/notes')
const theme = require('../../utils/theme')
const app = getApp()

const SAVE_DELAY = 700 // 输入停手 0.7 秒后自动存

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    theme: 'light',
    id: '',
    title: '',
    body: '',
    color: 'plain',
    pinned: false,
    palette: false,
    colors: N.COLORS,
    chars: 0,
    stateText: '新便签'
  },

  onLoad(options) {
    const g = app.globalData
    const o = options || {}
    const id = o.id || ''

    this.setData({
      statusBarHeight: g.statusBarHeight,
      navBarHeight: g.navBarHeight,
      id: id
    })

    if (id) {
      const n = N.get(id)
      if (n) {
        this.setData({
          title: n.title,
          body: n.body,
          color: n.color,
          pinned: n.pinned,
          chars: N.lengthOf(n),
          stateText: N.timeLabel(n.updatedAt) + ' 编辑'
        })
      } else {
        // 记录被删了（比如在别处删过），当新建处理
        this.setData({ id: '' })
      }
    }
  },

  onShow() {
    theme.apply(this)
  },

  onTitle(e) {
    this.setData({ title: e.detail.value }, () => this.touch())
  },

  onBody(e) {
    this.setData({ body: e.detail.value }, () => this.touch())
  },

  /** 输入变化：更新字数 + 延后自动保存 */
  touch() {
    this.setData({ chars: N.lengthOf({ title: this.data.title, body: this.data.body }) })
    if (this._timer) clearTimeout(this._timer)
    this._timer = setTimeout(() => this.persist(), SAVE_DELAY)
  },

  /**
   * 落盘。三种情况：
   *   有内容 → 新建或更新
   *   原来有 id、现在清空了 → 删掉（跟便签 App 一样，清空等于删除）
   *   全新且空 → 什么都不做，返回时也不会留下空便签
   */
  persist() {
    const title = String(this.data.title || '')
    const body = String(this.data.body || '')
    const empty = !title.trim() && !body.trim()

    if (empty) {
      if (this.data.id) {
        N.remove(this.data.id)
        this.setData({ id: '', stateText: '已清空，返回即删除' })
      }
      return
    }

    const saved = N.save({
      id: this.data.id,
      title: title,
      body: body,
      color: this.data.color,
      pinned: this.data.pinned
    })
    if (saved && saved.id !== this.data.id) {
      this.setData({ id: saved.id })
    }
    this.setData({ stateText: '已保存 ' + N.timeLabel(saved.updatedAt).replace('今天 ', '') })
  },

  goBack() {
    if (this._timer) clearTimeout(this._timer)
    this.persist()
    // 新建的便签如果最后什么都没写，直接返回，别留在列表里
    wx.navigateBack({
      fail: () => wx.reLaunch({ url: '/pages/notes/notes' })
    })
  },

  onUnload() {
    if (this._timer) clearTimeout(this._timer)
    // 页面已经在销毁了，这里不能再 setData（会告警），只静默落盘
    this.persistQuiet()
  },

  /** 不碰 setData 的版本，供 onUnload 用 */
  persistQuiet() {
    const title = String(this.data.title || '')
    const body = String(this.data.body || '')
    const empty = !title.trim() && !body.trim()
    if (empty) {
      if (this.data.id) N.remove(this.data.id)
      return
    }
    N.save({
      id: this.data.id,
      title: title,
      body: body,
      color: this.data.color,
      pinned: this.data.pinned
    })
  },

  togglePalette() {
    this.setData({ palette: !this.data.palette })
  },

  onPickColor(e) {
    const key = e.currentTarget.dataset.key || 'plain'
    this.setData({ color: key, palette: false })
    this.persist()
  },

  onTogglePin() {
    const empty = !String(this.data.title || '').trim() && !String(this.data.body || '').trim()
    if (empty && !this.data.id) {
      wx.showToast({ title: '先写点内容', icon: 'none' })
      return
    }
    const pinned = !this.data.pinned
    // persist 会把这个 pinned 一起写进去，所以不用再调 togglePin（否则会翻回去）
    this.setData({ pinned: pinned }, () => this.persist())
    wx.showToast({ title: pinned ? '已置顶' : '已取消置顶', icon: 'none' })
  },

  onCopy() {
    const text = [String(this.data.title || '').trim(), String(this.data.body || '').trim()]
      .filter(Boolean)
      .join('\n')
    if (!text) {
      wx.showToast({ title: '还没写内容', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制', icon: 'success' })
    })
  },

  onDelete() {
    if (!this.data.id) {
      // 新建还没落盘：清空内容，返回即可
      this.setData({ title: '', body: '', chars: 0 })
      wx.showToast({ title: '已清空', icon: 'none' })
      return
    }
    wx.showModal({
      title: '删除便签',
      content: '删掉就找不回来了，确定？',
      confirmText: '删除',
      confirmColor: '#D6453B',
      success: (r) => {
        if (!r.confirm) return
        if (this._timer) clearTimeout(this._timer)
        N.remove(this.data.id)
        this.setData({ id: '', title: '', body: '', chars: 0, stateText: '已删除' })
        wx.navigateBack({
          fail: () => wx.reLaunch({ url: '/pages/notes/notes' })
        })
      }
    })
  }
})
