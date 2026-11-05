const N = require('../../utils/notes')
const theme = require('../../utils/theme')
const app = getApp()

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    theme: 'light',
    kw: '',
    view: 'grid',
    items: [],
    total: 0,
    pinnedCount: 0,
    headText: '还没有便签',
    menu: null
  },

  onLoad() {
    const g = app.globalData
    this.setData({
      statusBarHeight: g.statusBarHeight,
      navBarHeight: g.navBarHeight,
      // 记住上次选的视图
      view: wx.getStorageSync('notes_view_v1') === 'list' ? 'list' : 'grid'
    })
  },

  onShow() {
    theme.apply(this)
    this.load()
  },

  /** 从本机读一遍，顺带把展示字段都算好（wxml 里不做计算） */
  load() {
    const all = N.list()
    const kw = this.data.kw
    const shown = kw ? all.filter((n) => N.match(n, kw)) : all
    const items = shown.map((n) => ({
      id: n.id,
      title: N.titleOf(n),
      digest: N.digestOf(n, 62),
      color: n.color,
      pinned: n.pinned,
      timeLabel: N.timeLabel(n.updatedAt),
      chars: N.lengthOf(n)
    }))
    const pinned = all.filter((x) => x.pinned).length
    let head = '还没有便签'
    if (all.length) {
      head = '共 ' + all.length + ' 条'
      if (pinned) head += ' · ' + pinned + ' 条置顶'
      if (kw) head += ' · 搜到 ' + items.length + ' 条'
    }
    this.setData({
      items: items,
      total: all.length,
      pinnedCount: pinned,
      headText: head
    })
  },

  onInputKw(e) {
    this.setData({ kw: e.detail.value }, () => this.load())
  },

  onClearKw() {
    this.setData({ kw: '' }, () => this.load())
  },

  onToggleView() {
    const next = this.data.view === 'grid' ? 'list' : 'grid'
    wx.setStorageSync('notes_view_v1', next)
    this.setData({ view: next })
  },

  goBack() {
    wx.navigateBack({
      fail: () => wx.reLaunch({ url: '/pages/index/index' })
    })
  },

  goNew() {
    wx.navigateTo({ url: '/pages/note/note?mode=new' })
  },

  goEdit(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/note/note?id=' + id })
  },

  onLongPress(e) {
    const id = e.currentTarget.dataset.id
    const n = id ? N.get(id) : null
    if (!n) return
    wx.vibrateShort({ type: 'light' })
    this.setData({
      menu: { id: n.id, pinned: n.pinned, title: N.titleOf(n) }
    })
  },

  closeMenu() {
    this.setData({ menu: null })
  },

  noop() {},

  onMenuPin() {
    const m = this.data.menu
    if (!m) return
    N.togglePin(m.id)
    const pinned = !m.pinned
    this.setData({ menu: null })
    this.load()
    wx.showToast({ title: pinned ? '已置顶' : '已取消置顶', icon: 'none' })
  },

  onMenuCopy() {
    const m = this.data.menu
    if (!m) return
    const n = N.get(m.id)
    if (!n) return
    const text = [(n.title || '').trim(), (n.body || '').trim()].filter(Boolean).join('\n')
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制', icon: 'success' })
    })
    this.setData({ menu: null })
  },

  onMenuDelete() {
    const m = this.data.menu
    if (!m) return
    this.setData({ menu: null })
    wx.showModal({
      title: '删除便签',
      content: '删掉就找不回来了，确定？',
      confirmText: '删除',
      confirmColor: '#D6453B',
      success: (r) => {
        if (!r.confirm) return
        N.remove(m.id)
        this.load()
        wx.showToast({ title: '已删除', icon: 'none' })
      }
    })
  }
})
