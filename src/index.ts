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
        name: "click_element",
        description: "点击页面上的某个元素（使用 CSS 选择器）",
        inputSchema: {
          type: "object" as const,
          properties: { selector: { type: "string" } },
          required: ["selector"],
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
        description: "通过数字 ID 点击页面元素。⚠️ 警告：绝对不要凭空猜测 ID！传入的 ID 必须是你刚刚通过 get_interactive_tree 工具获取到的最新列表中的有效数字。",
        inputSchema: {
          type: "object" as const,
          properties: { id: { type: "number", description: "get_interactive_tree 返回的元素编号" } },
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
        name: "smart_click",
        description: "通过可见文本点击页面元素。支持用 role 缩小匹配范围（如 button、link）。如果有多个匹配项会返回列表，需传 index 指定点击哪一个。",
        inputSchema: {
          type: "object" as const,
          properties: {
            text: { type: "string", description: "元素上的可见文字" },
            role: { type: "string", description: "(可选) ARIA role，如 button、link、checkbox、textbox、heading 等。不传则按纯文本匹配。" },
            exact: { type: "boolean", description: "是否精确匹配文本，默认 false" },
            index: { type: "number", description: "(可选) 多个匹配时指定第几个，从 0 开始" },
          },
          required: ["text"],
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

    if (name === "click_element") {
      await page.click(args!.selector as string);
      return {
        content: [{ type: "text" as const, text: `已点击元素: ${args!.selector}` }],
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
      try {
        // 第一步：在浏览器内定位元素并滚动到可见区域
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
          if (!el) return false;
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          return true;
        }, id);

        if (found) {
          // 等待滚动和渲染稳定
          await page.waitForTimeout(150);

          // 第二步：重新获取坐标（确保滚动后位置准确）
          const coords = await page.evaluate((targetId: number) => {
            const el = document.querySelector(`[data-ai-id="${targetId}"]`);
            if (!el) return null;
            const rect = (el as HTMLElement).getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          }, id);

          if (coords) {
            // 第三步：用 Playwright 真实鼠标点击（isTrusted = true）
            await page.mouse.click(coords.x, coords.y);
            return {
              content: [{ type: "text" as const, text: `已成功点击元素 [${id}]` }],
            };
          }
        }
        return {
          content: [{ type: "text" as const, text: `点击失败: 找不到 ID 为 ${id} 的元素。请重新获取页面元素树。` }],
          isError: true,
        };
      } catch {
        return {
          content: [{ type: "text" as const, text: `点击失败: 找不到 ID 为 ${id} 的元素。请重新获取页面元素树。` }],
          isError: true,
        };
      }
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

    if (name === "smart_click") {
      const text = args!.text as string;
      const role = args?.role as string | undefined;
      const exact = (args?.exact as boolean) ?? false;
      const index = args?.index as number | undefined;

      // 1. 根据是否传了 role 选择定位策略
      let locator;
      if (role) {
        locator = page.getByRole(role as any, { name: text, exact });
      } else {
        locator = page.getByText(text, { exact });
      }

      const count = await locator.count();

      // 2. 没找到
      if (count === 0) {
        return {
          content: [{ type: "text" as const, text: role
            ? `找不到 role="${role}"、文本含 "${text}" 的元素。检查 role 是否正确，或去掉 role 用纯文本匹配。`
            : `找不到包含 "${text}" 的可见元素。尝试更换关键词或设 exact: false。`
          }],
          isError: true,
        };
      }

      // 3. 多个匹配，需要消歧义
      if (count > 1 && index === undefined) {
        const hints: string[] = [];
        for (let i = 0; i < Math.min(count, 5); i++) {
          const desc = await locator.nth(i).evaluate((el: Element) => {
            const tag = el.tagName.toLowerCase();
            const parent = el.parentElement?.textContent?.trim().slice(0, 50) || '';
            return `<${tag}> 上下文: "${parent}"`;
          });
          hints.push(`  [${i}] ${desc}`);
        }
        const extra = count > 5 ? `\n  ...还有 ${count - 5} 个` : '';
        return {
          content: [{ type: "text" as const,
            text: `⚠️ 找到 ${count} 个匹配:\n${hints.join('\n')}${extra}\n请传入 index 参数指定。`
          }],
        };
      }

      // 4. index 越界检查
      if (index !== undefined && (index < 0 || index >= count)) {
        return {
          content: [{ type: "text" as const, text: `index ${index} 越界，有效范围 0~${count - 1}。` }],
          isError: true,
        };
      }

      // 5. 执行点击
      const target = index !== undefined ? locator.nth(index) : locator.first();
      await target.waitFor({ state: 'visible', timeout: 5000 });
      await target.click();

      const url = page.url();
      return {
        content: [{ type: "text" as const,
          text: `✅ 已点击 "${text}"${role ? ` (role=${role})` : ''} [${index ?? 0}]。当前页面: ${url}`
        }],
      };
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
