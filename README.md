# claude-browser-mcp

> 基于 MCP (Model Context Protocol) 的浏览器自动化服务，让 Claude 等 AI 助手通过 Playwright + CDP 接管用户真实的 Chrome 浏览器，执行导航、点击、输入、滚动等网页操作。

---

## 目录

- [功能清单](#功能清单)
- [技术栈](#技术栈)
- [核心架构](#核心架构)
  - [数据流](#数据流)
  - [浏览器连接（懒加载 + 自动启动）](#浏览器连接懒加载--自动启动)
  - [交互元素树（虚拟 Accessibility Tree）](#交互元素树虚拟-accessibility-tree)
  - [输入框兼容性处理](#输入框兼容性处理)
  - [智能文本点击（smart_click）](#智能文本点击smart_click)
  - [文本定位与滚动（find_text_and_scroll）](#文本定位与滚动find_text_and_scroll)
  - [滚动策略](#滚动策略)
- [配置与部署](#配置与部署)
  - [环境要求](#环境要求)
  - [构建与运行](#构建与运行)
  - [客户端集成](#客户端集成)
  - [Chrome 调试模式](#chrome-调试模式)
- [代码亮点](#代码亮点)

---

## 功能清单

项目暴露 **9 个 MCP Tools**，无 Resources 和 Prompts。

| Tool | 功能 | 必填参数 |
|---|---|---|
| `navigate` | 导航到指定 URL | `url: string` |
| `click_element` | 通过 CSS 选择器点击元素 | `selector: string` |
| `get_page_content` | 获取页面纯文本（截断 5000 字符） | 无 |
| `get_interactive_tree` | 扫描所有可交互元素，返回带编号列表，并在页面叠加蓝色标注框 | 无 |
| `click_by_id` | 通过数字 ID 点击元素，含探针检测遮挡 + el.click() + 物理补点 | `id: number` |
| `type_by_id` | 通过数字 ID 定位输入框，清空后逐字输入文本 | `id: number`, `text: string` |
| `smart_click` | 通过可见文本点击元素，支持 ARIA role 过滤和多匹配消歧义 | `text: string`；可选 `role`, `exact`, `index` |
| `find_text_and_scroll` | 在页面中查找指定文本并自动滚动到可视区域，返回交互信息 | `text: string` |
| `scroll_page` | 滚动页面，自动检测可滚动容器或回退到鼠标滚轮 | 可选 `pixels: number` |

---

## 技术栈

| 类别 | 选型 |
|---|---|
| 语言 | TypeScript 5.9（strict 模式） |
| 运行时 | Node.js（ESM，`"type": "module"`） |
| MCP SDK | `@modelcontextprotocol/sdk` ^1.27.1 |
| 浏览器自动化 | `playwright` ^1.58.2（仅 Chromium CDP 连接） |
| 构建工具 | `tsc`（TypeScript 编译器直出） |
| 传输协议 | Stdio（`StdioServerTransport`） |

### TypeScript 配置特点

- `target: esnext` + `module: nodenext` — 现代 ESM 输出
- `strict: true` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` — 超严格类型检查
- `verbatimModuleSyntax: true` — 强制显式 `type` 导入

---

## 核心架构

### 数据流

```
Claude Desktop / Claude Code
      ↕ (stdio JSON-RPC)
  StdioServerTransport
      ↕
  MCP Server (request handlers)
      ↕
  Playwright CDP Connection
      ↕
  用户真实 Chrome 浏览器 (localhost:9222)
```

### 浏览器连接（懒加载 + 自动启动）

每次工具调用时检查 `browser` / `page` 状态，采用**三级降级策略**：

1. **尝试连接** — 直连已有 CDP 端口 `localhost:9222`
2. **冲突检测** — 若连接失败，通过 `pgrep` 检测 Chrome 是否已运行。已运行但未开调试端口则报错提示用户退出
3. **自动启动** — Chrome 未运行时自动 `spawn` 启动带 `--remote-debugging-port=9222` 的 Chrome，轮询等待最多 10 秒

### 交互元素树（虚拟 Accessibility Tree）

`get_interactive_tree` 是项目最核心的设计，在浏览器内执行 `page.evaluate()` 完成：

1. **元素收集** — 递归穿透 Shadow DOM 和同源 iframe
2. **交互性判断** — 标准选择器（`a/button/input` 等）+ 启发式检测（`cursor: pointer`、`onclick` 属性）
3. **可见性过滤** — 尺寸 > 2px、非隐藏、在视口内
4. **去重** — 若父子元素都在列表中，只保留更精确的子元素
5. **视觉标注** — 在页面叠加蓝色编号标签（`z-index: 2147483647`），每次调用先清除旧标注

### 输入框兼容性处理

`type_by_id` 对前端框架双向绑定做了特殊处理：

- 通过原型链获取 `value` 的**原生 setter** 清空内容（绕过 React/Vue 的合成事件机制）
- 手动触发 `input` 和 `change` 事件确保框架感知
- 使用 `keyboard.type()` 逐字输入保证 `isTrusted = true`

### 智能文本点击（smart_click）

基于 Playwright 原生定位器的**多级回退策略**：

1. **Playwright locator** — 优先使用 `getByRole()` 或 `getByText()` 精准定位
2. **多匹配消歧义** — 匹配多个时返回上下文列表，由调用方传 `index` 指定
3. **DOM 回退** — locator 找不到时，在 DOM 中按文本搜索（穿透 Shadow DOM），定位后用坐标物理点击

### 文本定位与滚动（find_text_and_scroll）

利用 Playwright 的 `getByText()` 原生文本定位能力：

1. **模糊匹配** — `page.getByText(text, { exact: false })` 查找包含指定文本的元素
2. **自动滚动** — 调用 `scrollIntoViewIfNeeded()` 将目标滚动到视口中央
3. **交互信息返回** — 检查目标元素或其祖先是否有 `data-ai-id`，有则直接返回 ID 供后续 `click_by_id` 使用

### 滚动策略

采用**双重策略**：

1. **优先** — 查找有剩余滚动空间的 `overflow: auto/scroll` 容器，直接操作 `scrollTop`
2. **回退** — 将鼠标移至页面中央偏左位置发送 `mouse.wheel` 事件（兼容自定义 JS 滚动）
3. 滚动后等待 **2 秒**让懒加载数据渲染

---

## 配置与部署

### 环境要求

- **Node.js** 18+（需支持 ESM）
- **Google Chrome** — 安装在 `/Applications/Google Chrome.app`（macOS 路径，硬编码）
- **Playwright** — 仅使用 CDP 连接能力，无需额外安装浏览器二进制

### 构建与运行

```bash
cd claude-browser-mcp
npm install
npm run build   # tsc 编译到 dist/
npm start       # 启动 MCP Server（通常由 Claude 自动调起）
```

### 客户端集成

在 Claude Desktop 的 `claude_desktop_config.json` 或 Claude Code 的 MCP 配置中添加：

```json
{
  "mcpServers": {
    "browser-bot": {
      "command": "node",
      "args": ["/path/to/claude-browser-mcp/dist/index.js"]
    }
  }
}
```

### Chrome 调试模式

如需手动启动（Server 也会自动启动）：

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

> **注意**：如果 Chrome 已在运行但未开启调试端口，需先完全退出 Chrome 再重试。

---

## 代码亮点

### 1. CDP 接管真实浏览器

不启动独立浏览器实例，而是通过 `chromium.connectOverCDP()` 接管用户**正在使用的 Chrome**，保留登录状态、Cookie 和扩展插件。

### 2. 自修复连接机制

每次工具调用检查 `page.isClosed()`，断开后自动重连。还能自动启动 Chrome 调试模式并轮询等待就绪——零配置体验。

### 3. 视觉 DOM 标注系统

`get_interactive_tree` 不仅返回文本列表，还在网页上叠加蓝色编号标签（`.ai-highlight-box`），让 AI 的"视角"可视化，便于调试。

### 4. Shadow DOM + iframe 穿透

`collectAllInteractiveElements()` 递归穿透 Shadow DOM（Web Components）和同源 iframe，在复杂 SPA 中不遗漏元素。

### 5. 框架感知输入

清空输入框时通过 `Object.getOwnPropertyDescriptor` 获取原生 `value` setter，确保 React 受控组件、Vue `v-model` 等场景下框架正确感知值变化。

### 6. 单文件架构

整个 MCP Server 单一 `src/index.ts`，无多余抽象层——对功能明确的 MCP Server 而言，这是恰当的复杂度。
