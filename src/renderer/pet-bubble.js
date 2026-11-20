(() => {
  const bubble = document.getElementById('bubble');
  const text = document.getElementById('text');
  const [label, amount, hint] = text.children;
  const handoff = document.getElementById('handoff-message');
  const root = document.getElementById('root');
  const actions = document.querySelector('.handoff-actions');
  const actionButtons = Array.from(actions.querySelectorAll('button'));
  const progress = document.getElementById('handoff-bar');
  const heading = document.getElementById('handoff-heading');
  const detail = document.getElementById('handoff-detail');
  const target = document.getElementById('handoff-target');
  const puff = document.getElementById('puff-text');
  const normalShape = bubble.querySelector('.bshape');
  const handoffShape = bubble.querySelector('.handoff-shape');
  const textLines = [amount, label, hint];
  const handoffLines = [detail, heading, target];
  const fontScales = [0.95, 0.89, 0.83, 0.77, 0.71, 0.65, 0.6];

  function fitSingleLine(element, minimumScale) {
    element.style.removeProperty('font-size');
    element.style.removeProperty('white-space');
    const style = getComputedStyle(element);
    if (style.whiteSpace !== 'nowrap') return;

    const available = element.clientWidth;
    const natural = element.scrollWidth;
    if (!available || natural <= available) return;
    const scale = Math.max(minimumScale, (available - 1) / natural);
    element.style.fontSize = parseFloat(style.fontSize) * scale + 'px';
    if (element.scrollWidth > available) element.style.whiteSpace = 'normal';
  }

  function safeHeight(content, shape, unit) {
    const style = getComputedStyle(content);
    const centerX = parseFloat(style.left) / unit;
    const centerY = parseFloat(style.top) / unit;
    const halfWidth = parseFloat(style.width) / unit / 2;
    // Include the stroke and a margin around each corner of the text area.
    const inset = 14;
    const left = centerX - halfWidth - inset;
    const right = centerX + halfWidth + inset;
    let low = 0;
    let high = Math.min(centerY, 700 - centerY);
    for (let i = 0; i < 9; i++) {
      const halfHeight = (low + high) / 2;
      const top = centerY - halfHeight - inset;
      const bottom = centerY + halfHeight + inset;
      const fits = shape.isPointInFill(new DOMPoint(left, top)) &&
        shape.isPointInFill(new DOMPoint(right, top)) &&
        shape.isPointInFill(new DOMPoint(left, bottom)) &&
        shape.isPointInFill(new DOMPoint(right, bottom));
      if (fits) low = halfHeight;
      else high = halfHeight;
    }
    return low * 2 * unit;
  }

  function copyFits(lines, controls, shape) {
    // The SVG element's matrix excludes the cloud path's opening animation.
    const matrix = shape.ownerSVGElement.getScreenCTM().inverse();
    const range = document.createRange();
    const fits = (rect) => {
      if (!rect.width || !rect.height) return true;
      const a = new DOMPoint(rect.left, rect.top).matrixTransform(matrix);
      const b = new DOMPoint(rect.right, rect.bottom).matrixTransform(matrix);
      const inset = 14;
      const left = Math.min(a.x, b.x) - inset;
      const right = Math.max(a.x, b.x) + inset;
      const top = Math.min(a.y, b.y) - inset;
      const bottom = Math.max(a.y, b.y) + inset;
      return shape.isPointInFill(new DOMPoint(left, top)) &&
        shape.isPointInFill(new DOMPoint(right, top)) &&
        shape.isPointInFill(new DOMPoint(left, bottom)) &&
        shape.isPointInFill(new DOMPoint(right, bottom));
    };
    return controls.every((control) => fits(control.getBoundingClientRect())) &&
      lines.every((line) => {
        range.selectNodeContents(line);
        return Array.from(range.getClientRects()).every(fits);
      });
  }

  function fitCopy(content, lines, shape) {
    const controls = content === handoff ? [progress] : [];
    const fits = () => copyFits(lines, controls, shape);
    if (fits()) return 1;

    content.style.gap = 'calc(var(--u) * 2)';
    if (fits()) return 1;

    const sizes = lines.map((line) => parseFloat(getComputedStyle(line).fontSize));
    const setScale = (scale) => {
      lines.forEach((line, index) => { line.style.fontSize = sizes[index] * scale + 'px'; });
    };
    for (const scale of fontScales) {
      setScale(scale);
      if (fits()) return scale;
    }

    // Long announcements can need a smaller size than the normal tiers.
    let low = 0.05;
    let high = fontScales.at(-1);
    setScale(low);
    if (!fits()) return 0;
    for (let i = 0; i < 7; i++) {
      const scale = (low + high) / 2;
      setScale(scale);
      if (fits()) low = scale;
      else high = scale;
    }
    setScale(low);
    return low;
  }

  function limitExtremeCopy(content, priority, budget) {
    const lines = priority.filter((element) => element.offsetHeight).map((element) => {
      const style = getComputedStyle(element);
      const height = parseFloat(style.lineHeight);
      return { element, height, count: Math.round(parseFloat(style.height) / height) };
    });
    // Keep the title and footer legible before using the remaining room for the body.
    let room = budget - parseFloat(getComputedStyle(content).height);
    for (const { height, count } of lines) room += (count - 1) * height;
    for (const { element, height, count } of lines) {
      const visible = Math.min(count, 1 + Math.max(0, Math.floor(room / height)));
      room -= (visible - 1) * height;
      if (visible < count) element.style.setProperty('--bubble-lines', visible);
    }
  }

  // 样式变体靠 data-label 换短文案、靠 data-count 选弧线；与开关状态无关，随时保持最新
  function markActions() {
    actions.dataset.count = actionButtons.filter((button) => !button.hidden).length;
    for (const button of actionButtons) {
      const label = button.textContent;
      button.setAttribute('aria-label', label);
      button.dataset.label = label === '复制指令' ? '复制' : label === '复制给原 AI' ? '复制给\n原 AI' : label;
    }
  }

  function fitBubble() {
    markActions();
    if (!bubble.classList.contains('open')) return;
    const isHandoff = bubble.classList.contains('handoff');
    const unit = bubble.clientWidth / 1026;
    if (!unit) return;
    const content = isHandoff ? handoff : text;
    const priority = isHandoff ? handoffLines : textLines;
    content.style.removeProperty('gap');
    const numeric = /^[\d.,+\-−¥$€£%eE\s]+$/u.test(amount.textContent);
    for (const element of priority) {
      element.style.removeProperty('--bubble-lines');
      const minimum = element === label || element === hint ? 0.66 : 0.76;
      fitSingleLine(element, element === amount && numeric ? 0 : minimum);
    }
    if (bubble.classList.contains('compact')) fitSingleLine(puff, 0);
    const shape = isHandoff ? handoffShape : normalShape;
    const scale = fitCopy(content, priority, shape);
    if (!scale) limitExtremeCopy(content, priority, safeHeight(content, shape, unit));
    if (!isHandoff) {
      text.title = scale < fontScales.at(-1)
        ? Array.from(text.children, (line) => line.textContent).filter(Boolean).join('\n') : '';
    }
  }

  let frame = 0;
  function scheduleFit() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      fitBubble();
    });
  }

  new MutationObserver(scheduleFit).observe(bubble, {
    attributes: true, attributeFilter: ['class', 'hidden', 'src'],
    childList: true, characterData: true, subtree: true
  });
  new ResizeObserver(scheduleFit).observe(bubble);
  document.fonts.ready.then(scheduleFit);
  window.pet.on('data', (data) => {
    const style = data.config?.appearance?.handoffActionStyle;
    root.dataset.handoffStyle = ['classic', 'orbit', 'edge'].includes(style) ? style : 'classic';
    scheduleFit();
  });
})();
