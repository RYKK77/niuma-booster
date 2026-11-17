'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { requireRepoPaths } = require('./coreCompat');

const origSetImmediate = globalThis.setImmediate;

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const RAW_TEXT_TAGS = new Set(['script', 'style']);

function decodeHtmlEntities(str) {
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function camelToKebab(str) {
  return str.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function kebabToCamel(str) {
  return str.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

class MockEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles !== undefined ? Boolean(init.bubbles) : true;
    this.cancelable = init.cancelable !== undefined ? Boolean(init.cancelable) : true;
    this.defaultPrevented = false;
    this.cancelBubble = false;
    this.target = null;
    this.currentTarget = null;
    for (const [k, v] of Object.entries(init)) {
      if (!(k in this)) this[k] = v;
    }
  }
  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
  stopPropagation() {
    this.cancelBubble = true;
  }
  stopImmediatePropagation() {
    this.cancelBubble = true;
    this._stopImmediate = true;
  }
}

class MockNode {
  constructor(nodeType, ownerDocument) {
    this.nodeType = nodeType;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
}

class MockTextNode extends MockNode {
  constructor(data, ownerDocument) {
    super(3, ownerDocument);
    this.data = String(data);
  }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
  cloneNode() { return new MockTextNode(this.data, this.ownerDocument); }
}

class MockCommentNode extends MockNode {
  constructor(data, ownerDocument) {
    super(8, ownerDocument);
    this.data = String(data);
  }
  get textContent() { return ''; }
  cloneNode() { return new MockCommentNode(this.data, this.ownerDocument); }
}

class MockDocumentFragment extends MockNode {
  constructor(ownerDocument) {
    super(11, ownerDocument);
  }
  get children() {
    return this.childNodes.filter((c) => c.nodeType === 1);
  }
  appendChild(node) {
    return appendChildImpl(this, node);
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
}

function appendChildImpl(parent, node) {
  if (!node) return node;
  if (node.nodeType === 11) {
    const items = node.childNodes.slice();
    for (const child of items) {
      appendChildImpl(parent, child);
    }
    return node;
  }
  if (node.parentNode) {
    const idx = node.parentNode.childNodes.indexOf(node);
    if (idx !== -1) node.parentNode.childNodes.splice(idx, 1);
  }
  node.parentNode = parent;
  parent.childNodes.push(node);
  return node;
}

function createStyleProxy(el) {
  const map = new Map();
  const target = {
    setProperty(k, v) {
      const prop = camelToKebab(String(k));
      if (v === '' || v === null || v === undefined) map.delete(prop);
      else map.set(prop, String(v));
    },
    getPropertyValue(k) {
      return map.get(camelToKebab(String(k))) || '';
    },
    removeProperty(k) {
      const prop = camelToKebab(String(k));
      const old = map.get(prop) || '';
      map.delete(prop);
      return old;
    },
    get cssText() {
      return Array.from(map.entries()).map(([k, v]) => `${k}: ${v}`).join('; ');
    },
    set cssText(val) {
      map.clear();
      for (const decl of String(val || '').split(';')) {
        const colon = decl.indexOf(':');
        if (colon === -1) continue;
        const k = decl.slice(0, colon).trim().toLowerCase();
        const v = decl.slice(colon + 1).trim();
        if (k && v) map.set(k, v);
      }
    },
  };
  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      if (typeof prop === 'string') return map.get(camelToKebab(prop)) || '';
      return undefined;
    },
    set(obj, prop, value) {
      if (prop === 'cssText') {
        obj.cssText = value;
        return true;
      }
      if (typeof prop === 'string') {
        obj.setProperty(prop, value);
        return true;
      }
      return false;
    },
  });
}

class MockElement extends MockNode {
  constructor(tagName, ownerDocument) {
    super(1, ownerDocument);
    this.tagName = String(tagName).toUpperCase();
    this.localName = String(tagName).toLowerCase();
    this.nodeName = this.tagName;
    this._attrs = new Map();
    this._listeners = new Map();
    this._valueState = undefined;
    this._checkedState = undefined;
    this._selectedState = undefined;
    this.style = createStyleProxy(this);

    const self = this;
    this.classList = {
      _tokens() {
        const raw = self._attrs.get('class') || '';
        return raw.trim() ? raw.trim().split(/\s+/) : [];
      },
      _save(tokens) {
        if (tokens.length === 0) self._attrs.delete('class');
        else self._attrs.set('class', tokens.join(' '));
      },
      add(...names) {
        const tokens = this._tokens();
        for (const n of names) {
          if (n && !tokens.includes(n)) tokens.push(n);
        }
        this._save(tokens);
      },
      remove(...names) {
        const set = new Set(names);
        this._save(this._tokens().filter((t) => !set.has(t)));
      },
      toggle(name, force) {
        const has = this.contains(name);
        const shouldAdd = force !== undefined ? Boolean(force) : !has;
        if (shouldAdd) this.add(name);
        else this.remove(name);
        return shouldAdd;
      },
      contains(name) {
        return this._tokens().includes(name);
      },
      item(i) {
        return this._tokens()[i] || null;
      },
      get length() {
        return this._tokens().length;
      },
    };

    this.dataset = new Proxy({}, {
      get(_, prop) {
        if (typeof prop !== 'string') return undefined;
        return self._attrs.get(`data-${camelToKebab(prop)}`);
      },
      set(_, prop, val) {
        if (typeof prop !== 'string') return false;
        self._attrs.set(`data-${camelToKebab(prop)}`, String(val));
        return true;
      },
      deleteProperty(_, prop) {
        if (typeof prop !== 'string') return false;
        self._attrs.delete(`data-${camelToKebab(prop)}`);
        return true;
      },
      ownKeys() {
        const keys = [];
        for (const k of self._attrs.keys()) {
          if (k.startsWith('data-')) keys.push(kebabToCamel(k.slice(5)));
        }
        return keys;
      },
      getOwnPropertyDescriptor(_, prop) {
        if (typeof prop === 'string' && self._attrs.has(`data-${camelToKebab(prop)}`)) {
          return { enumerable: true, configurable: true, value: self._attrs.get(`data-${camelToKebab(prop)}`) };
        }
        return undefined;
      },
    });
  }

  get id() { return this._attrs.get('id') || ''; }
  set id(v) { this.setAttribute('id', v); }

  get className() { return this._attrs.get('class') || ''; }
  set className(v) {
    if (v === '' || v == null) this._attrs.delete('class');
    else this._attrs.set('class', String(v));
  }

  get type() { return (this._attrs.get('type') || (this.localName === 'button' ? 'submit' : 'text')).toLowerCase(); }
  set type(v) { this.setAttribute('type', v); }

  get name() { return this._attrs.get('name') || ''; }
  set name(v) { this.setAttribute('name', v); }

  get title() { return this._attrs.get('title') || ''; }
  set title(v) { this.setAttribute('title', v); }

  get placeholder() { return this._attrs.get('placeholder') || ''; }
  set placeholder(v) { this.setAttribute('placeholder', v); }

  get hidden() { return this._attrs.has('hidden'); }
  set hidden(v) {
    if (v) this.setAttribute('hidden', '');
    else this.removeAttribute('hidden');
  }

  get disabled() { return this._attrs.has('disabled'); }
  set disabled(v) {
    if (v) this.setAttribute('disabled', '');
    else this.removeAttribute('disabled');
  }

  get checked() {
    if (this._checkedState !== undefined) return this._checkedState;
    return this._attrs.has('checked');
  }
  set checked(v) {
    this._checkedState = Boolean(v);
  }

  get selected() {
    if (this._selectedState !== undefined) return this._selectedState;
    return this._attrs.has('selected');
  }
  set selected(v) {
    this._selectedState = Boolean(v);
  }

  get options() {
    return this.querySelectorAll('option');
  }

  get selectedIndex() {
    const opts = this.options;
    for (let i = 0; i < opts.length; i++) {
      if (opts[i].selected) return i;
    }
    return opts.length > 0 ? 0 : -1;
  }

  set selectedIndex(idx) {
    const opts = this.options;
    for (let i = 0; i < opts.length; i++) {
      opts[i].selected = i === idx;
    }
  }

  get value() {
    if (this.localName === 'select') {
      const opts = this.options;
      const sel = opts.find((o) => o.selected) || opts[0];
      if (!sel) return this._valueState !== undefined ? this._valueState : '';
      return sel.hasAttribute('value') ? sel.getAttribute('value') : sel.textContent;
    }
    if (this.localName === 'textarea') {
      return this._valueState !== undefined ? this._valueState : this.textContent;
    }
    if (this._valueState !== undefined) return this._valueState;
    return this._attrs.get('value') || '';
  }

  set value(v) {
    const str = v === null || v === undefined ? '' : String(v);
    this._valueState = str;
    if (this.localName === 'select') {
      const opts = this.options;
      for (const o of opts) {
        const ov = o.hasAttribute('value') ? o.getAttribute('value') : o.textContent;
        o.selected = ov === str;
      }
    }
  }

  get children() {
    return this.childNodes.filter((c) => c.nodeType === 1);
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  get lastElementChild() {
    const ch = this.children;
    return ch[ch.length - 1] || null;
  }

  get nextElementSibling() {
    if (!this.parentNode) return null;
    const ch = this.parentNode.childNodes.filter((c) => c.nodeType === 1);
    const idx = ch.indexOf(this);
    return idx >= 0 && idx + 1 < ch.length ? ch[idx + 1] : null;
  }

  get previousElementSibling() {
    if (!this.parentNode) return null;
    const ch = this.parentNode.childNodes.filter((c) => c.nodeType === 1);
    const idx = ch.indexOf(this);
    return idx > 0 ? ch[idx - 1] : null;
  }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    return this._attrs.has(key) ? this._attrs.get(key) : null;
  }

  setAttribute(name, value) {
    const key = String(name).toLowerCase();
    const val = String(value);
    this._attrs.set(key, val);
    if (key === 'style') {
      this.style.cssText = val;
    }
  }

  removeAttribute(name) {
    this._attrs.delete(String(name).toLowerCase());
  }

  hasAttribute(name) {
    return this._attrs.has(String(name).toLowerCase());
  }

  appendChild(node) {
    return appendChildImpl(this, node);
  }

  insertBefore(newNode, refNode) {
    if (!refNode) return this.appendChild(newNode);
    const idx = this.childNodes.indexOf(refNode);
    if (idx === -1) return this.appendChild(newNode);
    if (newNode.parentNode) {
      const oldIdx = newNode.parentNode.childNodes.indexOf(newNode);
      if (oldIdx !== -1) newNode.parentNode.childNodes.splice(oldIdx, 1);
    }
    newNode.parentNode = this;
    this.childNodes.splice(idx, 0, newNode);
    return newNode;
  }

  removeChild(node) {
    const idx = this.childNodes.indexOf(node);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      node.parentNode = null;
    }
    return node;
  }

  replaceChild(newNode, oldNode) {
    const idx = this.childNodes.indexOf(oldNode);
    if (idx === -1) return oldNode;
    if (newNode.parentNode) {
      const oldIdx = newNode.parentNode.childNodes.indexOf(newNode);
      if (oldIdx !== -1) newNode.parentNode.childNodes.splice(oldIdx, 1);
    }
    newNode.parentNode = this;
    oldNode.parentNode = null;
    this.childNodes[idx] = newNode;
    return oldNode;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  append(...nodes) {
    for (const n of nodes) {
      this.appendChild(typeof n === 'string' ? new MockTextNode(n, this.ownerDocument) : n);
    }
  }

  prepend(...nodes) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const node = typeof n === 'string' ? new MockTextNode(n, this.ownerDocument) : n;
      this.insertBefore(node, this.childNodes[0] || null);
    }
  }

  replaceChildren(...nodes) {
    for (const c of this.childNodes.slice()) c.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }

  contains(other) {
    let cur = other;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }

  set textContent(val) {
    for (const c of this.childNodes.slice()) c.parentNode = null;
    this.childNodes = [];
    if (val !== null && val !== undefined && String(val) !== '') {
      this.appendChild(new MockTextNode(String(val), this.ownerDocument));
    }
  }

  get innerText() {
    if (this.hidden || this.style.display === 'none') return '';
    return this.childNodes
      .map((c) => (c.nodeType === 1 ? c.innerText : c.textContent))
      .join('');
  }

  set innerText(val) {
    this.textContent = val;
  }

  get innerHTML() {
    return this.childNodes.map(serializeNode).join('');
  }

  set innerHTML(html) {
    for (const c of this.childNodes.slice()) c.parentNode = null;
    this.childNodes = [];
    const frag = parseHtmlFragment(String(html || ''), this.ownerDocument);
    this.appendChild(frag);
  }

  get outerHTML() {
    return serializeNode(this);
  }

  get offsetWidth() {
    if (this.hidden || this.style.display === 'none') return 0;
    return this.localName === 'body' ? 330 : 300;
  }

  get clientWidth() { return this.offsetWidth; }
  get scrollWidth() { return this.offsetWidth; }

  get offsetHeight() {
    return estimateElementHeight(this);
  }
  get clientHeight() { return this.offsetHeight; }
  get scrollHeight() { return this.offsetHeight; }

  getBoundingClientRect() {
    const w = this.offsetWidth;
    const h = this.offsetHeight;
    return { x: 0, y: 0, left: 0, top: 0, width: w, height: h, right: w, bottom: h };
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  blur() {
    if (this.ownerDocument && this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
  }

  scrollIntoView() {}

  addEventListener(type, fn) {
    if (typeof fn !== 'function') return;
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    const list = this._listeners.get(type);
    if (!list.includes(fn)) list.push(fn);
  }

  removeEventListener(type, fn) {
    const list = this._listeners.get(type);
    if (!list) return;
    const idx = list.indexOf(fn);
    if (idx !== -1) list.splice(idx, 1);
  }

  dispatchEvent(event) {
    if (!event.target) event.target = this;
    const chain = [];
    let cur = this;
    while (cur) {
      chain.push(cur);
      cur = cur.parentNode;
    }
    if (this.ownerDocument) chain.push(this.ownerDocument);

    for (let i = 0; i < chain.length; i++) {
      const node = chain[i];
      if (i > 0 && !event.bubbles) break;
      event.currentTarget = node;
      const inlineProp = node[`on${event.type}`];
      if (typeof inlineProp === 'function') {
        inlineProp.call(node, event);
      }
      const list = node._listeners ? node._listeners.get(event.type) : null;
      if (list) {
        for (const fn of list.slice()) {
          if (event._stopImmediate) break;
          fn.call(node, event);
        }
      }
      if (event.cancelBubble) break;
    }
    return !event.defaultPrevented;
  }

  click() {
    if (this.disabled) return;
    let changed = false;
    if (this.localName === 'input' && this.type === 'checkbox') {
      this.checked = !this.checked;
      changed = true;
    } else if (this.localName === 'input' && this.type === 'radio') {
      const rName = this.name;
      if (rName && this.ownerDocument) {
        for (const r of this.ownerDocument.querySelectorAll(`input[type="radio"]`)) {
          if (r.name === rName) r.checked = false;
        }
      }
      this.checked = true;
      changed = true;
    }
    const ev = new MockEvent('click', { bubbles: true, cancelable: true });
    this.dispatchEvent(ev);
    if (changed) {
      this.dispatchEvent(new MockEvent('change', { bubbles: true }));
    }
  }

  matches(selector) {
    return matchesSelectorList(this, selector);
  }

  closest(selector) {
    let cur = this;
    while (cur && cur.nodeType === 1) {
      if (matchesSelectorList(cur, selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  getElementById(id) {
    return this.querySelector(`#${escapeIdent(id)}`);
  }

  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all[0] || null;
  }

  querySelectorAll(selector) {
    const out = [];
    walkElements(this, (el) => {
      if (el !== this && matchesSelectorList(el, selector)) out.push(el);
    });
    return out;
  }

  getElementsByTagName(tag) {
    const t = String(tag).toUpperCase();
    const out = [];
    walkElements(this, (el) => {
      if (el !== this && (t === '*' || el.tagName === t)) out.push(el);
    });
    return out;
  }

  getElementsByClassName(cls) {
    const out = [];
    walkElements(this, (el) => {
      if (el !== this && el.classList.contains(cls)) out.push(el);
    });
    return out;
  }

  cloneNode(deep = false) {
    const copy = new MockElement(this.localName, this.ownerDocument);
    for (const [k, v] of this._attrs.entries()) copy.setAttribute(k, v);
    if (deep) {
      for (const c of this.childNodes) copy.appendChild(c.cloneNode(true));
    }
    return copy;
  }
}

function estimateElementHeight(el) {
  if (el.hidden || el.style.display === 'none') return 0;
  const kids = el.children;
  if (kids.length === 0) {
    return el.textContent.trim() ? 24 : 16;
  }
  let total = 16;
  for (const ch of kids) {
    total += estimateElementHeight(ch);
  }
  return total;
}

function escapeIdent(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function walkElements(root, fn) {
  for (const child of root.childNodes) {
    if (child.nodeType === 1) {
      fn(child);
      walkElements(child, fn);
    }
  }
}

function serializeNode(node) {
  if (node.nodeType === 3) return node.data;
  if (node.nodeType === 8) return `<!--${node.data}-->`;
  if (node.nodeType !== 1) return '';
  const attrs = Array.from(node._attrs.entries())
    .map(([k, v]) => (v === '' ? k : `${k}="${v.replace(/"/g, '&quot;')}"`))
    .join(' ');
  const open = attrs ? `<${node.localName} ${attrs}>` : `<${node.localName}>`;
  if (VOID_TAGS.has(node.localName)) return open;
  return `${open}${node.childNodes.map(serializeNode).join('')}</${node.localName}>`;
}

// --- 轻量 CSS 选择器匹配 ---

function splitTopLevel(str, sepChar) {
  const parts = [];
  let cur = '';
  let depthParen = 0;
  let depthBracket = 0;
  let quote = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      cur += ch;
      if (ch === quote && str[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(') depthParen++;
    else if (ch === ')') depthParen--;
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket--;
    if (ch === sepChar && depthParen === 0 && depthBracket === 0) {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function tokenizeComplexSelector(sel) {
  const tokens = [];
  let i = 0;
  const s = sel.trim();
  while (i < s.length) {
    if (/\s/.test(s[i])) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (i < s.length && !['>', '+', '~'].includes(s[i]) && tokens.length && typeof tokens[tokens.length - 1] !== 'string') {
        tokens.push(' ');
      }
      continue;
    }
    if (s[i] === '>' || s[i] === '+' || s[i] === '~') {
      if (tokens.length && tokens[tokens.length - 1] === ' ') tokens.pop();
      tokens.push(s[i]);
      i++;
      continue;
    }
    let compound = '';
    let dp = 0, db = 0, q = null;
    while (i < s.length) {
      const ch = s[i];
      if (q) {
        compound += ch;
        if (ch === q && s[i - 1] !== '\\') q = null;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") { q = ch; compound += ch; i++; continue; }
      if (ch === '(') dp++;
      else if (ch === ')') dp--;
      else if (ch === '[') db++;
      else if (ch === ']') db--;
      if (dp === 0 && db === 0 && (/\s/.test(ch) || ch === '>' || ch === '+' || ch === '~')) break;
      compound += ch;
      i++;
    }
    if (compound) tokens.push({ compound });
  }
  return tokens;
}

function matchesCompound(el, compound) {
  if (!el || el.nodeType !== 1) return false;
  let i = 0;
  while (i < compound.length) {
    const ch = compound[i];
    if (ch === '#') {
      i++;
      let name = '';
      while (i < compound.length && !['.', '#', '[', ':'].includes(compound[i])) name += compound[i++];
      if (el.id !== name.replace(/\\/g, '')) return false;
    } else if (ch === '.') {
      i++;
      let cls = '';
      while (i < compound.length && !['.', '#', '[', ':'].includes(compound[i])) cls += compound[i++];
      if (!el.classList.contains(cls)) return false;
    } else if (ch === '[') {
      i++;
      let inner = '';
      let q = null;
      while (i < compound.length && (q || compound[i] !== ']')) {
        if (q) {
          if (compound[i] === q && compound[i - 1] !== '\\') q = null;
        } else if (compound[i] === '"' || compound[i] === "'") {
          q = compound[i];
        }
        inner += compound[i++];
      }
      i++; // skip ']'
      const m = inner.match(/^([^\s=~^$*]+)\s*(?:([*^$~|]?=)\s*(.*))?$/);
      if (!m) return false;
      const attrName = m[1].toLowerCase();
      const op = m[2];
      let expected = m[3] ? m[3].trim() : '';
      if ((expected.startsWith('"') && expected.endsWith('"')) || (expected.startsWith("'") && expected.endsWith("'"))) {
        expected = expected.slice(1, -1);
      }
      if (!op) {
        if (!el.hasAttribute(attrName)) return false;
      } else {
        const actual = el.getAttribute(attrName);
        if (actual === null) return false;
        if (op === '=' && actual !== expected) return false;
        if (op === '*=' && !actual.includes(expected)) return false;
        if (op === '^=' && !actual.startsWith(expected)) return false;
        if (op === '$=' && !actual.endsWith(expected)) return false;
        if (op === '~=' && !actual.split(/\s+/).includes(expected)) return false;
      }
    } else if (ch === ':') {
      i++;
      let pseudo = '';
      while (i < compound.length && !['.', '#', '[', ':', '('].includes(compound[i])) pseudo += compound[i++];
      let arg = '';
      if (compound[i] === '(') {
        i++;
        let dp = 1;
        while (i < compound.length && dp > 0) {
          if (compound[i] === '(') dp++;
          else if (compound[i] === ')') dp--;
          if (dp > 0) arg += compound[i];
          i++;
        }
      }
      if (pseudo === 'checked' && !el.checked) return false;
      if (pseudo === 'disabled' && !el.disabled) return false;
      if (pseudo === 'enabled' && el.disabled) return false;
      if (pseudo === 'first-child' && el.previousElementSibling !== null) return false;
      if (pseudo === 'last-child' && el.nextElementSibling !== null) return false;
      if (pseudo === 'not' && matchesSelectorList(el, arg)) return false;
    } else {
      let tag = '';
      while (i < compound.length && !['.', '#', '[', ':'].includes(compound[i])) tag += compound[i++];
      if (tag !== '*' && el.localName !== tag.toLowerCase()) return false;
    }
  }
  return true;
}

function matchesTokens(el, tokens, idx) {
  if (idx < 0) return true;
  const tok = tokens[idx];
  if (typeof tok === 'string') return false;
  if (!matchesCompound(el, tok.compound)) return false;
  if (idx === 0) return true;

  const comb = tokens[idx - 1];
  if (comb === '>') {
    return el.parentElement ? matchesTokens(el.parentElement, tokens, idx - 2) : false;
  }
  if (comb === '+') {
    return el.previousElementSibling ? matchesTokens(el.previousElementSibling, tokens, idx - 2) : false;
  }
  if (comb === '~') {
    let prev = el.previousElementSibling;
    while (prev) {
      if (matchesTokens(prev, tokens, idx - 2)) return true;
      prev = prev.previousElementSibling;
    }
    return false;
  }
  if (comb === ' ') {
    let anc = el.parentElement;
    while (anc) {
      if (matchesTokens(anc, tokens, idx - 2)) return true;
      anc = anc.parentElement;
    }
    return false;
  }
  return false;
}

function matchesSelectorList(el, selector) {
  const groups = splitTopLevel(String(selector || ''), ',');
  for (const g of groups) {
    const tokens = tokenizeComplexSelector(g);
    if (tokens.length > 0 && matchesTokens(el, tokens, tokens.length - 1)) return true;
  }
  return false;
}

// --- 轻量 HTML 解析器 ---

function parseAttributes(attrStr) {
  const attrs = [];
  let i = 0;
  const s = attrStr;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    if (s[i] === '/') { i++; continue; }
    let name = '';
    while (i < s.length && !/[\s=/>]/.test(s[i])) name += s[i++];
    name = name.toLowerCase();
    if (!name) { i++; continue; }
    while (i < s.length && /\s/.test(s[i])) i++;
    let value = '';
    if (s[i] === '=') {
      i++;
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s[i] === '"' || s[i] === "'") {
        const q = s[i++];
        const start = i;
        while (i < s.length && s[i] !== q) i++;
        value = decodeHtmlEntities(s.slice(start, i));
        if (s[i] === q) i++;
      } else {
        const start = i;
        while (i < s.length && !/[\s>]/.test(s[i])) i++;
        value = decodeHtmlEntities(s.slice(start, i));
      }
    }
    attrs.push([name, value]);
  }
  return attrs;
}

function findTagCloseIndex(html, start) {
  let q = null;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (q) {
      if (ch === q) q = null;
    } else {
      if (ch === '"' || ch === "'") q = ch;
      else if (ch === '>') return i;
    }
  }
  return -1;
}

function parseHtmlNodesInto(html, root, doc) {
  const stack = [root];
  let i = 0;
  const len = html.length;

  while (i < len) {
    const curParent = stack[stack.length - 1];
    if (curParent && curParent.nodeType === 1 && RAW_TEXT_TAGS.has(curParent.localName)) {
      const closeRe = new RegExp(`</${curParent.localName}\\s*>`, 'i');
      const rest = html.slice(i);
      const m = closeRe.exec(rest);
      if (!m) {
        if (rest) curParent.appendChild(new MockTextNode(rest, doc));
        break;
      }
      if (m.index > 0) {
        curParent.appendChild(new MockTextNode(rest.slice(0, m.index), doc));
      }
      stack.pop();
      i += m.index + m[0].length;
      continue;
    }

    const lt = html.indexOf('<', i);
    if (lt === -1) {
      const text = decodeHtmlEntities(html.slice(i));
      if (text) curParent.appendChild(new MockTextNode(text, doc));
      break;
    }
    if (lt > i) {
      const text = decodeHtmlEntities(html.slice(i, lt));
      if (text) curParent.appendChild(new MockTextNode(text, doc));
      i = lt;
    }

    if (html.startsWith('<!--', i)) {
      const endComment = html.indexOf('-->', i + 4);
      if (endComment === -1) break;
      curParent.appendChild(new MockCommentNode(html.slice(i + 4, endComment), doc));
      i = endComment + 3;
      continue;
    }

    if (html.slice(i, i + 9).toLowerCase() === '<!doctype') {
      const endDoc = html.indexOf('>', i);
      if (endDoc === -1) break;
      i = endDoc + 1;
      continue;
    }

    const gt = findTagCloseIndex(html, i + 1);
    if (gt === -1) break;
    const tagContent = html.slice(i + 1, gt).trim();
    i = gt + 1;

    if (!tagContent) continue;

    if (tagContent.startsWith('/')) {
      const closeName = tagContent.slice(1).trim().toLowerCase();
      for (let sIdx = stack.length - 1; sIdx >= 1; sIdx--) {
        if (stack[sIdx].localName === closeName) {
          stack.length = sIdx;
          break;
        }
      }
      continue;
    }

    const selfClosing = tagContent.endsWith('/');
    const cleanContent = selfClosing ? tagContent.slice(0, -1).trim() : tagContent;
    const spaceIdx = cleanContent.search(/\s/);
    const tagName = (spaceIdx === -1 ? cleanContent : cleanContent.slice(0, spaceIdx)).toLowerCase();
    const attrStr = spaceIdx === -1 ? '' : cleanContent.slice(spaceIdx + 1);

    const el = new MockElement(tagName, doc);
    for (const [k, v] of parseAttributes(attrStr)) {
      el.setAttribute(k, v);
    }
    curParent.appendChild(el);
    if (!selfClosing && !VOID_TAGS.has(tagName)) {
      stack.push(el);
    }
  }
}

function parseHtmlFragment(html, doc) {
  const frag = new MockDocumentFragment(doc);
  parseHtmlNodesInto(html, frag, doc);
  return frag;
}

class MockDocument {
  constructor() {
    this.nodeType = 9;
    this._listeners = new Map();
    this.readyState = 'loading';
    this.documentElement = new MockElement('html', this);
    this.head = new MockElement('head', this);
    this.body = new MockElement('body', this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }

  createElement(tag) {
    return new MockElement(tag, this);
  }
  createElementNS(_, tag) {
    return new MockElement(tag, this);
  }
  createTextNode(text) {
    return new MockTextNode(text, this);
  }
  createDocumentFragment() {
    return new MockDocumentFragment(this);
  }
  createComment(text) {
    return new MockCommentNode(text, this);
  }

  getElementById(id) {
    return this.documentElement.getElementById(id);
  }
  querySelector(sel) {
    return this.documentElement.querySelector(sel);
  }
  querySelectorAll(sel) {
    return this.documentElement.querySelectorAll(sel);
  }
  getElementsByTagName(tag) {
    return this.documentElement.getElementsByTagName(tag);
  }
  getElementsByClassName(cls) {
    return this.documentElement.getElementsByClassName(cls);
  }

  addEventListener(type, fn) {
    if (typeof fn !== 'function') return;
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    const list = this._listeners.get(type);
    if (!list.includes(fn)) list.push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners.get(type);
    if (!list) return;
    const idx = list.indexOf(fn);
    if (idx !== -1) list.splice(idx, 1);
  }
  dispatchEvent(event) {
    event.target = event.target || this;
    event.currentTarget = this;
    const list = this._listeners.get(event.type);
    if (list) {
      for (const fn of list.slice()) fn.call(this, event);
    }
    return !event.defaultPrevented;
  }
}

function parseFullHtmlDocument(html) {
  const doc = new MockDocument();
  const root = new MockElement('root', doc);
  parseHtmlNodesInto(html, root, doc);

  const htmlEl = root.querySelector('html');
  const headEl = (htmlEl || root).querySelector('head');
  const bodyEl = (htmlEl || root).querySelector('body');

  if (headEl) {
    doc.head = headEl;
    doc.head.parentNode = doc.documentElement;
  }
  if (bodyEl) {
    doc.body = bodyEl;
    doc.body.parentNode = doc.documentElement;
  }
  if (!headEl && !bodyEl) {
    for (const n of root.childNodes.slice()) doc.body.appendChild(n);
  }
  doc.documentElement.childNodes = [doc.head, doc.body];
  doc.activeElement = doc.body;
  return doc;
}

/**
 * 在 node:vm 中挂载真实 HTML + preload.js + renderer/*.js
 * @param {object} harness ElectronMockHarness 实例
 * @param {'panel'|'settings'} kind 渲染窗口类型
 */
async function mountRendererWindow(harness, kind) {
  const paths = requireRepoPaths();
  const htmlPath = kind === 'panel' ? paths.panelHtml : paths.settingsHtml;
  const win = kind === 'panel' ? harness.getPanelWindow() : harness.getSettingsWindow();
  if (!win) {
    throw new Error(`找不到对应的 BrowserWindow (${kind})，请确认主进程已创建窗口`);
  }

  const htmlRaw = fs.readFileSync(htmlPath, 'utf8');
  const document = parseFullHtmlDocument(htmlRaw);
  const { api, exposed, ipcRenderer } = harness.loadPreloadWithMeta(win);

  const windowListeners = new Map();
  const resizeObservers = [];

  class MockResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      resizeObservers.push(this);
    }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  }

  class MockMutationObserver {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
  }

  const queryObj = win.loadOptions && win.loadOptions.query ? win.loadOptions.query : null;
  const searchStr = queryObj ? `?${new URLSearchParams(queryObj).toString()}` : '';
  const hashStr = win.loadOptions && win.loadOptions.hash ? `#${String(win.loadOptions.hash).replace(/^#/, '')}` : '';

  const sandbox = {
    document,
    navigator: { language: 'zh-CN', platform: 'Win32' },
    location: { href: `file:///${htmlPath.replace(/\\/g, '/')}${searchStr}${hashStr}`, search: searchStr, hash: hashStr },
    HTMLElement: MockElement,
    Element: MockElement,
    Node: MockNode,
    Event: MockEvent,
    CustomEvent: class MockCustomEvent extends MockEvent {
      constructor(type, init = {}) {
        super(type, init);
        this.detail = init.detail;
      }
    },
    KeyboardEvent: class MockKeyboardEvent extends MockEvent {},
    MouseEvent: class MockMouseEvent extends MockEvent {},
    ResizeObserver: MockResizeObserver,
    MutationObserver: MockMutationObserver,
    getComputedStyle: (el) => el.style,
    matchMedia: () => ({
      matches: false,
      media: '',
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }),
    requestAnimationFrame: (cb) => harness.clock.setTimeout(() => cb(harness.clock.perfNow()), 16),
    cancelAnimationFrame: (id) => harness.clock.clearTimeout(id),
    setTimeout: harness.clock.setTimeout,
    clearTimeout: harness.clock.clearTimeout,
    setInterval: harness.clock.setInterval,
    clearInterval: harness.clock.clearInterval,
    Date: harness.clock.FakeDate,
    performance: { now: harness.clock.perfNow },
    Intl,
    console,
    JSON,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    Error,
    TypeError,
    RangeError,
    RegExp,
    URL,
    URLSearchParams,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    addEventListener(type, fn) {
      if (typeof fn !== 'function') return;
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = windowListeners.get(type);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx !== -1) list.splice(idx, 1);
    },
    dispatchEvent(ev) {
      ev.target = sandbox;
      ev.currentTarget = sandbox;
      const list = windowListeners.get(ev.type);
      if (list) {
        for (const fn of list.slice()) fn.call(sandbox, ev);
      }
      return !ev.defaultPrevented;
    },
  };

  // 将 preload 暴露的键挂载到沙箱 window（通常是 niumaAPI）
  for (const [key, val] of Object.entries(exposed)) {
    sandbox[key] = val;
  }
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);

  // 按 HTML 中的 <script> 顺序执行
  const scripts = document.querySelectorAll('script');
  for (const sc of scripts) {
    const src = sc.getAttribute('src');
    if (src) {
      const scriptPath = path.resolve(path.dirname(htmlPath), src);
      const code = fs.readFileSync(scriptPath, 'utf8');
      vm.runInContext(code, context, { filename: scriptPath });
    } else if (sc.textContent.trim()) {
      vm.runInContext(sc.textContent, context, { filename: `${htmlPath}#inline` });
    }
  }

  document.readyState = 'interactive';
  document.dispatchEvent(new MockEvent('DOMContentLoaded', { bubbles: true }));
  document.readyState = 'complete';
  sandbox.dispatchEvent(new MockEvent('load', { bubbles: false }));

  async function flush() {
    for (let i = 0; i < 6; i++) {
      await Promise.resolve();
    }
    if (typeof origSetImmediate === 'function') {
      await new Promise((resolve) => origSetImmediate(resolve));
    }
    for (let i = 0; i < 6; i++) {
      await Promise.resolve();
    }
  }

  await flush();

  function resolveEl(selOrEl) {
    if (typeof selOrEl === 'string') {
      const el = document.querySelector(selOrEl);
      if (!el) throw new Error(`DOM 中未找到元素: ${selOrEl}`);
      return el;
    }
    if (!selOrEl) throw new Error('目标元素为空');
    return selOrEl;
  }

  async function click(selOrEl) {
    const el = resolveEl(selOrEl);
    el.click();
    await flush();
    return el;
  }

  async function setValue(selOrEl, val) {
    const el = resolveEl(selOrEl);
    el.value = String(val);
    el.dispatchEvent(new MockEvent('input', { bubbles: true }));
    el.dispatchEvent(new MockEvent('change', { bubbles: true }));
    await flush();
    return el;
  }

  async function dispatchKey(keyInit, target = document) {
    const ev = new sandbox.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: '',
      code: '',
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      ...keyInit,
    });
    target.dispatchEvent(ev);
    await flush();
    return ev;
  }

  async function triggerResize(w = 330, h = 420) {
    for (const ro of resizeObservers) {
      const targets = Array.from(ro.targets);
      if (targets.length === 0) continue;
      const entries = targets.map((target) => ({
        target,
        contentRect: { width: w, height: h, top: 0, left: 0, right: w, bottom: h },
      }));
      ro.callback(entries, ro);
    }
    await flush();
  }

  function textContent() {
    return document.body.textContent;
  }

  function dispose() {
    ipcRenderer.removeAllListeners();
    if (win && Array.isArray(win._attachedIpcRenderers)) {
      const idx = win._attachedIpcRenderers.indexOf(ipcRenderer);
      if (idx !== -1) win._attachedIpcRenderers.splice(idx, 1);
    }
  }

  return {
    window: sandbox,
    document,
    api,
    exposed,
    win,
    flush,
    click,
    setValue,
    dispatchKey,
    triggerResize,
    textContent,
    dispose,
  };
}

module.exports = {
  MockEvent,
  MockElement,
  MockDocument,
  parseFullHtmlDocument,
  parseHtmlFragment,
  mountRendererWindow,
};
