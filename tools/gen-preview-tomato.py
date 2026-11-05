#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把「专注」页的 WXSS 转成浏览器可直接看的静态预览。
只给「改版后长什么样」这一个用途，不参与小程序打包。

  python gen-preview-tomato.py
"""
import io
import os
import re

ROOT = os.path.dirname(os.path.abspath(__file__))
MP = os.path.join(ROOT, 'miniprogram')


def wxss_to_css(path):
    s = io.open(path, encoding='utf-8').read()
    s = re.sub(r'(^|\n)page\s*\{', r'\1:root {', s)
    s = re.sub(r'(-?\d+(?:\.\d+)?)rpx', lambda m: '%gpx' % (float(m.group(1)) / 2), s)
    s = s.replace('view, text, scroll-view, input, textarea, button', 'div, span, input, textarea, button')
    s = s.replace('env(safe-area-inset-bottom)', '0px')
    s = s.replace('env(safe-area-inset-top)', '0px')
    return s


app_css = wxss_to_css(os.path.join(MP, 'app.wxss'))
tmt_css = wxss_to_css(os.path.join(MP, 'pages/tomato/tomato.wxss'))

# ---- 圆环：canvas 在静态页里画不出来，用 SVG 顶一下（只为看版式） ----
def ring(ratio, color, dial=False, size=210, dark=False):
    """dial=True 画「准备中」的表盘：半透明弧 + 一圈刻度 + 白心指针。"""
    import math
    r = size / 2 - 9
    c = size / 2
    circ = 2 * math.pi * r
    dash = circ * max(0.0, min(1.0, ratio))
    ticks = ''
    if dial:
        tr = r - 7.5 / 2 - 6
        for i in range(12):
            a = -math.pi / 2 + 2 * math.pi * i / 12
            kx = c + math.cos(a) * tr
            ky = c + math.sin(a) * tr
            rad = 2.4 if i == 0 else 1.7
            ticks += ('<circle cx="%g" cy="%g" r="%g" fill="%s"/>'
                      % (kx, ky, rad, 'rgba(255,255,255,.3)' if dark else 'rgba(20,24,45,.2)'))
        a = -math.pi / 2 + 2 * math.pi * max(0.0, min(1.0, ratio))
        kx = c + math.cos(a) * r
        ky = c + math.sin(a) * r
        ticks += ('<circle cx="%g" cy="%g" r="11" fill="%s" stroke="%s" stroke-width="4"/>'
                  % (kx, ky, '#191A26' if dark else '#FFFFFF', color))
    return (
        '<svg width="%g" height="%g" viewBox="0 0 %g %g" style="position:absolute;inset:0">'
        '<circle cx="%g" cy="%g" r="%g" fill="none" stroke="#ECEDF3" stroke-width="7.5"/>'
        '%s'
        '<circle cx="%g" cy="%g" r="%g" fill="none" stroke="%s" stroke-width="7.5" '
        'stroke-linecap="round" stroke-dasharray="%g %g" transform="rotate(-90 %g %g)" opacity="%s"/>'
        '</svg>'
    ) % (size, size, size, size, c, c, r, ticks, c, c, r, color, dash, circ, c, c,
         '0.55' if dial else '1')


TAGS = {
    'study': ('学习', '#6366F1'),
    'rest': ('休息', '#10B981'),
    'life': ('生活', '#F59E0B'),
}


def pill(tag):
    t, _ = TAGS[tag]
    return '<span class="tag-pill tag-%s">%s</span>' % (tag, t)


def todo(title, tag, pomos=0, picked=False, done=False):
    return '''
    <div class="todo">
      <div class="todo-check %s %s"><span class="todo-check-ico">%s</span></div>
      <div class="todo-main">
        <span class="todo-name %s">%s</span>
        <div class="todo-meta">
          %s
          %s
          %s
        </div>
      </div>
      <span class="todo-go">▶</span>
    </div>
''' % (
        'is-done' if done else '',
        'is-picked' if picked else '',
        '✓' if done else '',
        'is-done' if done else '',
        title,
        pill(tag),
        '<span class="todo-pomo">🍅 %d</span>' % pomos if pomos else '',
        '<span class="todo-tag">正在专注</span>' if picked else '',
    )


BARS = [
    ('三', 0, ''), ('四', 62, '31分'), ('五', 100, '50分'), ('六', 0, ''),
    ('日', 38, '19分'), ('一', 84, '42分'), ('今天', 47, '23分'),
]
BAR_HTML = ''.join(
    '<div class="bar-col"><span class="bar-val">%s</span>'
    '<div class="bar-track"><div class="bar-fill %s" style="height:%d%%"></div></div></div>'
    % (t, 'is-now' if l == '今天' else '', p)
    for l, p, t in BARS
)
BAR_LAB = ''.join(
    '<span class="bar-lab %s">%s</span>' % ('is-now' if l == '今天' else '', l)
    for l, p, t in BARS
)


def kw_row(name, txt, pct, sub):
    return '''
    <div class="kw-row">
      <div class="kw-top"><span class="kw-name">%s</span><span class="kw-val">%s</span></div>
      <div class="kw-track"><div class="kw-fill" style="width:%d%%"></div></div>
      <span class="kw-sub">%s</span>
    </div>
''' % (name, txt, pct, sub)


KW_HTML = (
    '<div class="kw">'
    '<span class="kw-head">按待办关键词 · 跟上面这张图同一段</span>'
    + kw_row('健身房', '36 分 20 秒', 100, '3 次')
    + kw_row('跑步', '21 分 05 秒', 58, '2 次')
    + kw_row('做饭', '8 分 40 秒', 24, '1 次')
    + '</div>'
)


def timer_card(dark, ratio, color, mode_txt, time_txt, task, idle=False):
    """idle=True 画「准备专注」：表盘 + 刻度 + 指针 + 时长快捷键。"""
    inner_mode = 'ring-mode' if idle else 'ring-mode is-focus'
    if idle:
        extra = ('<span class="ring-drag">按住圆环转 · 一圈 59 分钟</span>'
                 '<div class="ctrl"><button class="ctrl-main">开始专注</button></div>'
                 '<div class="quick">'
                 '<div class="quick-chip">15</div><div class="quick-chip">25</div>'
                 '<div class="quick-chip">45</div><div class="quick-chip">60</div>'
                 '<div class="quick-chip quick-more is-on"><span>32 分</span></div>'
                 '</div>'
                 '<span class="timer-hint">选好待办后点「开始专注」，完成后自动记一个番茄</span>')
    else:
        extra = ('<div class="ctrl"><button class="ctrl-main is-running">暂停</button>'
                 '<button class="ctrl-sub">放弃</button></div>')
    return '''
  <div class="timer-card">
    <div class="ring-wrap">
      %s
      <div class="ring-inner">
        <span class="%s">%s</span>
        <span class="ring-time">%s</span>
        <span class="ring-task">%s</span>
      </div>
    </div>
    %s
  </div>
''' % (ring(ratio, color, dial=idle, dark=dark), inner_mode, mode_txt, time_txt, task, extra)


def page(dark, tab, idle=False):
    """tab: study / rest / life —— 三块统计各来一屏"""
    title = {'study': '学习时长', 'rest': '休息时长', 'life': '生活时长'}[tab]
    if tab == 'study':
        total, sub = '12 小时 45 分', '31 个番茄'
        tiles = [('今天', [('23', '分')], '1 个番茄'),
                 ('本周', [('4', '小时'), ('10', '分')], '11 个番茄 · 5 天'),
                 ('本月', [('12', '小时'), ('45', '分')], '31 个番茄 · 14 天'),
                 ('今年', [('128', '小时'), ('40', '分')], '402 个番茄')]
        ring_ratio, ring_color, ring_txt, mode_txt = 0.47, '#6366F1', '12:18', '专注中'
        foot = '近 7 天合计 2 小时 45 分'
        foot_cls = ''
    elif tab == 'rest':
        total, sub = '2 小时 05 分', '19 次'
        tiles = [('今天', [('5', '分')], '1 次休息'),
                 ('本周', [('42', '分')], '5 次休息 · 4 天'),
                 ('本月', [('2', '小时'), ('5', '分')], '19 次休息 · 9 天'),
                 ('今年', [('18', '小时'), ('30', '分')], '160 次休息')]
        ring_ratio, ring_color, ring_txt, mode_txt = 0.60, '#10B981', '03:00', '休息中'
        foot = '近 7 天合计 31 分'
        foot_cls = ''
    else:
        total, sub = '1 小时 06 分', '6 次'
        tiles = [('今天', [('12', '分'), ('40', '秒')], '2 次'),
                 ('本周', [('48', '分'), ('20', '秒')], '5 次 · 3 天'),
                 ('本月', [('1', '小时'), ('6', '分')], '6 次 · 4 天'),
                 ('今年', [('1', '小时'), ('6', '分')], '6 次')]
        ring_ratio, ring_color, ring_txt, mode_txt = 0.24, '#6366F1', '06:00', '专注中'
        foot = '近 7 天合计 1 小时 06 分'
        foot_cls = ''

    kind_tabs = ''.join(
        '<span class="learn-kind-item %s">%s</span>'
        % ('is-on' if k == tab else '', TAGS[k][0])
        for k in ('study', 'rest', 'life')
    )
    tile_html = ''.join(
        '<div class="learn-tile"><span class="learn-tile-label">%s</span>'
        '<div class="learn-tile-val">%s</div>'
        '<span class="learn-tile-sub">%s</span></div>'
        % (lab, ''.join('<span class="lt-num">%s</span><span class="lt-unit">%s</span>' % (n, u) for n, u in parts), s)
        for lab, parts, s in tiles
    )

    if idle:
        ratio, color, m_txt, t_txt = 32 / 59.0, '#6366F1', '准备专注', '32:00'
    else:
        ratio, color, m_txt, t_txt = ring_ratio, ring_color, mode_txt, ring_txt
    task_txt = '还没选任务，也能直接开始' if idle else '复习高数第三章'
    timer_html = timer_card(dark, ratio, color, m_txt, t_txt, task_txt, idle=idle)

    return '''
<div class="phone %s">
<div class="page">
  <div class="head" style="padding-top:20px">
    <div class="nav" style="height:44px">
      <div class="nav-back"><span class="nav-back-ico">‹</span></div>
      <span class="nav-title">专注</span>
      <div class="nav-set"><span class="nav-set-ico">⚙</span></div>
    </div>
  </div>

  <div class="stat-card">
    <div class="stat"><span class="stat-num">6<span class="stat-unit">/8</span></span><span class="stat-label">今日番茄</span></div>
    <div class="stat-line"></div>
    <div class="stat"><span class="stat-num">158</span><span class="stat-label">专注分钟</span></div>
    <div class="stat-line"></div>
    <div class="stat"><span class="stat-num">15</span><span class="stat-label">休息分钟</span></div>
    <div class="stat-line"></div>
    <div class="stat"><span class="stat-num">12</span><span class="stat-label">连续天数</span></div>
    <div class="goal-bar"><div class="goal-fill" style="width:75%%"></div></div>
  </div>

  %s

  <div class="learn-card">
    <div class="learn-head">
      <div class="learn-head-top">
        <span class="learn-title">%s</span>
        <div class="learn-kind">%s</div>
      </div>
      <span class="learn-total">累计 %s · %s</span>
    </div>
    <div class="learn-grid">%s</div>
    <div class="learn-tabs">
      <div class="learn-tab is-on">日</div>
      <div class="learn-tab">周</div>
      <div class="learn-tab">月</div>
      <div class="learn-tab">年</div>
    </div>
    <div class="bars">%s</div>
    <div class="bar-labs">%s</div>
    %s
    <span class="learn-foot">%s</span>
  </div>

  <div class="todo-card">
    <div class="todo-head">
      <div class="todo-head-left"><span class="todo-title">今日待办</span><span class="todo-count">3 项未完成</span></div>
      <div class="todo-add-btn"><span class="todo-add-ico">＋</span></div>
    </div>
    %s
    %s
    %s
    %s
    <div class="todo-tip">点圆圈打勾 · 点整行开始专注 · 点标签换分类 · 长按删除</div>
  </div>

  <div class="safe-bottom"></div>
</div>
</div>
''' % (
        'theme-dark' if dark else '',
        timer_html,
        title, kind_tabs, total, sub, tile_html,
        BAR_HTML, BAR_LAB,
        KW_HTML if tab == 'life' else '',
        foot,
        todo('复习高数第三章', 'study', 2, picked=True),
        todo('健身 30 分钟', 'life', 1),
        todo('午休', 'rest', 0),
        todo('写实验报告', 'study', 3, done=True),
    )


SHELL = '''<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>专注页 · 静态预览</title>
<style>
%s
%s
body { margin: 0; padding: 24px; background: #EEF0F5; font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; }
.row { display: flex; gap: 24px; justify-content: center; align-items: flex-start; flex-wrap: wrap; }
.phone { width: 375px; height: 1560px; overflow: hidden; border-radius: 28px; box-shadow: 0 12px 40px rgba(20,24,45,.2); background: #F5F6FA; position: relative; }
.phone.theme-dark { background: #12131A; }
.phone .page { height: 100%%; overflow: hidden; }
.cap { text-align: center; font-size: 12px; color: #6B7280; margin: 8px 0 14px; }
</style></head><body>
<div class="row">%s</div>
</body></html>'''

CAP_DIAL = '准备专注 · 表盘（按住圈转 = 调时长）'
CAP_STUDY = '学习 · 浅色'
CAP_LIFE = '生活 · 深色（关键词统计）'

body = (
    '<div><div class="cap">' + CAP_DIAL + '</div>' + page(False, 'study', idle=True) + '</div>'
    '<div><div class="cap">' + CAP_STUDY + '</div>' + page(False, 'study') + '</div>'
    '<div><div class="cap">' + CAP_LIFE + '</div>' + page(True, 'life') + '</div>'
)

out = os.path.join(ROOT, 'preview-tomato.html')
html = SHELL % (app_css, tmt_css, body)
io.open(out, 'w', encoding='utf-8').write(html)
print('wrote', out)

# 再来一份放大版：只把统计卡片和待办滚到可见区，用来看数字有没有顶出格子
ZOOM_EXTRA = '''
body { padding: 0; }
.row { gap: 16px; }
.phone { width: 375px; height: 700px; border-radius: 0; box-shadow: none; }
.phone .page { margin-top: -%dpx; }
.zoom-body .row { zoom: 1.7; }
'''

zoom = html.replace(
    '</style>', (ZOOM_EXTRA % 380) + '</style>'
).replace('<body>', '<body class="zoom-body">')
for cap in (CAP_DIAL, CAP_STUDY, CAP_LIFE):
    zoom = zoom.replace('<div class="cap">' + cap + '</div>', '')
out2 = os.path.join(ROOT, 'preview-tomato-zoom.html')
io.open(out2, 'w', encoding='utf-8').write(zoom)
print('wrote', out2)
