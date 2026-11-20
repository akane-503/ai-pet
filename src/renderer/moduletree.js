'use strict';
(function () {
  const $ = (selector) => document.querySelector(selector);
  const key = 'aipet.moduleRoot';

  async function read() {
    const root = $('#root').value.trim();
    const host = $('#view');
    if (!root) {
      host.replaceChildren();
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = '填项目目录后读取。';
      host.append(hint);
      return;
    }
    host.textContent = '正在读取控制面…';
    try {
      const view = await window.pet.invoke('module-tree:read', root);
      try { localStorage.setItem(key, root); } catch { /* the tree still renders */ }
      host.replaceChildren(window.renderModuleTree(view, document));
    } catch (error) {
      host.textContent = '读取失败：' + error.message;
    }
  }

  $('#read').addEventListener('click', read);
  $('#root').addEventListener('keydown', (event) => { if (event.key === 'Enter') read(); });
  $('#pick').addEventListener('click', async () => {
    const dir = await window.pet.invoke('pick-directory');
    if (!dir) return;
    $('#root').value = dir;
    read();
  });
  try { $('#root').value = localStorage.getItem(key) || ''; } catch { /* empty field is fine */ }
})();
