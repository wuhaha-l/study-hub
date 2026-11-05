#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 index.wxss 里的 rpx 折算成 px（750rpx = 375px → 除以 2），
生成一份纯 CSS，供 preview-index-magnet.html 使用。
这样预览用的就是真实样式，不再手抄一份，避免预览和真机不一致。
"""
import io
import re
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'miniprogram', 'pages', 'index', 'index.wxss')
OUT = os.path.join(HERE, 'preview-index-magnet.css')

css = io.open(SRC, encoding='utf-8').read()


def rpx2px(m):
    v = float(m.group(1)) / 2
    return ('%g' % v) + 'px'


css = re.sub(r'(-?\d+(?:\.\d+)?)rpx', rpx2px, css)
# 小程序里 page 选择器即根节点，预览里挂到 .phone 上
css = css.replace('\n.page {', '\n.phone {')
# .page.theme-dark 是两类的组合选择器，不能只换开头那处
css = css.replace('.page.theme-dark', '.phone.theme-dark')
css += """
/* ===== 预览专用 =====
   1. app.wxss 里有 view/text/... { box-sizing: border-box }，预览没引入它，
      少这条会让带 padding 的磁贴宽度算成 50%+padding → 撑成一列
   2. 根节点默认字色/字体
*/
* { box-sizing: border-box; }

.phone {
  --bg: #F4F5F9;
  --card: #FFFFFF;
  --card-2: #F6F7FA;
  --text: #16161D;
  --text-2: #6E7180;
  --text-3: #A0A3B1;
  --line: #EEF0F4;
  --danger: #D6453B;
  --mask: rgba(15, 17, 26, 0.45);
  /* 只用 background-color 兜底：用 background 简写会把 .page 上的渐变一并重置，
     预览就变成纯色，和真机对不上 */
  background-color: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'PingFang SC', sans-serif;
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.phone.theme-dark {
  --bg: #101116;
  --card: #1C1E28;
  --card-2: #262938;
  --text: #EDEFF7;
  --text-2: #9CA1B5;
  --text-3: #6A6F85;
  --line: #2B2E3E;
  --danger: #E5695F;
  --mask: rgba(0, 0, 0, 0.62);
}
"""

io.open(OUT, 'w', encoding='utf-8').write(css)
print('wrote', OUT, len(css), 'bytes; remaining rpx:', css.count('rpx'))
