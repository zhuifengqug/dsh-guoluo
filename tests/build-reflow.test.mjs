import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reflowHtml, stylesheetLink } from '../lib/build/reflow.mjs';

const page = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <title>示例</title>
    <script src="app.js"></script>
  </head>
  <body class="page">
    <h1 id="hero" class="title big" onclick="alert(1)" data-track="x">标题</h1>
    <a href="/pricing" class="cta" target="_self">价格</a>
    <img src="hero.png" srcset="hero@2x.png 2x" alt="主图">
    <style>.a { color: red }</style>
    <section><div><span>深一层</span></div></section>
  </body>
</html>`;

test('重排保住结构事实，丢掉执行事实', () => {
  const { html, dropped, emptyScripts, emptyStyles } = reflowHtml({ text: page, stylesheet: './styles/project.css' });
  // 结构：标签、id/class、链接目标、嵌套层级
  assert.match(html, /<h1 id="hero" class="title big">/u);
  assert.match(html, /<a href="\/pricing" class="cta"/u);
  assert.match(html, /<section><div><span>深一层<\/span><\/div><\/section>/u);
  assert.match(html, /<img src="hero\.png" alt="主图">/u);
  // 结构之外的东西不留
  assert.ok(!html.includes('alert(1)'), '事件属性必须丢掉');
  assert.ok(!html.includes('app.js'), '脚本内容必须丢掉');
  assert.ok(!html.includes('color: red'), '样式内容必须丢掉');
  assert.ok(!html.includes('hero@2x.png'), 'srcset 必须丢掉');
  assert.ok(!html.includes('data-track'), '白名单外的属性必须丢掉');
  assert.equal(emptyScripts, 1);
  assert.equal(emptyStyles, 1);
  assert.equal(dropped.handlers, 1);
  assert.equal(dropped.inlineStyle, 0);
  assert.equal(dropped.srcset, 1);
  assert.ok(dropped.attrs >= 1);
  // 生成的样式表要在 head 里，且保留原有 head 内容
  assert.match(html, /<link rel="stylesheet" href="\.\/styles\/project\.css">/u);
  assert.match(html, /<title>示例<\/title>/u);
  // 空标签占位仍在，结构对得上
  assert.match(html, /<script><\/script>/u);
  assert.match(html, /<style><\/style>/u);
});

test('没有 head 的片段也能补上 doctype 与样式表', () => {
  const { html } = reflowHtml({ text: '<div id="a"><p>文字</p></div>', stylesheet: 'x.css', lang: 'zh-CN' });
  assert.match(html, /^<!doctype html>/u);
  assert.match(html, /<link rel="stylesheet" href="x\.css">/u);
  assert.match(html, /<div id="a"><p>文字<\/p><\/div>/u);
});

test('页面到样式表的相对链接按目录层级算', () => {
  assert.equal(stylesheetLink('index.html'), './styles/project.css');
  assert.equal(stylesheetLink('docs/index.html'), '../styles/project.css');
  assert.equal(stylesheetLink('a/b/c.html'), '../../styles/project.css');
});