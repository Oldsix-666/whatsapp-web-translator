# WhatsApp Web 聊天翻译

一个 Chrome Manifest V3 扩展：在 WhatsApp 网页版（web.whatsapp.com）里

- **收**：对方发来的消息自动翻译成中文，译文显示在原气泡**下方**，原文一个字都不动；
- **发**：把输入框里的中文翻译成对方的语言，再写回输入框（可选自动发送）；
- 支持 hover 手动翻译按钮与全局快捷键。

## 安装（开发者模式）

1. 打开 `chrome://extensions/`，右上角开启 **开发者模式**；
2. 点 **加载已解压的扩展程序**，选择本目录（含 `manifest.json` 的那一层）；
3. 打开 <https://web.whatsapp.com/> 扫码登录，扩展会自动生效；
4. 打开 F12 控制台，看到 `[聊天翻译]` 开头的日志就说明注入成功了。

> 每次改完代码，回到 `chrome://extensions/` 点一下该扩展的 **刷新** 按钮，再刷新 WhatsApp 页面。

## 使用

| 操作 | 效果 |
| --- | --- |
| 收到消息 | 气泡下方自动出现中文译文 |
| 鼠标移到译文上 | 出现 **重新翻译** 按钮 |
| `Alt` + `T` | 把输入框里的中文翻译成对方语言 |
| `Alt` + `Shift` + `T` | 翻译并直接发送 |
| `Alt` + `Shift` + `A` | 临时开关「自动翻译收到的消息」 |
| 点扩展图标 | 打开设置面板 |

快捷键可在 `chrome://extensions/shortcuts` 里改。

## 设置项

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 翻译引擎 | 自动 | 自动 = 微软优先、失败回退 Google；也可锁定只用一个 |
| 自动翻译对方发来的消息 | 开 | 关掉后只保留手动按钮，风险最低 |
| 翻译成 | 简体中文 | 收到消息的目标语言 |
| 显示手动翻译按钮 | 开 | 关掉则完全静默，只在快捷键触发时工作 |
| 允许翻译输入框草稿 | 开 | 关闭后 `Alt+T` 无效 |
| 目标语言自动跟随对方 | 开 | 采样对方最近 6 条消息，自动判断该翻成什么语言 |
| 检测不到时用 | 英语 | 对方语言判断失败时的兜底目标语言 |
| 翻译后自动发送 | **关** | 打开后 `Alt+Shift+T` 会直接发出，注意风控风险 |

## 翻译引擎

默认 `自动`：先试**微软**（`edge.microsoft.com/translate/translatetext`，免费、无需 API key），
失败才回退 **Google**（`translate_a/single?client=gtx`，同样免 key，但需要能访问 Google）。
在扩展面板里可以锁定只用其中一个。

## 工作原理

```
web.whatsapp.com 页面
  └─ content.js（content script）
       ├─ MutationObserver 监听聊天列表变化
       ├─ 用稳定属性定位消息：[data-testid="conversation-panel-messages"]
       │   div.message-in / div.message-out / span.selectable-text
       ├─ 译文节点插在消息行 afterend，原文不动
       └─ 输入框：div[contenteditable][data-lexical-editor="true"]
             写入靠 execCommand('insertText') → 模拟 paste → 触发 input 三级兜底
                    │
                    │ chrome.runtime.sendMessage
                    ▼
  background.js（service worker）
       └─ 依次尝试引擎：microsoft → google
          ① microsoft: POST https://edge.microsoft.com/translate/translatetext（免 key）
          ② google   : GET  https://translate.googleapis.com/translate_a/single?client=gtx
          + 内存 LRU 缓存（800 条）+ 长文本按句切分（1500 字符/片）+ 15s 超时
```

### 为什么不能直接改 textContent

WhatsApp Web 用 React + Meta 的 **Lexical** 编辑器，输入框的内容由框架内部 state 决定。
你直接改 DOM，React 下一次渲染就把它覆盖回原样。所以必须派发真实的编辑事件，
让编辑器自己更新状态 —— 这是这类脚本最容易踩的坑。

### 为什么要 MutationObserver

WhatsApp Web 是单页应用：切聊天、滚动加载、发消息都会重建 DOM 节点甚至整块聊天面板。
只在页面加载时找一次元素，几秒后就全部失效了。方案是：监听 `document.body` 发现面板被替换，
再重新挂到新的列表节点上，同时清掉变成孤儿的译文节点。

## 已知限制

- **选择器会过期**。WhatsApp 不定期改 DOM，改版当天可能失效。所有定位都写了多级 fallback，
  真失效时只需在 `src/content.js` 的 `SEL` 里补一条新选择器。
- **只处理纯文本消息**。图片、语音、文件、贴纸没有可翻译文本，会被自动跳过。
- **译文节点是外来 DOM**。极端情况下（如 WhatsApp 大改虚拟列表）可能出现译文与气泡错位，
  刷新页面即可恢复。
- **两个引擎都是厂商的非公开接口**，随时可能变：
  - 微软 `edge.microsoft.com/translate/translatetext` 是 Edge 浏览器的内部接口。
    旧的令牌端点 `edge.microsoft.com/translate/auth` 已于 **2026-07 由微软退役**（调用返回 404），
    本项目已适配新端点：body 是裸字符串数组 `["text"]`，`from` 留空即自动检测。
  - Google `translate_a/single?client=gtx` 同样不对外承诺，且**在部分网络下不可达**。
  - 要商用建议换成官方 Azure Translator / Cloud Translation API / DeepL（需要 key）。
- **自动发送有风控风险**。批量、高频、机械地自动发送消息是 WhatsApp 判定异常账号的典型特征，
  所以「翻译后自动发送」默认关闭。

## 隐私

扩展会把**被翻译的文本**发送到 `translate.googleapis.com`，其余数据一律留在本地：
设置存在 `chrome.storage.sync`，翻译缓存只在内存里，不写磁盘、不上传任何服务器。
详见 [PRIVACY.md](PRIVACY.md)。

## 发布到 Chrome Web Store 前的清单

- [ ] 改掉 `manifest.json` 里的 `name`：**名称里带 `WhatsApp` 有被 Meta 商标投诉下架的风险**，
      建议改成 `Chat Translator - 网页聊天翻译` 之类，把 WhatsApp 只写在描述里。
- [ ] 准备 **128×128 商店图标**、**1~5 张 1280×800 截图**、**440×280 小促销图**。
- [ ] 把 [PRIVACY.md](PRIVACY.md) 发到一个公开可访问的 URL（GitHub Pages / Gist / 博客都行），
      填进开发者后台的隐私政策字段。
- [ ] 数据使用声明里必须勾选 **Website content（网站内容）** —— 扩展读了页面上的消息文本，
      漏勾是这类扩展被拒的头号原因。同时勾选 **Personal communications（个人通讯）**。
- [ ] 逐条填写权限用途说明：`storage`、`host_permissions` 里的两个域名。
- [ ] 上传的代码**不要压缩混淆**（混淆代码在审核中是明确的减分项，且 MV3 禁止远程代码）。
      本项目的源码本来就是可读的，直接打包 zip 即可。
- [ ] 需要 **$5 一次性注册费** + 开发者账号开启两步验证；注册邮箱之后不可更改。

## 打包

```bash
cd D:/VS_XM/whatsapp
zip -r ../whatsapp-translator.zip . -x "*.git*" -x "README.md" -x "PRIVACY.md"
```

上传时 `manifest.json` 必须在 zip 的**根目录**，不要多套一层文件夹。

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。
