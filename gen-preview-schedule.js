/**
 * 生成 preview-schedule.html：把真实的 gridOf() 结果画成网页，
 * 用来核对网格定位、块高、配色。数值全来自 miniprogram/utils/schedule.js，
 * 所以图上看到的和真机上跑的是同一套计算。
 *
 *   node _gen-preview.js
 */
const fs = require('fs')
const S = require('./miniprogram/utils/schedule')

const TERM = new Date(2026, 8, 7) // 2026-09-07 周一 = 第 1 周
const SAMPLE = [
  '周一 1-2节 汇编语言 松园3-201 1-16周',
  '周一 3-4节 大学英语 北3-105 1-16周(单)',
  '周一 5-6节 高等数学A 松园1-101 1-16周',
  '周一 7-8节 大学物理A(I) 松园3-201 1-16周',
  '周二 1-2节 数据结构 松园2-301 1-16周',
  '周二 3-4节 汇编语言 松园3-201 1-16周',
  '周二 7-8节 体育 东操场 1-16周',
  '周三 1-2节 大学英语 北3-105 1-16周(单)',
  '周三 3-4节 软件工程导论 北3-201 1-16周',
  '周三 5-6节 数据结构 松园2-301 1-8周',
  '周四 1-2节 高等数学A 松园1-101 1-16周',
  '周四 5-6节 软件工程导论 北3-201 1-16周',
  '周四 9-10节 创新创业基础 线上 1-4周',
  '周五 1-2节 大学物理A(I) 松园3-201 1-16周',
  '周五 3-4节 数据结构 松园2-301 1-16周',
  '周五 9-10节 军事理论 线上 双周'
]
const items = S.parseText(SAMPLE.join('\n')).items
const now = new Date(2026, 9, 24, 10, 0) // 周六，第 7 周
const weekNo = S.weekNoOf(now, TERM)
const g = S.gridOf(items, weekNo, { termStart: TERM, now })

const px = (rpx) => Math.round(rpx / 2)

const gridHtml = `
<div class="grid">
  <div class="col col-time">
    <div class="col-head"></div>
    ${g.rows.map((r) => `<div class="cell cell-no" style="height:${px(g.rowH)}px"><span>${r.no}</span></div>`).join('')}
  </div>
  ${g.days
    .map(
      (d) => `
  <div class="col">
    <div class="col-head ${d.isToday ? 'is-today' : ''}">
      <span class="ch-d">${d.name}</span>
      <span class="ch-date">${d.date}</span>
    </div>
    <div class="col-body" style="height:${px(g.bodyH)}px">
      ${g.rows.map((r) => `<div class="cell" style="height:${px(g.rowH)}px"></div>`).join('')}
      ${d.items
        .map(
          (b) => `<div class="blk" style="top:${px(b.top)}px;height:${px(b.height)}px;background:${b.bg};color:${b.fg};border-left-color:${b.bar}">
        <span class="blk-name">${b.name}</span>
        ${b.showPlace ? `<span class="blk-place">${b.place}</span>` : ''}
      </div>`
        )
        .join('')}
    </div>
  </div>`
    )
    .join('')}
</div>`

const monday = new Date(S.mondayOf(TERM))
monday.setDate(monday.getDate() + (weekNo - 1) * 7)
const sunday = new Date(monday)
sunday.setDate(monday.getDate() + 6)

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>课表网格预览 · 课业看板</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    background: #EEF0F5;
    display: flex; gap: 28px; padding: 32px; align-items: flex-start;
    flex-wrap: wrap;
  }
  .phone {
    width: 375px; background: #F4F5F9; border-radius: 34px; overflow: hidden;
    box-shadow: 0 18px 50px rgba(28, 31, 56, 0.16);
    border: 1px solid #DDE0E9;
  }
  .phone-label {
    font-size: 12px; color: #7A7F92; font-weight: 600; letter-spacing: .5px;
    margin-bottom: 10px; text-transform: uppercase;
  }
  .wrap { display: flex; flex-direction: column; }
  .page { padding: 0 8px 18px; }

  .head { display: flex; align-items: flex-end; justify-content: space-between; padding: 18px 4px 8px; }
  .head-left { display: flex; align-items: baseline; }
  .head-title { font-size: 22px; font-weight: 700; color: #1B1D29; letter-spacing: -.3px; }
  .head-sub { margin-left: 7px; font-size: 11px; color: #8E92A6; }
  .head-set { font-size: 13px; color: #4C45D6; padding: 4px 10px; background: #EDECFC; border-radius: 999px; }

  .weekbar {
    display: flex; align-items: center; background: #fff; border-radius: 10px;
    padding: 6px; margin: 0 4px 8px; box-shadow: 0 3px 10px rgba(28,31,56,.05);
  }
  .wk-btn { width: 30px; height: 30px; line-height: 28px; text-align: center; font-size: 19px; color: #4C45D6; background: #F3F2FE; border-radius: 7px; }
  .wk-mid { flex: 1; display: flex; flex-direction: column; align-items: center; }
  .wk-no { font-size: 15px; font-weight: 600; color: #1B1D29; }
  .wk-date { font-size: 10px; color: #9A9EB2; margin-top: 1px; }

  .grid { display: flex; background: #fff; border-radius: 10px; padding: 4px 3px 6px; box-shadow: 0 4px 12px rgba(28,31,56,.06); }
  .col { flex: 1; min-width: 0; }
  .col-time { flex: none; width: 23px; }
  .col-head { height: 32px; display: flex; flex-direction: column; align-items: center; justify-content: center; border-radius: 6px; margin-bottom: 3px; }
  .col-head.is-today { background: #4C45D6; }
  .ch-d { font-size: 11px; font-weight: 600; color: #444860; }
  .ch-date { font-size: 8.5px; color: #A6AABB; margin-top: .5px; }
  .col-head.is-today .ch-d { color: #fff; }
  .col-head.is-today .ch-date { color: #fff; opacity: .8; }
  .col-body { position: relative; }
  .cell { border-bottom: 1px solid #F2F3F7; }
  .cell-no { display: flex; align-items: flex-start; justify-content: center; padding-top: 3px; }
  .cell-no span { font-size: 9px; color: #C0C3D2; }
  .blk {
    position: absolute; left: 1px; right: 1px; border-radius: 5px; border-left: 2.5px solid #6C63E8;
    padding: 3px 2.5px; overflow: hidden; display: flex; flex-direction: column;
  }
  .blk-name { font-size: 9px; line-height: 1.22; font-weight: 600; word-break: break-all; }
  .blk-place { font-size: 8px; line-height: 1.2; opacity: .72; margin-top: 1.5px; word-break: break-all; }

  .tools { display: flex; margin: 10px 4px 0; }
  .tool { flex: 1; height: 44px; background: #fff; border-radius: 9px; display: flex; align-items: center; justify-content: center; box-shadow: 0 3px 9px rgba(28,31,56,.05); }
  .tool + .tool { margin-left: 8px; }

  /* 教务导入面板 */
  .phone { position: relative; }
  .page-dim { opacity: .5; }
  .sheet { position: absolute; left: 0; right: 0; bottom: 0; background: #fff;
           border-radius: 22px 22px 0 0; padding: 14px 18px 24px;
           box-shadow: 0 -8px 30px rgba(20,24,60,.14); }
  .sheet-bar { width: 36px; height: 4px; border-radius: 2px; background: #E2E4EC; margin: 0 auto 14px; }
  .sheet-title { font-size: 16px; font-weight: 700; color: #1B1D2A; }
  .sheet-desc { margin-top: 5px; font-size: 11.5px; color: #8E92A6; line-height: 1.65; }
  .jw-step { display: flex; align-items: flex-start; padding: 7px 0; }
  .jw-n { width: 18px; height: 18px; line-height: 18px; text-align: center; border-radius: 50%;
          background: #EDECFC; color: #4C45D6; font-size: 11px; font-weight: 700;
          flex: 0 0 auto; margin-right: 8px; margin-top: 1px; }
  .jw-txt { flex: 1; display: flex; flex-direction: column; }
  .jw-t { font-size: 13px; color: #1C1F38; font-weight: 600; }
  .jw-d { font-size: 10.5px; color: #8E92A6; line-height: 1.5; margin-top: 2px; }
  .jw-live { margin-top: 10px; background: #E7F7EE; border-radius: 7px; padding: 8px 10px;
             font-size: 11.5px; color: #15803D; line-height: 1.55; }
  .jw-alt { margin-top: 9px; text-align: center; font-size: 11.5px; color: #4C45D6; }
  .sheet-btns { display: flex; margin-top: 14px; }
  .sbtn { flex: 1; height: 44px; line-height: 44px; text-align: center;
          border-radius: 9px; font-size: 13.5px; font-weight: 600; }
  .sbtn + .sbtn { margin-left: 8px; }
  .sbtn-ghost { background: #F3F4F8; color: #5A5F76; }
  .sbtn-primary { background: #4C45D6; color: #fff; }

  /* 登录设置 · 教务系统卡片 */
  .acc-card { margin-top: 6px; background: #fff; border-radius: 14px; padding: 14px 15px;
              box-shadow: 0 3px 12px rgba(28,31,56,.05); }
  .acc-head { display: flex; align-items: center; justify-content: space-between; }
  .acc-title { font-size: 13.5px; font-weight: 700; color: #1B1D2A; }
  .acc-badge { font-size: 10px; color: #B45309; background: #FEF3E2;
               border-radius: 6px; padding: 1px 6px; }
  .acc-desc { margin-top: 6px; font-size: 10.5px; color: #8E92A6; line-height: 1.65; }
  .acc-tabs { display: flex; background: #F2F3F8; border-radius: 8px; padding: 3px; margin: 8px 0 2px; }
  .acc-tab { flex: 1; text-align: center; font-size: 11px; color: #6B7089; padding: 6px 0; border-radius: 6px; }
  .acc-tab.on { background: #fff; color: #1C1F38; font-weight: 600;
                box-shadow: 0 1px 4px rgba(28,31,56,.08); }
  .acc-field { display: flex; flex-direction: column; gap: 5px; padding: 9px 0;
               border-bottom: 1px solid #F2F3F8; }
  .acc-label { font-size: 11.5px; color: #41445A; }
  .acc-input { background: #F7F8FB; border-radius: 7px; padding: 8px 10px;
               font-size: 12.5px; color: #1B1B27; }
  .acc-pick { display: flex; align-items: center; justify-content: space-between; }
  .acc-arrow { font-size: 10px; color: #A0A3B1; }
  .acc-muted { color: #6B7089; letter-spacing: 1px; }
  .acc-cap { display: flex; gap: 7px; }
  .acc-capimg { width: 78px; height: 34px; border-radius: 7px; background: #fff;
                border: 1px solid #E8EAF2; display: flex; align-items: center;
                justify-content: center; font-size: 13px; letter-spacing: 3px;
                color: #4C45D6; font-weight: 700; font-style: italic; flex: 0 0 auto; }
  .acc-capinput { flex: 1; color: #A0A3B1; }
  .acc-tip { margin-top: 9px; font-size: 10.5px; color: #A0A3B1; line-height: 1.6; }
  .acc-btns { display: flex; margin-top: 11px; }
  .acc-btn { flex: 1; height: 38px; line-height: 38px; text-align: center;
             border-radius: 8px; font-size: 12.5px; font-weight: 600; }
  .acc-btn + .acc-btn { margin-left: 7px; }
  .acc-ghost { background: #F3F4F8; color: #5A5F76; }
  .acc-primary { background: #4C45D6; color: #fff; }
  .acc-note { margin-top: 14px; font-size: 10.5px; color: #8E92A6; line-height: 1.75;
              background: #fff; border-radius: 12px; padding: 12px 14px; }
  .acc-note b { color: #41445A; }
  .tool-ico { font-size: 14px; margin-right: 5px; }
  .tool-txt { font-size: 13px; color: #3D4157; font-weight: 500; }
  .foot { margin: 11px 4px 0; font-size: 10.5px; color: #A6AABB; text-align: center; }

  /* 底部菜单 */
  .menu-demo { position: relative; background: #F4F5F9; height: 812px; }
  .dim { position: absolute; inset: 0; background: rgba(16,18,30,.4); }
  .tmenu {
    position: absolute; left: 0; right: 0; bottom: 0; background: #fff;
    border-radius: 14px 14px 0 0; padding: 13px 12px 20px;
  }
  .tmenu-head { padding: 0 4px 10px; border-bottom: 1px solid #F2F3F7; }
  .tmenu-name { display: block; font-size: 14px; font-weight: 600; color: #1B1D2A; line-height: 1.4; }
  .tmenu-sub { display: block; margin-top: 3px; font-size: 10.5px; color: #9A9CB0; }
  .tmenu-item { display: flex; align-items: center; height: 50px; padding: 0 4px; border-bottom: 1px solid #F6F7FA; }
  .tmenu-ico { width: 20px; font-size: 14px; color: #6C63E8; }
  .tmenu-txt { flex: 1; font-size: 14px; color: #2B2E40; }
  .tmenu-item.is-primary .tmenu-txt, .tmenu-item.is-primary .tmenu-ico { color: #4C45D6; font-weight: 600; }
  .tmenu-hint { font-size: 10px; color: #B4B6C4; }
  .tmenu-cancel { margin-top: 8px; height: 46px; line-height: 46px; text-align: center; font-size: 14px; color: #5A5D70; background: #F5F6FA; border-radius: 8px; }

  /* 顶部导航示意 */
  .hero {
    background: linear-gradient(160deg, #EFEEFE 0%, #F7F5FF 60%, #F4F5F9 100%);
    padding: 56px 16px 18px;
  }
  .nav { display: flex; align-items: center; justify-content: space-between; height: 22px; margin-bottom: 18px; }
  .nav-title { font-size: 16px; font-weight: 700; color: #1B1D2A; }
  .nav-actions { display: flex; align-items: center; }
  .nav-acc { display: flex; align-items: center; height: 29px; padding: 0 9px; margin-right: 7px; border-radius: 999px; background: rgba(255,255,255,.8); box-shadow: 0 1px 6px rgba(80,70,160,.12); }
  .nav-acc-ico { font-size: 12px; color: #5B5BD6; margin-right: 3px; }
  .nav-acc-txt { font-size: 11px; color: #5B5BD6; font-weight: 500; }
  .sync-btn { width: 32px; height: 32px; border-radius: 50%; background: rgba(255,255,255,.75); display: flex; align-items: center; justify-content: center; box-shadow: 0 1px 6px rgba(80,70,160,.12); }
  .sync-ico { font-size: 17px; color: #5B5BD6; }

  .note { max-width: 300px; font-size: 12.5px; color: #6C7186; line-height: 1.75; }
  .note b { color: #2B2E40; }
  .note code { background: #E4E7EF; border-radius: 3px; padding: 1px 4px; font-size: 11.5px; }
  .note h3 { font-size: 14px; color: #1B1D2A; margin: 16px 0 6px; }
  .note h3:first-child { margin-top: 0; }
</style>
</head>
<body>

  <div class="wrap">
    <div class="phone-label">课表 · 第 ${g.weekNo} 周</div>
    <div class="phone">
      <div class="page">
        <div class="head">
          <div class="head-left">
            <span class="head-title">课表</span>
            <span class="head-sub">9/7 开学</span>
          </div>
          <span class="head-set">设置</span>
        </div>

        <div class="weekbar">
          <div class="wk-btn">‹</div>
          <div class="wk-mid">
            <span class="wk-no">第 ${g.weekNo} 周</span>
            <span class="wk-date">${S.fmtMD(monday)} - ${S.fmtMD(sunday)}</span>
          </div>
          <div class="wk-btn">›</div>
        </div>

        ${gridHtml}

        <div class="tools">
          <div class="tool"><span class="tool-ico">🏫</span><span class="tool-txt">教务导入</span></div>
          <div class="tool"><span class="tool-ico">📋</span><span class="tool-txt">粘贴导入</span></div>
          <div class="tool"><span class="tool-ico">＋</span><span class="tool-txt">手动添加</span></div>
        </div>
        <div class="foot">点课程块看详情，长按可删除 · 共 ${items.length} 节</div>
      </div>
    </div>
  </div>

  <div class="wrap">
    <div class="phone-label">课表 · 教务导入面板</div>
    <div class="phone">
      <div class="page page-dim">
        <div class="head">
          <div class="head-left">
            <span class="head-title">课表</span>
            <span class="head-sub">9/7 开学</span>
          </div>
          <span class="head-set">设置</span>
        </div>
        <div class="weekbar">
          <div class="wk-btn">‹</div>
          <div class="wk-mid">
            <span class="wk-no">第 ${g.weekNo} 周</span>
            <span class="wk-date">${S.fmtMD(monday)} - ${S.fmtMD(sunday)}</span>
          </div>
          <div class="wk-btn">›</div>
        </div>
        ${gridHtml}
      </div>
      <div class="sheet">
        <div class="sheet-bar"></div>
        <div class="sheet-title">从学校系统导入</div>
        <div class="sheet-desc">
          用统一身份认证登录一次，课表自动写进这里 —— 宿舍、家里、手机流量都能用，不挑网络。
          学号密码填在「登录设置 → 课表导入」，填一次就记住。
        </div>
        <div class="jw-step">
          <div class="jw-n">1</div>
          <div class="jw-txt">
            <span class="jw-t">去「登录设置」填学号密码</span>
            <span class="jw-d">首页右上角 ⚙ → 课表导入 → 统一身份认证，填一次就存手机上</span>
          </div>
        </div>
        <div class="jw-step">
          <div class="jw-n">2</div>
          <div class="jw-txt">
            <span class="jw-t">第一次会弹验证码</span>
            <span class="jw-d">照着图填，填完就登录成功；登录态留在电脑代理里，两小时不用再填</span>
          </div>
        </div>
        <div class="jw-step">
          <div class="jw-n">3</div>
          <div class="jw-txt">
            <span class="jw-t">回这里点「拉取课表」</span>
            <span class="jw-d">电脑上开着本地代理、手机电脑同一 WiFi 就行</span>
          </div>
        </div>
        <div class="jw-live">已导入 18 节（2026-2027学年秋季学期），开学日 2026-09-07</div>
        <div class="sheet-btns">
          <div class="sbtn sbtn-ghost">改成手动粘</div>
          <div class="sbtn sbtn-primary">拉取课表</div>
        </div>
        <div class="jw-alt">或者：把代理生成的文本粘进来 →</div>
      </div>
    </div>
  </div>

  <div class="wrap">
    <div class="phone-label">登录设置 · 教务系统卡片</div>
    <div class="phone">
      <div class="page">
        <div class="head">
          <div class="head-left">
            <span class="head-title">登录设置</span>
            <span class="head-sub">学号密码只存本机</span>
          </div>
        </div>

        <div class="acc-card">
          <div class="acc-head">
            <span class="acc-title">课表导入</span>
            <span class="acc-badge">外网可用</span>
          </div>

          <div class="acc-tabs">
            <div class="acc-tab on">统一身份认证</div>
            <div class="acc-tab">教务系统直连</div>
          </div>

          <div class="acc-desc">
            用统一身份认证登录（就是登综合信息门户那套学号密码），门户里已经有教务同步过来的课表，
            从任何网络都能抓。抓到的课表直接写进「课表」页，开学日期和单双周一起校准好。
          </div>

          <div class="acc-field">
            <span class="acc-label">学校</span>
            <div class="acc-input acc-pick">郑州大学<span class="acc-arrow">▾</span></div>
          </div>
          <div class="acc-field">
            <span class="acc-label">学号</span>
            <div class="acc-input">202515020339</div>
          </div>
          <div class="acc-field">
            <span class="acc-label">统一身份认证密码</span>
            <div class="acc-input acc-muted">••••••••</div>
          </div>
          <div class="acc-field">
            <span class="acc-label">验证码</span>
            <div class="acc-cap">
              <div class="acc-capimg">D7f3K</div>
              <div class="acc-input acc-capinput">照图填，点图可换</div>
            </div>
          </div>

          <div class="acc-tip">填好学号 + 统一身份认证密码，点「登录并导入课表」；验证码会当场弹图让你填。</div>
          <div class="acc-btns">
            <div class="acc-btn acc-ghost">仅保存</div>
            <div class="acc-btn acc-primary">登录并导入课表</div>
          </div>
        </div>

        <div class="acc-note">
          <b>为什么这样也能拉课表</b><br>
          教务系统 jw.v.zzu.edu.cn 只对校园网开放，公网 TCP 直接超时 ——
          但统一身份认证 cas.s.zzu.edu.cn 和门户 info.s.zzu.edu.cn 是公网可用的，
          门户的「我的日程」服务端已经把教务课表同步过来了。
          小程序拿不到 Set-Cookie，所以真正登录的动作放在你电脑上的本地代理里，界面上只管填一次。
        </div>
      </div>
    </div>
  </div>

  <div class="wrap">
    <div class="phone-label">首页 · 长按任务</div>
    <div class="phone">
      <div class="menu-demo">
        <div class="hero">
          <div class="nav">
            <span class="nav-title">课业看板</span>
            <div class="nav-actions">
              <div class="nav-acc"><span class="nav-acc-ico">⚙</span><span class="nav-acc-txt">登录设置</span></div>
              <div class="sync-btn"><span class="sync-ico">⟳</span></div>
            </div>
          </div>
        </div>
        <div class="dim"></div>
        <div class="tmenu">
          <div class="tmenu-head">
            <span class="tmenu-name">实验报告3</span>
            <span class="tmenu-sub">学习通 · 汇编语言 · 待完成</span>
          </div>
          <div class="tmenu-item is-primary">
            <span class="tmenu-ico">✓</span><span class="tmenu-txt">标记为已完成</span>
            <span class="tmenu-hint">会移到「已完成」</span>
          </div>
          <div class="tmenu-item">
            <span class="tmenu-ico">›</span><span class="tmenu-txt">查看详情</span>
          </div>
          <div class="tmenu-item">
            <span class="tmenu-ico">⧉</span><span class="tmenu-txt">复制任务链接</span>
          </div>
          <div class="tmenu-cancel">取消</div>
        </div>
      </div>
    </div>
  </div>

  <div class="note">
    <h3>这张图是怎么来的</h3>
    全部数字来自 <code>miniprogram/utils/schedule.js</code> 里的
    <code>gridOf()</code>：示例 16 节课、开学日 9/7、当前第 ${g.weekNo} 周。
    真机上跑的是同一套函数，所以这里的块位置、块高和颜色都对得上。<br><br>
    <b>关于第 ${g.weekNo} 周</b>：${g.weekNo % 2 === 0 ? '双周' : '单周'}——
    「大学英语 1-16周(单)」${g.weekNo % 2 === 0 ? '本周不上，已隐藏' : '本周照常显示'}；
    「军事理论 双周」${g.weekNo % 2 === 0 ? '本周显示' : '本周不上，已隐藏'}。

    <h3>配色</h3>
    按课名做哈希取色，同一门课永远同一个颜色，不需要手动设。

    <h3>说明</h3>
    这是按真实布局算法渲染的示意页，不是小程序截图；真机字体、间距会略有差异。
  </div>

</body>
</html>`

fs.writeFileSync('preview-schedule.html', html)
console.log('已生成 preview-schedule.html  第 ' + g.weekNo + ' 周，' + g.total + ' 节，' + items.length + ' 条记录')
