// 重排（reflow）：把证据页的静态结构重建成我自己的页面。
//
// 保留的是「结构事实」：标签、id/class、a[href]、src、文档顺序与嵌套层级——
// 也就是 guoluo_check 结构维度真正比对的那几样。丢掉的是「执行事实」：脚本、
// 内联样式、事件处理属性、srcset。正文文本保留（那是内容，不是代码）。
//
// 这不是在复刻行为：脚本一进来就等于把证据的代码搬进新工程，报告里要照实记。

import { parse } from 'parse5';

const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const keepAttrs = new Set([
  'id', 'class', 'href', 'src', 'alt', 'title', 'lang', 'dir', 'type', 'name', 'value', 'placeholder',
  'role', 'aria-label', 'colspan', 'rowspan', 'rel', 'target', 'width', 'height', 'action', 'method',
  'for', 'checked', 'selected', 'disabled', 'tabindex', 'scope',
]);
// 这些标签的文本是代码或样式，不搬；标签本身留着，结构才算对得上。
const emptyTextTags = new Set(['script', 'style']);

const escapeText = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const escapeAttr = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

function emitAttributes(node, dropped) {
  const out = [];
  for (const attr of node.attrs ?? []) {
    const name = String(attr.name).toLowerCase();
    if (name.startsWith('on')) { dropped.handlers += 1; continue; }
    if (name === 'srcset') { dropped.srcset += 1; continue; }
    if (name === 'style') { dropped.inlineStyle += 1; continue; }
    if (!keepAttrs.has(name)) { dropped.attrs += 1; continue; }
    out.push(` ${name}="${escapeAttr(attr.value ?? '')}"`);
  }
  return out.join('');
}

/**
 * 把一份 HTML 文本重排成同结构的新页面。
 * @param {{text: string, stylesheet?: string|null, lang?: string|null}} input
 * @returns {{html: string, dropped: object, emptyScripts: number, emptyStyles: number}}
 */
export function reflowHtml({ text, stylesheet = null, lang = null }) {
  const dropped = { attrs: 0, handlers: 0, inlineStyle: 0, srcset: 0 };
  let emptyScripts = 0;
  let emptyStyles = 0;
  const document = parse(String(text ?? ''));
  const parts = [];
  // 用「关闭标记」回填顺序：先吐开标签，再压一个关闭帧，再压子节点——
  // 这样输出天然嵌套，不需要靠递归，也不会把 </tag> 提前吐出来。
  const frames = [{ node: document }];
  while (frames.length) {
    const frame = frames.pop();
    if (frame.close) { parts.push(frame.close); continue; }
    const node = frame.node;
    if (node.nodeName === '#text') {
      const value = String(node.value ?? '').replace(/\s+/gu, ' ');
      if (value.trim() !== '') parts.push(escapeText(value));
      continue;
    }
    if (node.nodeName === '#comment') continue;
    const tag = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : null;
    const children = node.childNodes ?? [];
    if (tag === null) {
      for (let index = children.length - 1; index >= 0; index -= 1) frames.push({ node: children[index] });
      continue;
    }
    if (tag === 'script' || tag === 'style') {
      // src/href 尤其要丢：留着它们等于让新页面把原来的代码再加载一遍。
      const own = (node.attrs ?? [])
        .filter(attr => ['id', 'class'].includes(String(attr.name).toLowerCase()))
        .map(attr => ` ${String(attr.name).toLowerCase()}="${escapeAttr(attr.value ?? '')}"`)
        .join('');
      if (tag === 'script') emptyScripts += 1;
      else emptyStyles += 1;
      parts.push(`<${tag}${own}></${tag}>`);
      continue;
    }
    parts.push(`<${tag}${emitAttributes(node, dropped)}>`);
    if (!voidTags.has(tag)) frames.push({ close: `</${tag}>` });
    for (let index = children.length - 1; index >= 0; index -= 1) frames.push({ node: children[index] });
  }
  let html = parts.join('');
  if (stylesheet) {
    const link = `<link rel="stylesheet" href="${escapeAttr(stylesheet)}">`;
    html = /<head[^>]*>/iu.test(html) ? html.replace(/<head[^>]*>/iu, match => `${match}${link}`) : `${link}${html}`;
  }
  if (!/^<!doctype/iu.test(html)) html = `<!doctype html>${html}`;
  if (lang && !/<html[^>]*\slang=/iu.test(html)) html = html.replace(/<html([^>]*)>/iu, `<html$1 lang="${escapeAttr(lang)}">`);
  return { html: `${html}\n`, dropped, emptyScripts, emptyStyles };
}

/** 生成的样式表要落到与页面同一份工程里，所以链接用相对路径。 */
export function stylesheetLink(pagePath, stylesheetPath = 'styles/project.css') {
  const from = String(pagePath).replaceAll('\\', '/').split('/').slice(0, -1);
  const to = String(stylesheetPath).replaceAll('\\', '/').split('/');
  const up = [];
  for (let index = 0; index < from.length; index += 1) up.push('..');
  // 同层目录时也要带 ./，否则浏览器把首段当成文件名的一部分。
  const joined = [...up, ...to].join('/');
  return joined.startsWith('.') ? joined : `./${joined}`;
}