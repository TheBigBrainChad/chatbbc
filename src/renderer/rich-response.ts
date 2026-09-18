import { parseRichResponse, type RichNode, type RichResponse } from '../shared/rich-response.js';

/** Canonical source is retained, but component syntax is never executed to recreate a UI. */
function renderUnavailableRichResponse(source: string, accessibleText = ''): HTMLElement {
  const box = document.createElement('div');
  box.className = 'msg rich-response rich-unavailable';
  box.setAttribute('dir', 'auto');
  const explanation = document.createElement('p');
  explanation.className = 'rich-unavailable-label';
  explanation.textContent = 'Rich content unavailable — open original in ChatGPT';
  const disclosure = document.createElement('details');
  disclosure.className = 'rich-source';
  disclosure.dataset.richNodeId = 'unavailable-source';
  const summary = document.createElement('summary');
  summary.textContent = 'Show original response source';
  const raw = document.createElement('pre');
  raw.setAttribute('dir', 'auto');
  raw.textContent = source;
  disclosure.append(summary, raw);
  box.append(explanation);
  if (accessibleText.trim()) {
    const visible = document.createElement('p');
    visible.className = 'rich-accessible-summary';
    visible.setAttribute('dir', 'auto');
    visible.textContent = accessibleText;
    box.append(visible);
  }
  box.append(disclosure);
  return box;
}

/** Presentation only: a visually recognizable control is NOT native-action authority. */
function renderControl(node: Extract<RichNode, { kind: 'control' }>): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'rich-control';
  wrapper.dataset.richNodeId = node.id;
  wrapper.tabIndex = 0;
  wrapper.setAttribute('aria-disabled', 'true');

  if (node.control === 'choice' || node.control === 'radio' || node.control === 'checkbox') {
    wrapper.classList.add('rich-selectable');
    wrapper.setAttribute('role', node.control === 'checkbox' ? 'checkbox' : 'radio');
    wrapper.setAttribute('aria-checked', String(node.selected));
    if (node.selected) wrapper.classList.add('is-selected');
    wrapper.dataset.richControl = node.id;
    const label = document.createElement('span');
    label.textContent = node.label;
    wrapper.append(label);
    if (node.selected) {
      const state = document.createElement('small');
      state.className = 'rich-control-state';
      state.textContent = 'Selected when recorded';
      wrapper.append(state);
    }
  } else {
    wrapper.setAttribute('role', 'group');
    wrapper.setAttribute('aria-label', `${node.label} — unavailable in this recording`);
    if (node.control === 'continue' || node.control === 'button') {
      const button = document.createElement('button');
      button.type = 'button';
      button.disabled = true;
      button.tabIndex = -1;
      button.setAttribute('aria-disabled', 'true');
      button.dataset.richControl = node.id;
      button.textContent = node.label;
      wrapper.append(button);
    } else if (node.control === 'input') {
      const label = document.createElement('label');
      label.textContent = node.label;
      const input = document.createElement('input');
      input.disabled = true;
      input.tabIndex = -1;
      input.setAttribute('aria-disabled', 'true');
      input.dataset.richControl = node.id;
      input.value = node.value ?? '';
      label.append(input);
      wrapper.append(label);
    } else if (node.control === 'select') {
      const label = document.createElement('label');
      label.textContent = node.label;
      const select = document.createElement('select');
      select.disabled = true;
      select.tabIndex = -1;
      select.setAttribute('aria-disabled', 'true');
      select.dataset.richControl = node.id;
      // No options are invented: this schema describes the selected value, not the option list.
      const value = document.createElement('option');
      value.textContent = node.value ?? 'Unavailable';
      select.append(value);
      label.append(select);
      wrapper.append(label);
    } else {
      // A recorded link has no verified destination. Never create an <a> or href.
      const label = document.createElement('span');
      label.dataset.richControl = node.id;
      label.textContent = node.label;
      wrapper.append(label);
    }
  }
  for (const child of node.children) wrapper.append(renderNode(child));
  return wrapper;
}

/** The schema carries row groups, not arbitrary HTML tables or unverified heading cells. */
function renderTableRow(node: RichNode): HTMLElement {
  const row = document.createElement('div');
  row.className = 'rich-table-row';
  row.setAttribute('role', 'row');
  if (node.kind === 'group' && node.layout === 'row') row.dataset.richNodeId = node.id;
  const cells = node.kind === 'group' && node.layout === 'row' ? node.children : [node];
  for (const entry of cells) {
    const cell = document.createElement('div');
    cell.className = 'rich-table-cell';
    cell.setAttribute('role', 'cell');
    cell.append(renderNode(entry));
    row.append(cell);
  }
  return row;
}

function renderNode(node: RichNode): HTMLElement {
  if (node.kind === 'text') {
    const tag = node.style === 'heading' ? 'h3' : node.style === 'code' ? 'pre' : 'p';
    const element = document.createElement(tag);
    element.className = `rich-${node.style}`;
    element.dataset.richNodeId = node.id;
    if (node.style === 'code') {
      element.setAttribute('dir', 'ltr');
      const code = document.createElement('code');
      code.textContent = node.text;
      element.append(code);
    } else {
      element.setAttribute('dir', 'auto');
      element.textContent = node.text;
    }
    return element;
  }
  if (node.kind === 'image') {
    const slot = document.createElement('div');
    slot.className = 'rich-image-slot';
    slot.dataset.richNodeId = node.id;
    slot.setAttribute('role', 'img');
    slot.setAttribute('aria-label', node.alt ? `${node.alt} — Image preview unavailable` : 'Image preview unavailable');
    if (node.width !== null && node.height !== null) slot.style.aspectRatio = `${node.width} / ${node.height}`;
    const label = document.createElement('span');
    label.textContent = node.alt ? `${node.alt} — Image preview unavailable` : 'Image preview unavailable';
    slot.append(label);
    // Task 9 alone may attach verified local bytes. Source URLs and invented pixels are forbidden.
    return slot;
  }
  if (node.kind === 'control') return renderControl(node);

  const tag = node.layout === 'card' ? 'article' : node.layout === 'list' ? 'ul' : 'div';
  const group = document.createElement(tag);
  group.className = `rich-layout rich-${node.layout}`;
  group.dataset.richNodeId = node.id;
  if (node.layout === 'table' || node.layout === 'diagram') {
    group.tabIndex = 0;
    group.setAttribute('role', 'region');
    group.setAttribute('aria-label', node.layout === 'table' ? 'Rich table, scroll horizontally for more' : 'Rich diagram, scroll horizontally for more');
  }
  if (node.layout === 'table') {
    const table = document.createElement('div');
    table.className = 'rich-table-content';
    table.setAttribute('role', 'table');
    for (const child of node.children) table.append(renderTableRow(child));
    group.append(table);
    return group;
  }
  for (const child of node.children) {
    if (node.layout === 'list') {
      const item = document.createElement('li');
      item.append(renderNode(child));
      group.append(item);
    } else group.append(renderNode(child));
  }
  return group;
}

/** Strictly reparse the entire stored tree; malformed/partial data gets only source fallback. */
export function renderRichResponse(rich: RichResponse, fallback: string): HTMLElement {
  const clean = parseRichResponse(rich);
  if (!clean || clean.status !== 'available' || clean.nodes.length === 0)
    return renderUnavailableRichResponse(fallback, clean?.status === 'unavailable' ? clean.accessibleText : '');
  const box = document.createElement('div');
  box.className = 'msg rich-response';
  box.setAttribute('dir', 'auto');
  for (const node of clean.nodes) box.append(renderNode(node));
  return box;
}
