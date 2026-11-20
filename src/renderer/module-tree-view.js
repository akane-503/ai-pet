'use strict';
(function (root) {
  const TONES = { pending: 'pending', doing: 'doing', review: 'review', gap: 'gap', done: 'done' };

  function el(document, tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function moduleRow(document, mod) {
    const item = el(document, 'li', 'mod-item st-' + (TONES[mod.status] || 'pending'));
    const detail = el(document, 'details', 'mod-card');
    const summary = el(document, 'summary', 'mod-summary');
    summary.append(el(document, 'i', 'mod-dot'));
    const name = el(document, 'b', 'mod-name', mod.title || mod.id || '模块');
    summary.append(name);
    summary.append(el(document, 'span', 'mod-label', mod.label || mod.status || '未开始'));
    detail.append(summary);
    const body = el(document, 'div', 'mod-body');
    body.append(el(document, 'p', '', mod.deliverable ? '交付物 · ' + mod.deliverable : '交付物 · 还没写路径'));
    body.append(el(document, 'p', '', mod.gap ? '缺口 · ' + mod.gap : '缺口 · 没有'));
    detail.append(body);
    item.append(detail);
    return item;
  }

  function listModules(document, modules) {
    const list = el(document, 'ul', 'mod-list');
    for (const mod of modules) list.append(moduleRow(document, mod));
    return list;
  }

  function renderModuleTree(project, document) {
    const doc = document || root.document;
    const tree = project && project.moduleTree;
    const wrap = el(doc, 'div', 'mod-tree');
    const rootCard = el(doc, 'div', 'mod-root');
    rootCard.append(el(doc, 'span', 'mod-label', '项目目标'));
    rootCard.append(el(doc, 'b', 'mod-goal', (tree && tree.title) || (project && (project.goal || project.name)) || '项目目标'));
    wrap.append(rootCard);
    const children = tree && Array.isArray(tree.children) ? tree.children : [];
    if (!children.length) {
      wrap.append(el(doc, 'p', 'mod-empty', '控制面还没有模块进度。'));
      return wrap;
    }
    const list = el(doc, 'ul', 'mod-list');
    for (const child of children) {
      if (child.kind === 'goal' && Array.isArray(child.children)) {
        const group = el(doc, 'li', 'mod-parent');
        group.append(el(doc, 'b', 'mod-parent-name', child.title));
        group.append(listModules(doc, child.children));
        list.append(group);
      } else {
        list.append(moduleRow(doc, child));
      }
    }
    wrap.append(list);
    return wrap;
  }

  root.renderModuleTree = renderModuleTree;
})(typeof window !== 'undefined' ? window : globalThis);
