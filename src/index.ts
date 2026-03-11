import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { execSync, spawn } from "child_process";

// 1. 全局维护的 Playwright 实例
let browser: Browser | null = null;
let page: Page | null = null;

// 2. 初始化 MCP Server
const server = new Server(
  { name: "playwright-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// 3. 注册工具（告诉 Claude 你能做什么）
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "navigate",
        description: "让浏览器访问指定的 URL",
        inputSchema: {
          type: "object" as const,
          properties: { url: { type: "string" } },
          required: ["url"],
        },
      },
{
        name: "get_page_content",
        description: "获取当前页面的纯文本内容，用于分析页面状态",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "get_interactive_tree",
        description: "获取当前页面最新渲染的可交互元素列表及其专属数字 ID。⚠️ 极度重要：当前网页是动态的单页应用 (SPA)。只要你执行了点击、跳转或表单提交操作，页面的 DOM 结构就会发生变化，之前获取的数字 ID 会立刻全部失效！在执行任何新的交互动作前，你必须重新调用此工具获取最新的视图树和 ID。",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "click_by_id",
        description: "通过数字 ID 点击页面元素。在单次浏览器执行中完成：清理标注 → 定位元素 → 探针检测遮挡 → 执行点击。如果元素被遮挡会返回阻挡者信息，请根据信息决定下一步操作（如先关闭弹窗）。⚠️ ID 必须来自最近一次 get_interactive_tree 的结果。",
        inputSchema: {
          type: "object" as const,
          properties: {
            id: { type: "number", description: "get_interactive_tree 返回的元素编号" },
          },
          required: ["id"],
        },
      },
      {
        name: "type_by_id",
        description: "通过数字 ID 在输入框中填入文本。操作会自动清空输入框原有内容再输入新内容。⚠️ 警告：绝对不要凭空猜测 ID！传入的 ID 必须是你刚刚通过 get_interactive_tree 工具获取到的最新列表中的有效数字。",
        inputSchema: {
          type: "object" as const,
          properties: {
            id: { type: "number", description: "get_interactive_tree 返回的元素编号" },
            text: { type: "string", description: "要输入的文本内容" },
          },
          required: ["id", "text"],
        },
      },
{
        name: "scroll_page",
        description: "向下滚动当前页面，专门用于触发懒加载/无限滚动以获取新数据。⚠️ 调用后必须重新调用 get_interactive_tree 获取最新元素，因为 DOM 已更新。",
        inputSchema: {
          type: "object" as const,
          properties: {
            pixels: { type: "number", description: "滚动的像素数。不填则默认滚动一整屏高度。" },
          },
        },
      },
    ],
  };
});

// 4. 处理工具调用逻辑
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // 确保浏览器已连接（懒加载，通过 CDP 接管已打开的 Chrome）
  if (!browser || !page || page.isClosed()) {
    try {
      // 如果之前的连接断了，先清理
      if (browser) {
        try { await browser.close(); } catch {}
        browser = null;
        page = null;
      }

      // 尝试连接到已运行的 Chrome 调试端口
      let connected = false;
      try {
        browser = await chromium.connectOverCDP('http://localhost:9222');
        connected = true;
      } catch {
        // 连接失败，尝试自动启动 Chrome 调试模式
        console.error("CDP 连接失败，正在自动启动 Chrome 调试模式...");

        // 先检查是否有非调试模式的 Chrome 在运行
        try {
          execSync('pgrep -x "Google Chrome"', { encoding: 'utf-8' });
          // Chrome 正在运行但没有开启调试端口，无法自动启动
          throw new Error("Chrome 已在运行但未开启调试端口。请先完全退出 Chrome，再重试。");
        } catch (checkErr: any) {
          if (checkErr.message?.includes("未开启调试端口")) {
            throw checkErr;
          }
          // pgrep 没找到进程，说明 Chrome 未运行，可以安全启动
        }

        // 启动带调试端口的 Chrome（后台进程，不阻塞）
        const chromeProcess = spawn(
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          ['--remote-debugging-port=9222'],
          { detached: true, stdio: 'ignore' }
        );
        chromeProcess.unref();

        // 等待 Chrome 启动并开放 CDP 端口（最多等 10 秒）
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 500));
          try {
            browser = await chromium.connectOverCDP('http://localhost:9222');
            connected = true;
            break;
          } catch {
            // 继续等待
          }
        }

        if (!connected) {
          throw new Error("自动启动 Chrome 后仍无法连接 CDP 端口。");
        }
      }

      const contexts = browser!.contexts();
      const defaultContext = contexts[0];
      if (!defaultContext) {
        throw new Error("没有可用的浏览器上下文");
      }
      const pages = defaultContext.pages();

      if (pages.length > 0) {
        page = pages[0]!;
      } else {
        page = await defaultContext.newPage();
      }
    } catch (error: any) {
      browser = null;
      page = null;
      return {
        content: [{
          type: "text" as const,
          text: `连接浏览器失败: ${error.message || error}\n\n如果 Chrome 已在运行，请先完全退出后重试。`
        }],
        isError: true,
      };
    }
  }

  // 经过上面的连接逻辑，page 一定存在
  if (!page) {
    return {
      content: [{ type: "text" as const, text: "浏览器页面未初始化" }],
      isError: true,
    };
  }

  const { name, arguments: args } = request.params;

  try {
    if (name === "navigate") {
      await page.goto(args!.url as string);
      return {
        content: [{ type: "text" as const, text: `已成功访问: ${args!.url}` }],
      };
    }

if (name === "get_page_content") {
      const text = await page.evaluate(() => document.body.innerText);
      return {
        content: [{ type: "text" as const, text: `页面内容:\n${text.substring(0, 5000)}` }],
      };
    }

    if (name === "get_interactive_tree") {
      const aiDomTree = await page.evaluate(() => {
        // 递归收集所有交互节点，穿透 Shadow DOM 和同源 iframe
        function collectAllInteractiveElements(root: Document | ShadowRoot): Element[] {
          const elements: Element[] = [];
          try {
            const allNodes = root.querySelectorAll('*');
            for (const node of allNodes) {
              // 穿透 Shadow DOM
              if (node.shadowRoot) {
                elements.push(...collectAllInteractiveElements(node.shadowRoot));
              }
              // 穿透同源 iframe
              if (node.tagName.toLowerCase() === 'iframe') {
                const iframeDoc = (node as HTMLIFrameElement).contentDocument;
                if (iframeDoc) {
                  elements.push(...collectAllInteractiveElements(iframeDoc));
                }
              }

              // 判断 1：标准交互元素
              const isStandard = node.matches(
                'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [tabindex]:not([tabindex="-1"])'
              );

              // 判断 2：视觉启发式检测（cursor: pointer 或 onclick 属性）
              let isCustomClickable = false;
              if (!isStandard) {
                try {
                  const style = window.getComputedStyle(node);
                  if (style.cursor === 'pointer' || node.hasAttribute('onclick')) {
                    isCustomClickable = true;
                  }
                } catch { /* 忽略无法获取样式的节点 */ }
              }

              if (isStandard || isCustomClickable) {
                elements.push(node);
              }
            }
          } catch {
            // 忽略跨域 iframe 访问限制
          }
          return elements;
        }

        // 可见性检测（含视口过滤）
        function isVisible(elem: Element): boolean {
          const rect = elem.getBoundingClientRect();
          const style = window.getComputedStyle(elem);
          return (
            rect.width > 2 &&
            rect.height > 2 &&
            style.opacity !== '0' &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            rect.top < window.innerHeight && rect.bottom > 0 &&
            rect.left < window.innerWidth && rect.right > 0
          );
        }

        // 清除旧的标记
        document.querySelectorAll('.ai-highlight-box').forEach(el => el.remove());

        const rawElements = collectAllInteractiveElements(document);

        // 去重：优先保留更精确的子元素，去掉包含它的父元素
        const visibleElements = rawElements.filter(el => isVisible(el));
        const dedupedElements: Element[] = [];
        for (let i = 0; i < visibleElements.length; i++) {
          const el = visibleElements[i]!;
          // 检查是否有更精确的子元素也在列表中
          const hasChildInList = visibleElements.some(
            (other, j) => j !== i && el.contains(other) && el !== other
          );
          if (!hasChildInList) {
            dedupedElements.push(el);
          }
        }

        const interactiveElements: { id: number; tag: string; text: string }[] = [];
        let idCounter = 1;

        dedupedElements.forEach(el => {
          const id = idCounter++;
          el.setAttribute('data-ai-id', String(id));

          let text = (el as HTMLElement).innerText
            || (el as HTMLInputElement).value
            || el.getAttribute('title')
            || el.getAttribute('aria-label')
            || el.getAttribute('placeholder')
            || '';
          text = text.trim().replace(/\s+/g, ' ');
          if (text.length > 40) text = text.substring(0, 37) + '...';

          const tagName = el.tagName.toLowerCase();
          const type = el.getAttribute('type') ? `[type=${el.getAttribute('type')}]` : '';

          interactiveElements.push({
            id,
            tag: tagName + type,
            text: text || '自定义组件/图标',
          });

          // 在页面上画出带 ID 的蓝色标注框
          const rect = el.getBoundingClientRect();
          const label = document.createElement('div');
          label.className = 'ai-highlight-box';
          label.textContent = String(id);
          Object.assign(label.style, {
            position: 'absolute',
            left: `${rect.left + window.scrollX}px`,
            top: `${rect.top + window.scrollY}px`,
            backgroundColor: '#007acc',
            color: 'white',
            fontSize: '11px',
            fontWeight: 'bold',
            padding: '1px 3px',
            borderRadius: '2px',
            zIndex: '2147483647',
            pointerEvents: 'none',
          });
          document.body.appendChild(label);
        });

        return interactiveElements.map(item => `[${item.id}] <${item.tag}>: "${item.text}"`).join('\n');
      });

      return {
        content: [{ type: "text" as const, text: `当前页面的可交互元素列表:\n${aiDomTree}` }],
      };
    }

    if (name === "click_by_id") {
      const id = args!.id as number;

      // 单次 evaluate：清理标注 → 定位 → 滚动 → 探针检测 → 返回坐标
      const result = await page.evaluate((targetId: number) => {
        // 穿透 Shadow DOM / iframe 查找 data-ai-id
        function findByAiId(root: Document | ShadowRoot): Element | null {
          const el = root.querySelector(`[data-ai-id="${targetId}"]`);
          if (el) return el;
          for (const node of root.querySelectorAll('*')) {
            if (node.shadowRoot) {
              const r = findByAiId(node.shadowRoot);
              if (r) return r;
            }
            if (node.tagName.toLowerCase() === 'iframe') {
              const doc = (node as HTMLIFrameElement).contentDocument;
              if (doc) {
                const r = findByAiId(doc);
                if (r) return r;
              }
            }
          }
          return null;
        }

        // 1. 清理 AI 标注框
        document.querySelectorAll('.ai-highlight-box').forEach(b => b.remove());

        // 2. 查找目标元素
        const el = findByAiId(document);
        if (!el) return { status: 'not_found' as const };

        // 3. 滚动到可见区域（instant 保证同步完成，getBoundingClientRect 立即可靠）
        el.scrollIntoView({ block: 'center', behavior: 'instant' });

        // 4. 获取中心坐标
        const rect = (el as HTMLElement).getBoundingClientRect();
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;

        // 5. 探针检测：检查该坐标最顶层元素是否就是目标（或其父/子）
        const topEl = document.elementFromPoint(cx, cy);
        const probePass = !topEl || topEl === el || topEl.contains(el) || el.contains(topEl);

        let blockerInfo: string | undefined;
        if (!probePass && topEl) {
          const tag = topEl.tagName.toLowerCase();
          const cls = topEl.className?.toString().slice(0, 60) || '';
          const txt = (topEl as HTMLElement).innerText?.trim().slice(0, 50) || '';
          blockerInfo = `<${tag} class="${cls}"> text="${txt}"`;
        }

        // 6. 无论是否被遮挡，都用 el.click() 直接点击目标（穿透遮挡，不破坏 DOM）
        (el as HTMLElement).click();

        return {
          status: 'clicked' as const,
          probePass,
          blockerInfo,
          coords: { x: cx, y: cy },
          tag: el.tagName.toLowerCase(),
          text: (el as HTMLElement).innerText?.trim().slice(0, 30) || '',
        };
      }, id);

      // 处理结果
      if (result.status === 'not_found') {
        return {
          content: [{ type: "text" as const, text: `点击失败：找不到 ID 为 ${id} 的元素。SPA 可能已重渲染，请重新调用 get_interactive_tree。` }],
          isError: true,
        };
      }

      // el.click() 已执行；如果探针通过，补发物理点击加强
      if (result.probePass && result.coords) {
        const { x, y } = result.coords;
        await page.mouse.move(x, y, { steps: 5 });
        await page.waitForTimeout(50);
        await page.mouse.down();
        await page.waitForTimeout(50);
        await page.mouse.up();
      }

      const url = page.url();
      const probeNote = result.probePass ? '' : `\n⚠️ 探针检测到遮挡层: ${result.blockerInfo}，已通过 el.click() 穿透点击。`;
      return {
        content: [{ type: "text" as const, text: `✅ 已点击 <${result.tag}> "${result.text}" [${id}]。当前页面: ${url}${probeNote}` }],
      };
    }

    if (name === "type_by_id") {
      const id = args!.id as number;
      const text = args!.text as string;
      try {
        // 通过 evaluate 穿透 Shadow DOM 查找元素，点击聚焦并清空内容
        const found = await page.evaluate((targetId: number) => {
          function findByAiId(root: Document | ShadowRoot): Element | null {
            const el = root.querySelector(`[data-ai-id="${targetId}"]`);
            if (el) return el;
            for (const node of root.querySelectorAll('*')) {
              if (node.shadowRoot) {
                const result = findByAiId(node.shadowRoot);
                if (result) return result;
              }
              if (node.tagName.toLowerCase() === 'iframe') {
                const doc = (node as HTMLIFrameElement).contentDocument;
                if (doc) {
                  const result = findByAiId(doc);
                  if (result) return result;
                }
              }
            }
            return null;
          }
          const el = findByAiId(document);
          if (el) {
            // 先点击让输入框获得焦点（触发框架的双向绑定）
            (el as HTMLElement).click();
            (el as HTMLElement).focus();
            // 清空已有内容
            if ('value' in el) {
              const nativeSetter = Object.getOwnPropertyDescriptor(
                Object.getPrototypeOf(el), 'value'
              )?.set;
              if (nativeSetter) {
                nativeSetter.call(el, '');
              }
              // 触发 input 和 change 事件，确保框架感知到清空
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return true;
          }
          return false;
        }, id);

        if (found) {
          // 聚焦成功后，用 keyboard.type 逐字输入（兼容性最好）
          await page.keyboard.type(text);
          return {
            content: [{ type: "text" as const, text: `已在元素 [${id}] 中输入: ${text}` }],
          };
        }
        return {
          content: [{ type: "text" as const, text: `输入失败: 找不到 ID 为 ${id} 的元素。请重新获取页面元素树。` }],
          isError: true,
        };
      } catch {
        return {
          content: [{ type: "text" as const, text: `输入失败: 找不到 ID 为 ${id} 的元素。请重新获取页面元素树。` }],
          isError: true,
        };
      }
    }

    if (name === "scroll_page") {
      const pixels = args?.pixels
        ? Number(args.pixels)
        : await page.evaluate(() => window.innerHeight);

      // 滚动策略：
      // 1. 先尝试找到有剩余滚动空间的可滚动容器（CSS overflow），用 scrollTop 滚动
      // 2. 如果找不到或者滚动无效，把鼠标移到页面中央偏左（列表区域）用 mouse.wheel
      //    很多网站用 overflow:hidden + 自定义 JS 滚动，只响应鼠标滚轮事件
      const scrollResult = await page.evaluate((amount: number) => {
        const candidates: { el: Element; area: number; remaining: number; tag: string; cls: string }[] = [];
        const all = document.querySelectorAll('*');
        for (const el of all) {
          const style = window.getComputedStyle(el);
          const overflowY = style.overflowY;
          if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
            const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
            if (el.scrollHeight > el.clientHeight + 10 && remaining > 5) {
              candidates.push({
                el,
                area: el.clientWidth * el.clientHeight,
                remaining,
                tag: el.tagName.toLowerCase(),
                cls: el.className.toString().substring(0, 60),
              });
            }
          }
        }
        candidates.sort((a, b) => b.area - a.area);

        if (candidates.length > 0) {
          const best = candidates[0]!;
          const before = best.el.scrollTop;
          best.el.scrollTop += amount;
          const actual = best.el.scrollTop - before;
          if (actual > 0) {
            return { method: 'scrollTop', actual, tag: best.tag, cls: best.cls, count: candidates.length };
          }
        }
        return null;
      }, pixels);

      if (!scrollResult) {
        // 回退：把鼠标移到页面中央偏左（候选人列表区域），再用滚轮
        const viewport = page.viewportSize() || { width: 1280, height: 800 };
        await page.mouse.move(viewport.width * 0.35, viewport.height * 0.5);
        await page.mouse.wheel(0, pixels);
      }

      await page.waitForTimeout(2000); // 等待懒加载数据渲染

      if (scrollResult) {
        return {
          content: [{ type: "text" as const, text: `已在 <${scrollResult.tag} class="${scrollResult.cls}"> 内滚动 ${scrollResult.actual}px。请调用 get_interactive_tree 获取最新元素列表。` }],
        };
      }
      return {
        content: [{ type: "text" as const, text: `已将鼠标移至列表区域并滚动 ${pixels}px（等待 2 秒）。请调用 get_interactive_tree 获取最新元素列表。` }],
      };
    }

    return {
      content: [{ type: "text" as const, text: "未知的工具调用" }],
      isError: true,
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `操作失败: ${msg}` }],
      isError: true,
    };
  }
});

// 5. 进程退出时断开连接（CDP 模式下 close() 只断开连接，不关闭浏览器）
process.on("SIGINT", async () => {
  await browser?.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await browser?.close();
  process.exit(0);
});

// 6. 启动服务，通过标准输入输出与 Claude 通信
async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Browser MCP Server running...");
}

run();
