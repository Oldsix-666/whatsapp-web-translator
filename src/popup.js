'use strict';

const DEFAULTS = {
  engineMode: 'auto',
  autoIncoming: true,
  incomingTarget: 'zh-CN',
  manualButton: true,
  draftEnabled: true,
  draftTargetLang: 'auto',
  autoTranslateDraft: false,
  autoSendAfterTranslate: false
};

/** 常用语言（与 content script 里「对方语言」检测的取值保持一致） */
const LANGS = [
  ['zh-CN', '简体中文'],
  ['zh-TW', '繁體中文'],
  ['en', '英语 English'],
  ['ja', '日语 日本語'],
  ['ko', '韩语 한국어'],
  ['es', '西班牙语 Español'],
  ['fr', '法语 Français'],
  ['de', '德语 Deutsch'],
  ['pt', '葡萄牙语 Português'],
  ['ru', '俄语 Русский'],
  ['ar', '阿拉伯语 العربية'],
  ['vi', '越南语 Tiếng Việt'],
  ['th', '泰语 ไทย'],
  ['id', '印尼语 Bahasa Indonesia'],
  ['hi', '印地语 हिन्दी'],
  ['tr', '土耳其语 Türkçe'],
  ['it', '意大利语 Italiano'],
  ['ms', '马来语 Bahasa Melayu'],
  ['my', '缅甸语 မြန်မာ']
];

const FIELDS = [
  'engineMode',
  'autoIncoming',
  'incomingTarget',
  'manualButton',
  'draftEnabled',
  'draftTargetLang',
  'autoTranslateDraft',
  'autoSendAfterTranslate'
];

function fillSelect(el, value) {
  for (const [code, label] of LANGS) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = label;
    el.appendChild(opt);
  }
  el.value = value;
}

/** 语言下拉：首项是「自动跟随对方语言」 */
function fillLangWithAuto(el, value) {
  const auto = document.createElement('option');
  auto.value = 'auto';
  auto.textContent = '自动跟随对方语言';
  el.appendChild(auto);
  for (const [code, label] of LANGS) {
    const o = document.createElement('option');
    o.value = code;
    o.textContent = label;
    el.appendChild(o);
  }
  el.value = value;
}

let statusTimer = null;

function setStatus(text) {
  const el = document.getElementById('status');
  el.textContent = text;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.textContent = ''; }, 1600);
}

function save(key, el) {
  const value = el.type === 'checkbox' ? el.checked : el.value;
  chrome.storage.sync.set({ [key]: value }, () => setStatus('已保存'));
}

chrome.storage.sync.get(DEFAULTS, (stored) => {
  const s = { ...DEFAULTS, ...stored };

  fillSelect(document.getElementById('incomingTarget'), s.incomingTarget);
  fillLangWithAuto(document.getElementById('draftTargetLang'), s.draftTargetLang);

  for (const key of FIELDS) {
    const el = document.getElementById(key);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = Boolean(s[key]);
    else el.value = s[key];
    el.addEventListener('change', () => save(key, el));
  }
});

document.getElementById('shortcutBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

document.getElementById('diagBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) {
    setStatus('找不到当前标签页');
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'wa-command', command: 'diagnose' });
    window.close();
  } catch (e) {
    setStatus('当前标签页不是 WhatsApp Web');
  }
});
