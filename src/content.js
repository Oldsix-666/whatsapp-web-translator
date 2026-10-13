/**
 * WhatsApp Web 聊天翻译 —— content script
 *
 * 三件事：
 *   1. 监听聊天列表，把对方发来的消息翻译成中文，显示在原气泡下方（绝不改动原文）
 *   2. 把输入框里的中文翻译成对方的语言，写回输入框（可选自动发送）
 *   3. 提供 hover 按钮与快捷键做手动翻译
 *
 * 关键点：WhatsApp Web 是 React 单页应用，class 名混淆且会变，
 * 所以全部靠稳定属性定位，并用 MutationObserver 应对动态渲染与聊天切换。
 */

'use strict';

(() => {
  if (window.__WA_CHAT_TRANSLATOR__) return;
  window.__WA_CHAT_TRANSLATOR__ = true;

  const TAG = '%c[聊天翻译]';
  const TAG_CSS = 'color:#fff;background:#25d366;padding:1px 5px;border-radius:3px';
  const log = (...a) => console.log(TAG, TAG_CSS, ...a);
  const warn = (...a) => console.warn(TAG, TAG_CSS, ...a);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ============================================================ 设置

  const DEFAULTS = {
    autoIncoming: true,             // 收到消息自动翻译
    incomingTarget: 'zh-CN',        // 收到消息翻译成哪种语言
    manualButton: true,             // 显示 hover 翻译按钮
    draftEnabled: true,             // 允许翻译输入框草稿
    draftTargetLang: 'auto',        // 草稿目标语言：'auto' = 跟随对方，也可以直接指定语言代码
    draftFallbackTarget: 'en',      // 'auto' 模式下判断不出对方语言时的兜底
    autoTranslateDraft: false,      // 停止输入后自动翻译草稿
    autoSendAfterTranslate: false   // 翻译完自动发送（默认关，降低风控风险）
  };

  let S = { ...DEFAULTS };

  /** 会话 -> 对方语言，避免每次翻译草稿都重复检测 */
  const chatTargetCache = new Map();

  chrome.storage.sync.get(DEFAULTS, (v) => {
    S = { ...DEFAULTS, ...v };
    log('设置已加载', S);
    resetRowKeys();
    scheduleScan(0);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    let touched = false;
    for (const key of Object.keys(changes)) {
      if (key in DEFAULTS) {
        S[key] = changes[key].newValue;
        touched = true;
      }
    }
    if (touched) {
      log('设置已更新', S);
      chatTargetCache.clear();
      resetRowKeys();
      scheduleScan(0);
    }
  });

  // ============================================================ DOM 定位
  // WhatsApp Web 的 class 名会变，这里一律使用稳定属性，并保留多级 fallback。

  const SEL = {
    messageList: [
      '[data-testid="conversation-panel-messages"]',
      '#main .copyable-area',
      '#main [role="application"]',
      '#main [data-tab="8"]',
      '#main'
    ],
    header: [
      '[data-testid="conversation-info-header-chat-title"]',
      '#main header span[title]',
      '#main header'
    ],
    composer: [
      'div[contenteditable="true"][data-lexical-editor="true"]',
      '#main footer div[contenteditable="true"][role="textbox"]',
      '#main footer div[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]'
    ]
  };

  /** 消息行：这个类名是 WhatsApp 长期稳定使用的，不是混淆名 */
  // data-id 是 WhatsApp 最稳的属性：false_ 开头 = 对方发来，true_ 开头 = 自己发出。
  // message-in / message-out 是历史类名；两套并行，哪边变了另一边还能兜住。
  const ROW_SELECTOR = [
    'div.message-in',
    'div.message-out',
    '[data-id^="false_"]',
    '[data-id^="true_"]'
  ].join(', ');

  const findIn = (selectors, root = document) => {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  };

  /** 取一条消息里的纯文本（可能有多段） */
  /** 消息文本容器，从新到旧多级 fallback */
  const TEXT_SELECTORS = ['span.selectable-text', '.selectable-text', '.copyable-text span', '.copyable-text'];

  function rowText(row) {
    let nodes = [];
    for (const sel of TEXT_SELECTORS) {
      nodes = row.querySelectorAll(sel);
      if (nodes.length) break;
    }
    let out = '';
    for (const node of nodes) {
      const t = (node.innerText || node.textContent || '').trim();
      if (t) out += (out ? '\n' : '') + t;
    }
    return out;
  }

  /**
   * 判断一条消息是不是「对方发来的」。
   * 三级判断，因为 WhatsApp 改版后 message-in / data-id 都不再可靠：
   *   ① 老类名 message-in / message-out
   *   ② data-id 前缀：false_ = 对方，true_ = 自己
   *   ③ 兜底：按文本的水平位置 —— WhatsApp 里对方永远在左、自己永远在右
   */
  function isIncoming(row) {
    if (row.classList.contains('message-in')) return true;
    if (row.classList.contains('message-out')) return false;

    const id = row.getAttribute('data-id') || '';
    if (id.startsWith('false_')) return true;
    if (id.startsWith('true_')) return false;

    const list = findIn(SEL.messageList);
    const span = row.querySelector('span.selectable-text, .selectable-text');
    if (list && span) {
      const s = span.getBoundingClientRect();
      const l = list.getBoundingClientRect();
      if (s.width > 0 && l.width > 0) {
        return (s.left + s.width / 2) < (l.left + l.width / 2);
      }
    }
    return false; // 完全判不出来时按「不是对方发的」处理，绝不翻自己的消息
  }

  function hashOf(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function resetRowKeys() {
    document.querySelectorAll('[data-wa-key]').forEach((el) => { delete el.dataset.waKey; });
  }

  // ============================================================ 译文节点

  /** row(DOM 节点) -> 译文节点。用 WeakMap，避免依赖兄弟节点顺序 */
  const nodeOf = new WeakMap();

  /** 已翻译条数：上报给 background 显示在扩展图标上，不用开发者工具就能看出扩展在工作 */
  let translatedCount = 0;

  function updateBadge() {
    try {
      chrome.runtime.sendMessage({ type: 'wa-badge', count: translatedCount });
    } catch (e) {
      /* 扩展正在重载时忽略 */
    }
  }

  function ensureNode(row) {
    let node = nodeOf.get(row);
    if (node && node.isConnected) return node;

    node = document.createElement('div');
    node.className = 'wa-trans ' +
      (row.classList.contains('message-out') ? 'wa-trans-out' : 'wa-trans-in');

    const body = document.createElement('div');
    body.className = 'wa-trans-body';

    const text = document.createElement('span');
    text.className = 'wa-trans-text';

    const acts = document.createElement('span');
    acts.className = 'wa-trans-acts';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wa-trans-btn';
    btn.textContent = '翻译';
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      delete row.dataset.waKey;
      processRow(row, { force: true });
    });

    acts.appendChild(btn);
    body.appendChild(text);
    body.appendChild(acts);
    node.appendChild(body);

    row.insertAdjacentElement('afterend', node);
    nodeOf.set(row, node);
    return node;
  }

  function setNodeState(node, state, text) {
    node.dataset.state = state;
    const textEl = node.querySelector('.wa-trans-text');
    if (textEl) textEl.textContent = text == null ? '' : text;

    const btn = node.querySelector('.wa-trans-btn');
    if (!btn) return;
    if (state === 'loading') {
      btn.style.display = 'none';
    } else {
      btn.style.display = '';
      btn.textContent = state === 'idle' ? '翻译' : '重新翻译';
    }
  }

  /**
   * 清掉 anchor 消息已消失的译文节点（聊天切换 / 虚拟滚动会重建 DOM）。
   * 注意：这里必须用 collectRows 定位出来的行，不能再用 ROW_SELECTOR ——
   * 类名失效时 ROW_SELECTOR 会返回空集，导致刚插入的译文被当成孤儿全部删掉。
   */
  function sweepOrphans(rows) {
    const alive = new Set();
    for (const row of rows) {
      const n = nodeOf.get(row);
      if (n) alive.add(n);
    }
    document.querySelectorAll('.wa-trans').forEach((n) => {
      if (!alive.has(n)) n.remove();
    });
  }

  // ============================================================ 与 background 通信

  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (res) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message || '扩展通信失败，请在扩展页重新加载'));
        resolve(res);
      });
    });
  }

  async function translateText(text, to, from = 'auto') {
    const res = await sendMessage({ type: 'wa-translate', text, from, to });
    if (!res) throw new Error('没有收到翻译结果');
    if (!res.ok) throw new Error(res.error || '翻译失败');
    return res;
  }

  // ============================================================ 并发队列

  const MAX_CONCURRENT = 3;
  let running = 0;
  const pending = [];
  const queuedRows = new WeakSet();

  function pump() {
    while (running < MAX_CONCURRENT && pending.length) {
      const task = pending.shift();
      running++;
      Promise.resolve()
        .then(task)
        .catch((e) => warn('任务异常', e))
        .finally(() => { running--; pump(); });
    }
  }

  function enqueueRow(row) {
    if (queuedRows.has(row)) return;
    queuedRows.add(row);
    pending.push(() => {
      queuedRows.delete(row);
      return processRow(row);
    });
    pump();
  }

  // ============================================================ 核心：翻译一条收到的消息

  async function processRow(row, opts = {}) {
    if (!row.isConnected) return;
    if (!isIncoming(row)) return; // 只自动翻对方发来的

    const text = rowText(row);
    if (!text) return; // 系统提示、图片、语音等没有文本

    const key = hashOf(text);
    // 文本没变 **且译文节点还在文档里** 才算处理过；
    // 如果节点被 WhatsApp 的 React 重渲染冲掉了，要重新补上。
    const existing = nodeOf.get(row);
    if (!opts.force && row.dataset.waKey === key && existing && existing.isConnected) return;

    const node = ensureNode(row);

    if (!S.autoIncoming && !opts.force) {
      if (S.manualButton) setNodeState(node, 'idle', '');
      else node.remove();
      return;
    }

    row.dataset.waKey = key;
    setNodeState(node, 'loading', '翻译中…');

    try {
      const res = await translateText(text, S.incomingTarget);

      if (!row.isConnected) { node.remove(); return; }
      if (rowText(row) !== text) {           // 节点被复用、内容已变
        delete row.dataset.waKey;
        scheduleScan(80);
        return;
      }

      const targetBase = S.incomingTarget.split('-')[0];
      if (res.detected && res.detected.split('-')[0] === targetBase) {
        setNodeState(node, 'done', '原文已是目标语言，无需翻译');
      } else {
        setNodeState(node, 'done', res.text || '（无译文）');
      }
      translatedCount++;
      updateBadge();
    } catch (e) {
      if (!node.isConnected) return;
      delete row.dataset.waKey;
      setNodeState(node, 'error', '翻译失败：' + e.message + '（可点按钮重试）');
    }
  }

  // ============================================================ 扫描与监听

  let scanTimer = null;

  function scheduleScan(delay = 250) {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, delay);
  }

  /**
   * 收集当前聊天里的消息行。
   * 快路径：类名 / data-id 还能用时直接用。
   * 兜底：全都失效时，从「消息文本」往上找 —— 一路向上，直到父元素里混进了别的消息文本，
   *       那个位置就是这一条消息的边界。这样即使 WhatsApp 把类名全换掉也能定位。
   */
  function collectRows(list) {
    const fast = Array.from(list.querySelectorAll(ROW_SELECTOR)).filter((row) => {
      const parent = row.parentElement;
      return !(parent && parent.closest(ROW_SELECTOR));
    });
    if (fast.length) return { rows: fast, mode: '选择器' };

    const seen = new Set();
    const rows = [];
    list.querySelectorAll('span.selectable-text, .selectable-text').forEach((span) => {
      let row = span;
      let node = span;
      let guard = 0;
      while (node && node.parentElement && node !== list && guard < 12) {
        const parent = node.parentElement;
        if (parent === list) { row = node; break; }
        if (parent.querySelectorAll('span.selectable-text, .selectable-text').length > 1) break;
        row = parent;
        node = parent;
        guard++;
      }
      if (seen.has(row)) return;
      seen.add(row);
      rows.push(row);
    });
    return { rows, mode: rows.length ? '兜底' : '无' };
  }

  function scan() {
    const list = findIn(SEL.messageList);
    if (!list) return;
    const { rows } = collectRows(list);
    sweepOrphans(rows);
    rows.forEach((row) => enqueueRow(row));
  }

  let listObserver = null;
  let observedList = null;

  function attachToList(list) {
    if (listObserver) listObserver.disconnect();
    observedList = list;
    listObserver = new MutationObserver(() => scheduleScan(200));
    listObserver.observe(list, { childList: true, subtree: true, characterData: true });
    log('已挂载聊天列表监听');
    scheduleScan(0);
  }

  function watchAppRoot() {
    let timer = null;
    const rootObserver = new MutationObserver(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const list = findIn(SEL.messageList);
        if (list && list !== observedList) attachToList(list);
      }, 400);
    });
    rootObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ============================================================ 输入框：翻译草稿

  function getComposer() {
    return findIn(SEL.composer);
  }

  function readComposer(el) {
    return (el.innerText || '').replace(/\u200b/g, '').trim();
  }

  /**
   * 往 Lexical 编辑器里写字。
   * 直接改 textContent 是无效的 —— React 会用内部 state 覆盖回来，
   * 必须触发真实的编辑事件，让编辑器自己更新状态。
   */
  /**
   * 让输入框「全选」。
   * 关键坑：WhatsApp 的输入框是 Meta 的 Lexical 编辑器，它维护着自己的选区状态。
   * 只改 DOM 选区它不会立刻同步，于是 execCommand 会把新文本插到旧光标处（表现为译文被追加在原文后面）。
   * 所以改完选区后要手动派发一次 selectionchange，并留一点时间让它同步。
   */
  function selectAllInComposer(el) {
    el.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }

  async function writeComposer(el, value) {
    const want = value.trim();
    el.focus();
    await sleep(40);

    // 方案 1：selectAll + insertText，最贴近真人「全选后打字」
    selectAllInComposer(el);
    await sleep(70);
    try {
      document.execCommand('insertText', false, value);
    } catch (e) {
      warn('execCommand(insertText) 失败', e);
    }
    await sleep(70);

    // 方案 2：selectAll + 模拟粘贴（Lexical 对 paste 有专门的替换逻辑）
    if (readComposer(el) !== want) {
      selectAllInComposer(el);
      await sleep(70);
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', value);
        el.dispatchEvent(new ClipboardEvent('paste', {
          clipboardData: dt, bubbles: true, cancelable: true, composed: true
        }));
      } catch (e) {
        warn('模拟粘贴失败', e);
      }
      await sleep(70);
    }

    // 方案 3：先删空再插入
    if (readComposer(el) !== want) {
      selectAllInComposer(el);
      await sleep(70);
      try { document.execCommand('delete'); } catch (e) { /* ignore */ }
      await sleep(70);
      try { document.execCommand('insertText', false, value); } catch (e) { /* ignore */ }
      await sleep(70);
    }

    return readComposer(el) === want;
  }

  function clickSend() {
    let btn = document.querySelector('#main footer button[data-testid="send"]');
    if (!btn) btn = document.querySelector('button[data-testid="send"]');
    if (!btn) {
      const icon = document.querySelector('#main footer span[data-icon="send"]') ||
                   document.querySelector('span[data-icon="send"]');
      btn = icon ? icon.closest('button') : null;
    }
    if (!btn) {
      warn('找不到发送按钮');
      return false;
    }
    btn.click();
    return true;
  }

  // ---------- 推断「对方语言」 ----------


  function currentChatKey() {
    const el = findIn(SEL.header);
    if (!el) return '';
    const raw = el.getAttribute('title') || el.textContent || '';
    return raw.trim().slice(0, 80);
  }

  async function resolveDraftTarget() {
    // 用户在设置里明确选了目标语言（比如马来语）：直接用，不做任何检测
    const chosen = S.draftTargetLang;
    if (chosen && chosen !== 'auto') return chosen;


    const chatKey = currentChatKey();
    if (chatKey && chatTargetCache.has(chatKey)) return chatTargetCache.get(chatKey);

    // 采样对方最近几条消息，判断对方在用哪种语言
    const list = findIn(SEL.messageList);
    let sample = '';
    if (list) {
      // 用和主流程一致的定位方式采样，别再依赖 div.message-in（WhatsApp 已改版）
      const { rows } = collectRows(list);
      sample = rows
        .filter((row) => isIncoming(row))
        .slice(-6)
        .map(rowText)
        .filter(Boolean)
        .join('\n')
        .slice(-400);
    }
    if (!sample) return S.draftFallbackTarget;

    try {
      const res = await sendMessage({ type: 'wa-detect', text: sample });
      const detected = res && res.ok ? (res.detected || '') : '';
      const base = detected.split('-')[0];
      const incomingBase = S.incomingTarget.split('-')[0];
      const target = (!base || base === incomingBase) ? S.draftFallbackTarget : base;
      log('对方语言 =', detected || '未知', '→ 草稿目标语言 =', target);
      if (chatKey) chatTargetCache.set(chatKey, target);
      return target;
    } catch (e) {
      warn('语言检测失败，改用兜底目标语言', e);
      return S.draftFallbackTarget;
    }
  }

  let draftBusy = false;

  async function translateDraft(andSend, silent) {
    if (draftBusy) return;
    if (!S.draftEnabled) { if (!silent) toast('草稿翻译已在扩展设置里关闭'); return; }

    const el = getComposer();
    if (!el) { if (!silent) toast('找不到输入框，请先打开一个聊天', 'error'); return; }

    const source = readComposer(el);
    if (!source) { if (!silent) toast('输入框是空的'); return; }

    draftBusy = true;
    if (!silent) toast('翻译中…');
    try {
      const target = await resolveDraftTarget();
      const res = await translateText(source, target);

      if (!res.text) throw new Error('返回了空译文');

      const sourceBase = (res.detected || '').split('-')[0];
      if (sourceBase && sourceBase === target.split('-')[0]) {
        toast('原文已经是「' + target + '」，未改动');
        return;
      }

      if (!(await writeComposer(el, res.text))) {
        throw new Error('无法写入输入框，WhatsApp 编辑器可能已改版');
      }

      if (!silent) toast('已翻译成 ' + target + (andSend ? '，正在发送…' : '，可直接发送'));

      if (andSend || S.autoSendAfterTranslate) {
        await sleep(250);
        if (!clickSend()) toast('找不到发送按钮，请手动发送', 'error');
      }
    } catch (e) {
      toast('翻译失败：' + e.message, 'error');
    } finally {
      draftBusy = false;
    }
  }

  // ============================================================ 页面提示条

  let toastEl = null;
  let toastTimer = null;

  function toast(message, kind = 'info') {
    if (!toastEl || !toastEl.isConnected) {
      toastEl = document.createElement('div');
      toastEl.className = 'wa-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.dataset.kind = kind;
    toastEl.dataset.show = '1';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (toastEl) toastEl.dataset.show = '0'; }, 2600);
  }

  // ============================================================ 快捷键（由 background 转发）

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'wa-command') return;
    if (msg.command === 'translate-draft') {
      translateDraft(false);
    } else if (msg.command === 'translate-draft-and-send') {
      translateDraft(true);
    } else if (msg.command === 'toggle-auto-incoming') {
      const next = !S.autoIncoming;
      chrome.storage.sync.set({ autoIncoming: next });
      toast(next ? '已开启：自动翻译收到的消息' : '已关闭：自动翻译收到的消息');
    } else if (msg.command === 'diagnose') {
      showDiagnostics();
    }
  });

  // ============================================================ 启动

  // ============================================================ 自动翻译输入框

  let autoTimer = null;
  let lastAutoText = '';

  /** 中日韩字符：只有草稿里还有这些字符时才自动翻，避免把已是外文的内容反复翻译 */
  const CJK_RE = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

  function scheduleAutoTranslate() {
    if (!S.autoTranslateDraft || !S.draftEnabled) return;
    const el = getComposer();
    if (!el) return;

    const text = readComposer(el);
    if (!text || text === lastAutoText) return;
    if (!CJK_RE.test(text)) return;

    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = setTimeout(async () => {
      autoTimer = null;
      const box = getComposer();
      if (!box) return;
      const current = readComposer(box);
      if (!current || current === lastAutoText || !CJK_RE.test(current)) return;
      lastAutoText = current;
      await translateDraft(false, true);   // 静默翻译，不弹提示
      const after = getComposer();
      if (after) lastAutoText = readComposer(after);
    }, 1200);
  }

  // 事件委托：输入框会被 React 重建，所以监听挂到 document 上
  document.addEventListener('input', (e) => {
    const el = getComposer();
    if (el && (e.target === el || el.contains(e.target))) scheduleAutoTranslate();
  }, true);

  // ============================================================ 页面诊断
  // WhatsApp 的反调试会在 DevTools 打开时把页面卡死，所以把 DOM 命中情况直接画在页面上。

  function diagText() {
    const list = findIn(SEL.messageList);
    const composer = getComposer();
    const count = (sel) => document.querySelectorAll(sel).length;

    const desc = (el) => {
      if (!el) return '未找到 ✗';
      let d = el.tagName.toLowerCase();
      const tid = el.getAttribute('data-testid');
      if (tid) d += '[data-testid="' + tid + '"]';
      else if (el.id) d += '#' + el.id;
      return d + ' ✓';
    };

    const elDesc = (el) => {
      let d = '<' + el.tagName.toLowerCase();
      if (el.id) d += ' id="' + el.id + '"';
      const cls = el.getAttribute('class');
      if (cls) d += ' class="' + String(cls).slice(0, 110) + '"';
      for (const a of Array.from(el.attributes)) {
        if (a.name === 'class' || a.name === 'id' || a.name === 'style' || a.name === 'href') continue;
        d += ' ' + a.name + '="' + String(a.value).slice(0, 70) + '"';
      }
      return d + '>';
    };

    const lines = [
      'URL: ' + location.href,
      '',
      '聊天列表容器 : ' + desc(list),
      '输入框       : ' + desc(composer) + (composer && composer.getAttribute('data-lexical-editor') ? ' [Lexical]' : ''),
      '',
      '消息行统计:',
      '  ROW_SELECTOR          : ' + count(ROW_SELECTOR),
      '  div.message-in        : ' + count('div.message-in'),
      '  div.message-out       : ' + count('div.message-out'),
      '  [data-id]             : ' + count('[data-id]'),
      '  [data-id^=false_]     : ' + count('[data-id^="false_"]'),
      '  [data-id^=true_]      : ' + count('[data-id^="true_"]'),
      '  role="row"            : ' + count('[role="row"]'),
      '  span.selectable-text  : ' + count('span.selectable-text'),
      '  .wa-trans             : ' + count('.wa-trans')
    ];

    if (list) {
      const r = collectRows(list);
      lines.push('', '可定位到的消息行 : ' + r.rows.length + '（定位方式：' + r.mode + '）');
    }

    const firstText = document.querySelector('span.selectable-text');
    lines.push('', '--- 第一个消息文本的祖先链 ---');
    if (!firstText) {
      lines.push('（一个 span.selectable-text 都没有）');
    } else {
      lines.push('文本内容: ' + JSON.stringify((firstText.innerText || '').slice(0, 60)));
      let node = firstText;
      let depth = 0;
      while (node && node !== document.body && depth < 12) {
        lines.push(depth + '. ' + elDesc(node));
        if (node === list) break;
        node = node.parentElement;
        depth++;
      }
    }

    lines.push('', '--- 消息面板的直接子元素（前 6 个）---');
    if (!list || !list.children.length) {
      lines.push('（面板里没有子元素）');
    } else {
      Array.from(list.children).slice(0, 6).forEach((el, i) => {
        lines.push(i + '. ' + elDesc(el) + ' | 文本节点 ' + el.querySelectorAll('span.selectable-text').length + ' 个');
      });
    }

    return lines.join('\n');
  }

  function showDiagnostics() {
    const text = diagText();
    log('诊断结果\n' + text);
    let box = document.getElementById('wa-diag-box');
    if (box) box.remove();
    box = document.createElement('div');
    box.id = 'wa-diag-box';
    box.className = 'wa-diag';

    const head = document.createElement('div');
    head.className = 'wa-diag-head';
    head.textContent = '聊天翻译 · 页面诊断（截图发给开发者）';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'wa-diag-close';
    close.textContent = '×';
    close.addEventListener('click', () => box.remove());
    head.appendChild(close);

    const pre = document.createElement('pre');
    pre.className = 'wa-diag-pre';
    pre.textContent = text;

    box.appendChild(head);
    box.appendChild(pre);
    document.body.appendChild(box);
  }

  function boot() {
    log('已注入，等待 WhatsApp 界面…');
    watchAppRoot();
    const list = findIn(SEL.messageList);
    if (list) attachToList(list);
    else scheduleScan(1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
