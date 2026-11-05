const api = require('../../utils/api')
const M = require('../../utils/model')
const theme = require('../../utils/theme')
const app = getApp()

Page({
  data: {
    task: null,
    notFound: false,
    busy: false
  },

  onLoad(options) {
    theme.apply(this)
    const id = options && options.id
    const list = app.globalData.currentTasks || []
    const raw = list.find((t) => (t._id || t.id) === id)
    if (!raw) {
      this.setData({ notFound: true })
      return
    }
    const dl = M.formatDeadline(raw.deadline)
    const p = M.platformOf(raw.platform)
    this.setData({
      task: {
        id: raw._id || raw.id,
        platform: raw.platform,
        pName: p.name,
        pTag: p.tag,
        pColor: p.color,
        courseName: raw.courseName || '未知课程',
        title: raw.title || '未命名任务',
        typeLabel: M.typeOf(raw.taskType).label,
        status: raw.status,
        url: raw.url || '',
        deadline: raw.deadline || 0,
        deadlineText: raw.deadline ? M.fmtDate(raw.deadline) + ' ' + M.fmtTime(raw.deadline) : '无截止时间',
        dlText: dl.text,
        dlLevel: dl.level,
        progress: raw.progress || null,
        progressText:
          raw.progress && raw.progress.total > 1
            ? `${raw.progress.done} / ${raw.progress.total}`
            : '',
        percentText:
          raw.progress && raw.progress.total > 1
            ? Math.round((raw.progress.done / raw.progress.total) * 100)
            : 0
      }
    })
  },

  copyUrl() {
    const url = this.data.task && this.data.task.url
    if (!url) {
      wx.showToast({ title: '这条任务没有附带链接', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: url,
      success: () =>
        wx.showModal({
          title: '链接已复制',
          content: '小程序无法直接打开外部网页，请粘贴到手机浏览器里打开。',
          showCancel: false
        })
    })
  },

  toggleStatus() {
    if (this.data.busy || !this.data.task) return
    const next = this.data.task.status !== 'done'
    this.setData({ busy: true })
    api
      .toggleTask(this.data.task.id, next)
      .then(() => {
        app.globalData.needRefresh = true
        this.setData({
          'task.status': next ? 'done' : 'todo',
          busy: false
        })
        wx.showToast({ title: next ? '已标记完成' : '已取消完成', icon: 'success' })
        setTimeout(() => wx.navigateBack(), 600)
      })
      .catch((e) => {
        this.setData({ busy: false })
        wx.showModal({ title: '操作失败', content: e.message, showCancel: false })
      })
  },

  goAccounts() {
    wx.navigateTo({ url: '/pages/accounts/accounts' })
  }
})
