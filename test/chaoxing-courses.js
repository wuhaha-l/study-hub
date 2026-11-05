/**
 * 学习通课程列表解析测试（纯本地，不发网络请求）
 *   node test/chaoxing-courses.js
 */
const path = require('path')
const chaoxing = require(path.join(__dirname, '../cloudfunctions/studyHub/adapters/chaoxing'))
const I = chaoxing._internal

let pass = 0
let fail = 0
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + '\n      期望：' + JSON.stringify(want) + '\n      实际：' + JSON.stringify(got))
  }
}
function truthy(name, v) {
  eq(name, !!v, true)
}

/* ---------- 1. HTML 课程页解析 ---------- */
console.log('\n[parseCourseListHtml]')
const html = `
<div class="course-info">
  <div class="courseName"><a href="/visit/stucoursemiddle?courseid=241234567&clazzid=98765432&vc=1&cpi=1234567&enc=8f2a" title="软件工程">软件工程</a></div>
</div>
<div class="course-info">
  <div class="courseName"><a href="/visit/stucoursemiddle?courseid=241234999&amp;clazzid=98765000&amp;vc=1&amp;cpi=7654321">高等数学（上）</a></div>
</div>
<div class="other"><a href="/visit/stucoursemiddle?courseid=241234567&clazzid=98765432&vc=1">重复项</a></div>
<div class="nothing"><a href="/notice/list">通知</a></div>`

const list = I.parseCourseListHtml(html)
eq('课程数（去重后）', list.length, 2)
eq('第一门 id', list[0] && list[0].courseId, '241234567')
eq('第一门班级', list[0] && list[0].clazzId, '98765432')
eq('第一门 cpi', list[0] && list[0].cpi, '1234567')
eq('第一门名称（title 属性）', list[0] && list[0].name, '软件工程')
eq('第二门 name（链接文字，含 &amp; 实体）', list[1] && list[1].name, '高等数学（上）')
eq('第二门 cpi', list[1] && list[1].cpi, '7654321')
eq('空输入不报错', I.parseCourseListHtml('').length, 0)
eq('null 输入不报错', I.parseCourseListHtml(null).length, 0)

/* ---------- 2. backclazzdata 结构解析 ---------- */
console.log('\n[pickFromApiData]')
const apiData = {
  result: 1,
  msg: '获取成功',
  channelList: [
    {
      cpi: 888888,
      content: {
        course: {
          data: [
            { courseid: 241234567, clazzid: 98765432, name: '软件工程', teacherfactor: '穆玲玲' },
            { courseid: 241234568, clazzid: 98765433, name: '汇编语言', cpi: 111222 }
          ]
        }
      }
    },
    { content: null }
  ]
}
const apiList = I.pickFromApiData(apiData)
eq('接口课程数', apiList.length, 2)
eq('cpi 取自 course.data', apiList[1].cpi, '111222')
eq('cpi 回退到 channel 层', apiList[0].cpi, '888888')
eq('课程名', apiList[0].name, '软件工程')
eq('空数据返回空数组', I.pickFromApiData({}).length, 0)

/* ---------- 3. 精简 Cookie ---------- */
console.log('\n[slimCookie]')
const full = 'JSESSIONID=AAA; route=bbb; _uid=12345; _d=xyz789; uf=abc; fid=8888'
const slim = I.slimCookie(full)
truthy('去掉 JSESSIONID', slim.indexOf('JSESSIONID') === -1)
truthy('去掉 route', slim.indexOf('route') === -1)
truthy('保留 _uid', slim.indexOf('_uid=12345') > -1)
truthy('保留 _d', slim.indexOf('_d=xyz789') > -1)
truthy('保留 uf', slim.indexOf('uf=abc') > -1)
eq('精简后仍是合法 cookie 串', slim, '_uid=12345; _d=xyz789; uf=abc; fid=8888')

/* ---------- 4. 失败路径不抛异常的约定 ---------- */
console.log('\n[fetchCourses 契约]')
truthy('fetchCourses 是 async 函数', I.fetchCourses && I.fetchCourses.constructor.name === 'AsyncFunction')

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail ? 1 : 0)
