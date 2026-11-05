#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把小程序首页 / 登录设置页的 WXSS 转成浏览器可直接看的静态预览。
只给「改版后长什么样」这一个用途，不参与小程序打包。

  python gen-preview-home.py
"""
import io
import os
import re

ROOT = os.path.dirname(os.path.abspath(__file__))
MP = os.path.join(ROOT, 'miniprogram')


def wxss_to_css(path):
    s = io.open(path, encoding='utf-8').read()
    # page 选择器 → :root（浏览器里没有 page 元素）
    s = re.sub(r'(^|\n)page\s*\{', r'\1:root {', s)
    # rpx → px：按 750 设计稿对 375px 屏，1rpx = 0.5px
    s = re.sub(r'(-?\d+(?:\.\d+)?)rpx', lambda m: '%gpx' % (float(m.group(1)) / 2), s)
    # 小程序内置标签 → HTML 标签
    s = s.replace('view, text, scroll-view, input, textarea, button', 'div, span, input, textarea, button')
    s = s.replace('env(safe-area-inset-bottom)', '0px')
    s = s.replace('env(safe-area-inset-top)', '0px')
    return s


app_css = wxss_to_css(os.path.join(MP, 'app.wxss'))
home_css = wxss_to_css(os.path.join(MP, 'pages/index/index.wxss'))
acc_css = wxss_to_css(os.path.join(MP, 'pages/accounts/accounts.wxss'))

TASK = '''
      <div class="task {cls}">
        <div class="task-bar" style="background:{color}"></div>
        <div class="task-main">
          <div class="task-top">
            <span class="tag {tag}">{pname}</span>
            <span class="task-course">{course}</span>
          </div>
          <div class="task-title {tcls}">{title}<span class="{badge_cls}">{badge}</span></div>
          <div class="task-foot">
            <span class="task-type">📖 练习</span>
            <span class="task-dl {dl}">{dltext}</span>
          </div>
        </div>
      </div>
'''


def task(title, course, color, tag, pname, dl='dl-none', dltext='无截止', badge='', badge_cls='', tcls='', cls=''):
    return TASK.format(title=title, course=course, color=color, tag=tag, pname=pname,
                       dl=dl, dltext=dltext, badge=badge, badge_cls=badge_cls, tcls=tcls, cls=cls)


HOME = '''
<div class="phone">
<div class="page">
  <div class="hero" style="padding-top:44px">
    <div class="hero-glow"></div>
    <div class="hero-glow2"></div>
    <div class="nav" style="height:44px">
      <span class="nav-title">郑好有你</span>
      <div class="nav-actions">
        <div class="nav-acc"><span class="nav-acc-ico">⚙</span><span class="nav-acc-txt">登录设置</span></div>
        <div class="theme-btn"><span class="theme-ico">🌙</span></div>
        <div class="sync-btn"><span class="sync-ico">⟳</span></div>
      </div>
    </div>
    <div class="hero-body">
      <div class="hero-line">
        <span class="hero-greet">晚上好</span>
        <span class="hero-date">10月27日 周二</span>
      </div>
      <div class="hero-count-row">
        <span class="hero-num">13</span>
        <span class="hero-unit">项待完成</span>
      </div>
      <div class="hero-pills">
        <div class="pill pill-danger"><span class="pill-dot"></span>3 项已过期</div>
        <div class="pill">3 项 7 天内截止</div>
        <div class="pill">完成率 62%</div>
      </div>
      <div class="hero-sync">
        <span class="hero-sync-ico">⟳</span>
        <span class="hero-sync-txt">同步全部课程和任务</span>
      </div>
    </div>
  </div>

  <div class="plat-row">
    <div class="plat-card">
      <div class="plat-head"><div class="dot" style="background:#E8453C"></div><span class="plat-name">学习通</span></div>
      <span class="plat-count">6</span><span class="plat-status">2 小时前同步</span>
    </div>
    <div class="plat-card">
      <div class="plat-head"><div class="dot" style="background:#2B7FFF"></div><span class="plat-name">希冀</span></div>
      <span class="plat-count">4</span><span class="plat-status">刚刚同步</span>
    </div>
    <div class="plat-card is-unbound">
      <div class="plat-head"><div class="dot" style="background:#7C4DFF"></div><span class="plat-name">U校园</span></div>
      <span class="plat-count">—</span><span class="plat-status">点击绑定</span>
    </div>
  </div>

  <div class="tool-row">
    <div class="tool-card">
      <div class="tool-top"><div class="tool-badge tool-badge-notes">📝</div><span class="tool-num">3</span><span class="tool-arrow">›</span></div>
      <span class="tool-name">记事本</span><span class="tool-sub">最近记了 3 条</span>
    </div>
    <div class="tool-card">
      <div class="tool-top"><div class="tool-badge tool-badge-focus">⏱</div><span class="tool-num">🍅2</span><span class="tool-arrow">›</span></div>
      <span class="tool-name">专注</span><span class="tool-sub">今日专注 50 分钟</span>
    </div>
  </div>

  <div class="chips-row">
    <div class="chips" style="padding:0;flex:1;overflow:hidden">
      <div class="chip is-on"><span class="chip-name">全部</span><span class="chip-num">13</span></div>
      <div class="chip"><span class="chip-name">学习通</span><span class="chip-num">6</span></div>
      <div class="chip"><span class="chip-name">希冀</span><span class="chip-num">4</span></div>
    </div>
    <div class="add-fab"><span class="add-fab-ico">＋</span><span class="add-fab-txt">新任务</span></div>
  </div>

  <div class="today-card">
    <div class="today-head">
      <div class="today-head-left">
        <span class="today-title">今天 · 周二</span>
        <span class="today-week">第 8 周</span>
      </div>
      <span class="today-more">课表 ›</span>
    </div>
    <div class="today-row">
      <span class="today-period">1-2</span>
      <span class="today-name">离散数学</span>
      <span class="today-place">南4_102</span>
    </div>
    <div class="today-row">
      <span class="today-period is-now">7-8</span>
      <span class="today-name">汇编语言</span>
      <span class="today-place">南4_103</span>
    </div>
    <div class="today-state">正在上：汇编语言</div>
  </div>

  <div class="group-head">
    <div class="group-left">
      <span class="group-dot gd-danger"></span>
      <span class="group-title">已过期</span>
      <span class="group-count">2</span>
    </div>
  </div>
  ''' + task('Unit 3 A journey of discovery · Unit Test', '26秋25级大英3 视听说', '#7C4DFF', 'p-unipus',
              'U校园', 'dl-expired', '已截止 9 天', '必做', 'req-badge', 'is-required') + \
    task('Unit 3 A journey of discovery · Further Listening', '26秋25级大英3 视听说', '#7C4DFF', 'p-unipus',
         'U校园', 'dl-expired', '已截止 9 天', '必做', 'req-badge', 'is-required') + '''
  <div class="group-head">
    <div class="group-left">
      <span class="group-dot gd-normal"></span>
      <span class="group-title">一周内</span>
      <span class="group-count">2</span>
    </div>
  </div>
  ''' + task('第三次汇编实验报告', '汇编语言', '#2B7FFF', 'p-educoder', '希冀', 'dl-urgent', '明天 23:59') + \
    task('Unit 5 A taste of culture · Unit Test', '26秋25级大英3 视听说', '#7C4DFF', 'p-unipus',
         'U校园', 'dl-soon', '11月15日 23:59', '必做', 'req-badge', 'is-required') + '''
  <div class="group-head">
    <div class="group-left">
      <span class="group-dot gd-muted"></span>
      <span class="group-title">不用做</span>
      <span class="group-count">1</span>
    </div>
    <span class="group-more">展开</span>
  </div>
  ''' + task('Unit 1 · 预习材料', '26秋25级大英3 视听说', '#7C4DFF', 'p-unipus', 'U校园',
              'dl-none', '无截止', '选做', 'opt-badge', 'is-optional') + '''
  <div class="footer-note">上次同步 · 刚刚 · 服务 20261027.13</div>
</div>
</div>
'''

ACCOUNTS = '''
<div class="phone">
<div class="page">
  <div style="padding:44px 32px 0">
    <div class="head" style="padding:0">
      <span class="head-title">登录设置</span>
      <span class="head-desc">在这里登录/绑定各个学习平台。绑定后，小程序会替你登录并汇总所有未完成的任务点、作业与考试。</span>
    </div>
  </div>
  <div style="padding:0 32px">
    <div class="warn" style="margin-left:0;margin-right:0">
      <span class="warn-ico">🔒</span>
      <div class="warn-body">
        <span class="warn-title">关于账号安全</span>
        <span class="warn-text">密码经加密后只保存在你自己的云数据库里，按 OpenID 隔离，仅用于模拟登录抓取数据。</span>
      </div>
    </div>
  </div>

  <div class="plat" style="margin:24px 16px 0">
    <div class="plat-top">
      <div class="dot" style="background:#E8453C"></div>
      <div class="plat-info">
        <span class="plat-name">学习通</span>
        <span class="plat-desc">超星学习通 · 任务点 / 作业 / 考试</span>
      </div>
      <span class="state-badge on">已绑定</span>
      <span class="chev">›</span>
    </div>
    <div class="bound">
      <div class="bound-row">
        <span class="bound-user">202515020339</span>
        <span class="bound-mode">账号密码</span>
      </div>
      <span class="bound-status">2 小时前同步成功</span>
      <div class="bound-ops">
        <span class="op">立即同步</span>
        <span class="op">网络自检</span>
        <span class="op">修改</span>
        <span class="op danger">解绑</span>
      </div>
    </div>
  </div>

  <div class="plat" style="margin:16px 16px 0">
    <div class="plat-top">
      <div class="dot" style="background:#2B7FFF"></div>
      <div class="plat-info">
        <span class="plat-name">希冀</span>
        <span class="plat-desc">编程类课程实验与作业</span>
      </div>
      <span class="state-badge">未绑定</span>
      <span class="chev">›</span>
    </div>
  </div>

  <div class="intra fold" id="edu-card">
    <div class="fold-head">
      <div class="fold-main">
        <div class="fold-title-row">
          <span class="fold-ico">🏫</span>
          <span class="fold-title">希冀 · 校园内网直连</span>
          <span class="intra-badge">需校园网</span>
        </div>
        <span class="fold-sum">学号 + 希冀密码 + 图片验证码，手机直连内网抓任务（云函数进不去内网）</span>
      </div>
      <div class="fold-right">
        <span class="fold-state">未登录</span>
        <span class="fold-chev">›</span>
      </div>
    </div>
  </div>

  <div class="intra fold">
    <div class="fold-head">
      <div class="fold-main">
        <div class="fold-title-row">
          <span class="fold-ico">📅</span>
          <span class="fold-title">课表导入</span>
          <span class="intra-badge">手机直接用</span>
        </div>
        <span class="fold-sum">统一认证登录 + 短信验证码，课表自动写进「课表」页</span>
      </div>
      <div class="fold-right">
        <span class="fold-state is-on">已登录</span>
        <span class="fold-chev">›</span>
      </div>
    </div>
  </div>

  <div class="intra fold">
    <div class="fold-head">
      <div class="fold-main">
        <div class="fold-title-row">
          <span class="fold-ico">🏫</span>
          <span class="fold-title">希冀 · 校园内网直连</span>
          <span class="intra-badge">需校园网</span>
        </div>
      </div>
      <div class="fold-right">
        <span class="fold-state is-on">已登录</span>
        <span class="fold-chev up">›</span>
      </div>
    </div>
    <div class="fold-body">
      <span class="intra-desc">展开状态：下面是表单（学号 / 密码 / 验证码 + 登录按钮）。收起时这一整块都不占地方。</span>
      <div class="field column"><span class="field-label">学号</span><div class="field-input" style="line-height:72px">202515020339</div></div>
      <div class="field column"><span class="field-label">希冀密码</span><div class="field-input" style="line-height:72px">••••••••</div></div>
      <div class="edu-actions">
        <button class="btn-ghost">仅保存</button>
        <button class="btn-primary">登录</button>
      </div>
    </div>
  </div>

  <div class="foot-note">
    <span>抓取逻辑基于各平台网页端接口，平台改版后可能短暂失效。</span>
  </div>
</div>
</div>
'''

HTML = '''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>改版预览 · 首页 / 登录设置</title>
<style>
%s
%s
%s
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  background: #E9EAF1;
  background-image:
    radial-gradient(circle at 18%% 0%%, rgba(139,92,246,.12), transparent 46%%),
    radial-gradient(circle at 84%% 12%%, rgba(99,102,241,.1), transparent 42%%);
  padding: 36px 24px 56px;
  display: flex;
  gap: 40px;
  justify-content: center;
  align-items: flex-start;
  flex-wrap: wrap;
}
.wrap { display: flex; flex-direction: column; gap: 12px; }
.wrap-title {
  text-align: center; font-size: 14px; font-weight: 600; color: #4A4D63;
  letter-spacing: .4px;
}
.phone {
  width: 375px; height: auto; overflow: hidden;
  background: #F4F5F9; border-radius: 34px;
  box-shadow: 0 18px 46px rgba(30,34,60,.18), 0 0 0 8px #fff;
  position: relative;
}
.phone::-webkit-scrollbar { width: 0; }
.page { min-height: 100%%; }
.nav-actions { margin-right: 96px; }
</style>
</head>
<body>
<div class="wrap"><div class="wrap-title">首页（改版后）</div>%s</div>
<div class="wrap"><div class="wrap-title">登录设置（电脑辅助登录已移除 + 两块折叠）</div>%s</div>
</body>
</html>
''' % (app_css, home_css, acc_css, HOME, ACCOUNTS)

out = os.path.join(ROOT, 'preview-home.html')
io.open(out, 'w', encoding='utf-8').write(HTML)
print('written', out, len(HTML))
