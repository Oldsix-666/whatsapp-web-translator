/**
 * WhatsApp Web 聊天翻译 —— background service worker
 *
 * 职责：
 *   1. 代理所有翻译请求（在 service worker 里 fetch，绕开页面的 CORS / CSP 限制）
 *   2. 双引擎：微软（免费、免 key，国内可直连）→ Google（兜底，需要能访问 Google）
 *   3. 内存 LRU 缓存，避免同一条消息被重复请求
 *   4. 转发快捷键指令给 content script
 */

'use strict';

const GOOGLE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const MS_ENDPOINT = 'https://edge.microsoft.com/translate/translatetext';

/** Google 免费接口单次 q 参数的安全上限（URL 长度限制） */
const CHUNK_SIZE = 1500;
/** 缓存条目上限 */
const CACHE_LIMIT = 800;
/** 单次请求超时（毫秒） */
const TIMEOUT = 15000;

/** 引擎尝试顺序。「auto」= 微软优先，失败自动回退 Google */
const AUTO_ORDER = ['microsoft', 'google'];

/**
 * 语言代码映射：本扩展内部统一用 Google 风格，微软需要 zh-Hans / zh-Hant
 */
const TO_MS = { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant', zh: 'zh-Hans' };
const FROM_MS = { 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW' };
const toMsLang = (code) => TO_MS[code] || code;
const fromMsLang = (code) => FROM_MS[code] || code;

// ---------------------------------------------------------------- 缓存
/** @type {Map<string, {text: string, detected: string, from: string, to: string}>} */
const cache = new Map();

const keyOf = (from, to, text) => from + '\u0000' + to + '\u0000' + text;

function cacheGet(k) {
  if (!cache.has(k)) return null;
  const v = cache.get(k);
  cache.delete(k); // 触碰后重新插入，实现 LRU
  cache.set(k, v);
  return v;
}

function cacheSet(k, v) {
  cache.set(k, v);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

// ---------------------------------------------------------------- 通用工具

/** 按句子边界把长文本切成 <= CHUNK_SIZE 的片段 */
function chunkText(text, size = CHUNK_SIZE) {
  if (text.length <= size) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf('. ', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf(' ', size);
    if (cut < size * 0.5) cut = size;
    parts.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest) parts.push(rest);
  return parts;
}

async function fetchWithTimeout(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 用户选择的引擎模式：auto | microsoft | google */
async function getEngineOrder() {
  try {
    const { engineMode } = await chrome.storage.sync.get({ engineMode: 'auto' });
    if (engineMode === 'google') return ['google'];
    if (engineMode === 'microsoft') return ['microsoft'];
  } catch (e) {
    /* storage 不可用时用默认顺序 */
  }
  return AUTO_ORDER;
}

// ---------------------------------------------------------------- 引擎 1：Google
// 免 key 的非公开端点（client=gtx），内地网络通常访问不到，作为兜底

async function googleFetchOnce(text, from, to) {
  const url = new URL(GOOGLE_ENDPOINT);
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', from || 'auto');
  url.searchParams.set('tl', to);
  url.searchParams.set('dt', 't');
  url.searchParams.set('dj', '1'); // 结构化 JSON，比数组格式好解析
  url.searchParams.set('q', text);

  const res = await fetchWithTimeout(url.toString(), { credentials: 'omit' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const sentences = Array.isArray(data && data.sentences) ? data.sentences : [];
  return {
    text: sentences.map((s) => s.trans || '').join(''),
    detected: (data && data.src) || ''
  };
}

// ---------------------------------------------------------------- 引擎 2：微软（Edge/Bing）
// 免 key。注意：旧的 edge.microsoft.com/translate/auth 令牌端点已于 2026-07 由微软退役
// （调用会返回 404），现改为免鉴权的 translatetext 端点：
//   POST body 是「裸字符串数组」["text"]，from 留空即自动检测源语言。

async function msFetchOnce(text, from, to) {
  const url = new URL(MS_ENDPOINT);
  url.searchParams.set('from', from && from !== 'auto' ? toMsLang(from) : '');
  url.searchParams.set('to', toMsLang(to));
  url.searchParams.set('isEnterpriseClient', 'false');

  const res = await fetchWithTimeout(url.toString(), {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([text])
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);

  const data = await res.json();
  const item = Array.isArray(data) ? data[0] : null;
  if (!item) throw new Error('返回格式异常');
  const detected = (item.detectedLanguage && item.detectedLanguage.language) || '';
  return {
    text: (item.translations || []).map((t) => t.text || '').join(''),
    detected: fromMsLang(detected)
  };
}

// ---------------------------------------------------------------- 编排：按顺序尝试引擎

const ENGINES = { google: googleFetchOnce, microsoft: msFetchOnce };

/**
 * @returns {Promise<{text: string, detected: string, from: string, to: string, provider: string, cached?: boolean}>}
 */
async function translate(text, from, to) {
  const cacheKey = keyOf(from, to, text);
  const hit = cacheGet(cacheKey);
  if (hit) return { ...hit, cached: true };

  const order = await getEngineOrder();
  const parts = chunkText(text);
  const failures = [];

  for (const provider of order) {
    try {
      const outs = [];
      let detected = '';
      for (const part of parts) {
        const r = await ENGINES[provider](part, from, to);
        outs.push(r.text);
        detected = r.detected || detected;
      }
      const result = { text: outs.join(''), detected, from, to, provider };
      cacheSet(cacheKey, result);
      return result;
    } catch (e) {
      failures.push(provider + '：' + describeError(e));
    }
  }

  throw new Error(failures.join('；') || '没有可用的翻译引擎');
}

/** 只做语种检测：翻译到 en，取检测结果 */
async function detect(text) {
  const order = await getEngineOrder();
  const sample = text.slice(0, 400);
  for (const provider of order) {
    try {
      const r = await ENGINES[provider](sample, 'auto', 'en');
      if (r.detected) return r.detected;
    } catch (e) {
      /* 换下一个引擎 */
    }
  }
  return '';
}

function describeError(e) {
  if (e && e.name === 'AbortError') return '请求超时（网络不通或需要代理）';
  const msg = (e && e.message) || String(e);
  if (/failed to fetch|fetch failed|load failed|network|err_/i.test(msg)) return '网络不可达（该引擎在当前网络下被阻断）';
  return msg;
}

// ---------------------------------------------------------------- 消息路由

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'wa-badge') {
    const n = Number(msg.count) || 0;
    chrome.action.setBadgeText({ text: n > 0 ? String(n) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#25d366' });
    chrome.action.setTitle({ title: n > 0 ? '聊天翻译：已翻译 ' + n + ' 条' : '聊天翻译设置' });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'wa-translate') {
    const text = String(msg.text == null ? '' : msg.text);
    if (!text.trim()) {
      sendResponse({ ok: true, text: '', detected: '', cached: true });
      return true;
    }
    translate(text, msg.from || 'auto', msg.to || 'zh-CN')
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: describeError(e) }));
    return true; // 异步响应
  }

  if (msg.type === 'wa-detect') {
    const text = String(msg.text == null ? '' : msg.text);
    if (!text.trim()) {
      sendResponse({ ok: true, detected: '' });
      return true;
    }
    detect(text)
      .then((lang) => sendResponse({ ok: true, detected: lang }))
      .catch((e) => sendResponse({ ok: false, error: describeError(e) }));
    return true;
  }
});

// ---------------------------------------------------------------- 快捷键

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'wa-command', command });
  } catch {
    /* 当前标签页不是 WhatsApp Web，忽略 */
  }
});
