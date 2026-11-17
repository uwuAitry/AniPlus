# dsh-perf-tuner 补丁包：把诊断根因映射为可回滚补丁

- 日期：2026-11-15
- 关联诊断：[PERF-DIAGNOSIS-2026-11-15.md](./PERF-DIAGNOSIS-2026-11-15.md)
- 目标包：`dsh-perf-tuner`（本环境路径 `~/.dsh/profiles/desktop/node_modules/dsh-perf-tuner`，符号链接到 `D:\zjf2166\Documents\deepseek-harness\默认工作区\dsh-perf-tuner`）
- 前提事实：perf-tuner 此前**已安装但未加载**（仅在 `dependencies`，不在 `dsh.profile.bundles`）。因此它自带的 `contain:layout`、`fast` 轨道、菜单 `blur 40→14` 三补丁此前**均未生效**。本次先修注册链路，再叠加三条新补丁（容器查询隔离 / 右栏轨道对齐 / 流式入场降级），并保留一条默认关闭的高风险窗口化补丁。
- 实测口径：本环境无 CDP 剖析器，**所有「预期收益」数字均标注【假设】**；唯一边有实测尺度的是 perf-tuner 文档记载的 1500 行转录轨道过渡 task ms（`.3s→9100 / .15s→7700 / .1s→6000 / .05s→5900 / none→3400`）。不编造指标。

---

## 一、变更说明表（根因 → 补丁 → 改动文件 → 预期收益 → 风险）

| # | 对应根因（诊断 ID） | 补丁 | 改动文件 / 位置 | 预期收益 | 风险 |
|---|---|---|---|---|---|
| R0 | 整包未加载（`dsh-perf-tuner` 仅 deps） | 注册到 profile 的 bundle 列表 | `~/.dsh/profiles/desktop/package.json` → `dsh.profile.bundles` 增 `"dsh-perf-tuner"` | 使以下**全部**补丁（含原有 3 条）真正生效【假设：改善幅度待 trace】 | 极低；删行即回滚 |
| P1 | **#3** better-sidebar grid 轨道每帧重算中心列 inline-size `@container`（主线 B） | `containerQueryIsolation:'when-wide'`：转录滚动盒（`[data-chat-flow]` 的**直接父级** = `.scroll`）默认 `container-type:normal`，**仅当存在宽表** `.md-table-wide` 时恢复 `inline-size` | `dsh-perf-tuner/lib/client.js` · `stylesheet()` | 【假设】消除侧栏/面板滑动期间对转录子树 `@container` 的**逐帧重算**因子；不消除 `none→3400ms` 的整窗 reflow 地板（那需宿主停止动画 grid 轨道） | 无宽表时 scroll 不再是查询容器，`100cqw` 改由 `.frame` 解析（宽度近似，见下）；选择器依赖 `[data-chat-flow]` 直挂结构，宿主改结构时退化为 frame 容器（无功能损失、仅部分失效） |
| P2 | **#14** 右栏内容过渡与（被缩短的）fast 轨道不同步 → “开完又抖一下”；#3 轨道提速只看左栏 | `rightPanelTrackSpeed:'fast'`：在 `[data-sidebar-right-panel]` 子树内把 `--ds-transition-duration-slow` 重定向为 `--ds-transition-duration-fast` | 同上 | 【假设】右卡 dock/panel 内容过渡 `slow(.3s)→fast(.1s)`，与 frame 轨道同速，消除内容滞后 ~180–200ms | 面板内自定义 `--ds-transition-duration-slow` 过渡也随之变快（更跟手，需 UI 复核观感） |
| P3 | **#5** 520ms `filter:blur`/mask 入场动画被 200ms 轮询**无限重挂**（+#11 绘制侧） | `streamEntranceDegrade:true`：`html:root .dss-root{--dss-fade-ms:1ms!important}`（author `!important` 压过 `.dss-root` 上的 inline var） | 同上 | 【假设】消除对增长文本的持续模糊/遮罩 raster；入场退化为瞬显，**终态（不透明、mask 全开）不变** | 用户可能偏好渐进入场（观感变化）；可 config 关闭。iris/soak 等静态 mask 的终态不变，故安全 |
| P4 | **#1/#2** 长历史全量挂载（“虚拟化/分窗挂载”诉求） | `chatRowContentVisibility`（**默认 `false`**，opt-in）：`[data-chat-flow-key]{content-visibility:auto;contain-intrinsic-size:auto 140px}` | 同上 | 【假设】开启后离屏行跳过渲染/布局，近似浏览器级窗口化 | **冲突/默认关闭**：宿主 `retain()/beginPaging()` 读行 `getBoundingClientRect` 并查 `[data-chat-paging-anchor]`；`content-visibility` 使被跳过行按 `contain-intrinsic-size` 报几何 → 可能破坏滚动锚定/分页。仅 opt-in 且必须用真实 trace 验证分页 |
| 既有 | **#2/#12** 行布局传染 | `chatRowContainment:true`（原有）：`[data-chat-flow-key]{contain:layout}` | 同上 | 每行独立布局作用域，减少跨行布局重排（原注释：scrollHeight 误差 0%） | 无（原有） |
| 既有 | 菜单/浮层合成成本 | `menuMaterial:'balanced'`（原有，`theme.overrideTokens`）：`--dsw-menu-backdrop-filter` `blur(40px)→blur(14px)` | 同上（theme 层） | 14 个浮层 backdrop-filter 成本大降 | 材质观感略变 |
| 既有 | **#3** 左栏轨道 | `sidebarTrackSpeed:'fast'`（原有）：`html:root [data-animating]{transition-duration:var(--ds-transition-duration-fast)}` | 同上 | 左栏 grid 轨道 `.3s→.1s`，重绘帧数减少 | 无（含 reduced-motion 复述保护） |

---

## 二、无法实现 / 存在冲突的条目（明确标注，不省略）

| 诊断根因 | 结论 | 原因 | 建议归属 |
|---|---|---|---|
| **#4 / #6** 流式「markdown 重解析合批」（每 200ms 整段前缀重解析/渲染） | **无法在 perf-tuner 实现** | 纯 CSS/theme 注入无法改变 `dsh-plugin-smooth-stream` 的 `grow()/force()` 轮询节奏（`BODY_POLL_MS=200`）或宿主 `MarkdownText` 的整段重解析频率。P3 只能降级其**绘制侧**（blur），解析/渲染频率未解。 | 需改 `dsh-plugin-smooth-stream`（增量/仅 delta 解析）或宿主 `MarkdownText` 增量渲染 |
| **#1** 真虚拟化 / 行 unmount（分窗挂载） | **冲突，默认关闭** | 宿主分页锚点设计（`retain()` 读行 rect、`beginPaging()` 查 `[data-chat-paging-anchor]`）；`content-visibility` 会改变被跳过行报出的几何，破坏滚动锚定。P4 仅作为 opt-in 提示性补丁存在。 | 需宿主放开 paging anchor / 提供窗口化 API |
| **#7** 重型查看器首次挂载落在动画窗口 / **#8** 文件树未虚拟化 / **#13** 拖拽重排 CodeMirror | **out-of-scope（属 better-sidebar 组件语义）** | 均为 JS 挂载/重排行为（CodeMirror `new`、`entries.map` 全量、拖拽每帧重排），CSS 注入无法安全覆盖其组件生命周期 | 需改 `dsh-better-sidebar`：懒挂载移出动画窗、树虚拟化、拖拽已有 `frame-batcher` 但每帧仍重排 CodeMirror → 需 diff 渲染 |

> 说明：`#3` 的**真解**是宿主「停止动画 grid 轨道」（改 overlay transform/clip 或给转录 `content-visibility`），缩短时长只能削帧数削不掉 3400ms 地板；P1+P2 是 perf-tuner 侧能给出的最大化近似，不等于结构根治。

---

## 三、补丁文件内容

### 3.1 `dsh-perf-tuner/lib/client.js` — 配置扩展（`__PERF_TUNER_CONFIG__`）

```js
const __PERF_TUNER_CONFIG__ = {
  chatRowContainment: true,          // 既有
  chatRowPaint: false,               // 既有
  menuMaterial: "balanced",          // 既有
  sidebarTrackSpeed: "fast",         // 既有
  // 新增 ↓
  containerQueryIsolation: "when-wide", // "off" | "when-wide"
  rightPanelTrackSpeed: "fast",         // "host" | "fast"
  streamEntranceDegrade: true,
  chatRowContentVisibility: false       // opt-in / 高风险，默认关
};
```

### 3.2 `dsh-perf-tuner/lib/client.js` — 注入的 CSS（`stylesheet()` 新增 4 个规则块）

以下为本包实际发出的 `dsh-perf-tuner/perf.css` 全文（已用 `.tmp_clean/test_perftuner.mjs` 跑通 `factory()+apply()` 断言 PASS）：

```css
/* One conversation row (and its group seat) as an independent layout scope. */
[data-chat-flow-key]{contain:layout}
/* Shorten the sidebar track transition so it repaints over fewer frames. */
html:root [data-animating]{transition-duration:var(--ds-transition-duration-fast)}
html:root [data-animating] > [data-side]{transition-duration:var(--ds-transition-duration-fast)}
@media (prefers-reduced-motion:reduce){
  html:root [data-animating]{transition:none}
  html:root [data-animating] > [data-side]{transition:none}
}
/* P1: Transcript scroller = direct parent of the flow column [data-chat-flow].
   Query container ONLY while a wide markdown table needs 100cqw; else normal. */
html:root *:has(> [data-chat-flow]){container-type:normal}
html:root *:has(> [data-chat-flow]):has(.md-table-wide){container-type:inline-size}
/* P2: Right card — retarget its own slow token to fast INSIDE the panel subtree. */
html:root [data-sidebar-right-panel]{--ds-transition-duration-slow:var(--ds-transition-duration-fast)}
/* P3: smooth-stream inline --dss-fade-ms on .dss-root; author !important wins. */
html:root .dss-root{--dss-fade-ms:1ms!important}
/* P4 (default OFF): [data-chat-flow-key]{content-visibility:auto;contain-intrinsic-size:auto 140px} */
```

### 3.3 `~/.dsh/profiles/desktop/package.json` — bundle 注册

```diff
（在 dsh.profile.bundles 数组中，紧随 "dsh-aniplus" 之后插入）
         "dsh-aniplus",
+        "dsh-perf-tuner",
         "oss-prompt-optimizer",
```
（`cordis.yml` 头部明示：插件树由 `package.json → dsh.profile.bundles` 逐 bundle 组合，再叠加 `cordis.patch.yml`；故此行为正确的“实际加载位置”，而非 `dependencies`。）

### 3.4 新增自检脚本 `dsh-AniPlus/.tmp_clean/test_perftuner.mjs`
在 stub DOM 中执行 `window.__ModuleLoader__.load` 捕获 factory → 调用 `apply(ctx)` → 断言输出 CSS 含 P1/P2/P3 规则、且默认**不含** `content-visibility`。结果：`PASS`。

---

## 四、生效核验清单

### 4.1 注册位置（已落地）
- **加载列表**：`~/.dsh/profiles/desktop/package.json` → `dsh.profile.bundles` 含 `"dsh-perf-tuner"` ✅
- **bundle patch**：`dsh-perf-tuner/cordis.patch.yml` 的 `insert: - id: dsh-perf-tuner`（Host 行，包自带）✅
- **client 半**：`package.json` `dsh.bundle.patch=./cordis.patch.yml` + `dsh.client.platform=web` + `exports["./client"]=./lib/client.js` ✅

### 4.2 加载确认方式（重启后）
1. 重启 DSH（或重载窗口；bundle 树在启动时组合，热改 `client.js` 需重载页面）。
2. DevTools Console：
   ```js
   document.querySelector('style[data-plugin-css="dsh-perf-tuner/perf.css"]')?.textContent
   // 期望包含：container-type:normal / --ds-transition-duration-slow:var(--ds-transition-duration-fast) / --dss-fade-ms:1ms!important
   [...document.querySelectorAll('style[data-plugin-css]')].map(s=>s.dataset.pluginCss)
   // 期望含 "dsh-perf-tuner/perf.css"
   ```
3. 功能抽查：
   - 长转录（含宽表）打开侧栏：宽表仍按内容宽度横跨（P1 的 `:has(.md-table-wide)` 分支生效）；
   - 无宽表时开关右栏：`getComputedStyle(document.querySelector('[data-chat-flow]').parentElement).containerType === 'normal'`（P1 生效）；
   - 流式长回复：文本不再持续“发虚”（P3 生效，`getComputedStyle(document.querySelector('.dss-root')).getPropertyValue('--dss-fade-ms')==='1ms'`）。
4. 若该构建启动日志列出已加载插件，确认出现 `dsh-perf-tuner`。

### 4.3 回滚方式
- **配置级（最小、立即）**：把 `__PERF_TUNER_CONFIG__` 中 4 个新键改为 `containerQueryIsolation:"off"` / `rightPanelTrackSpeed:"host"` / `streamEntranceDegrade:false` / `chatRowContentVisibility:false`，重载页面 → 仅剩原 3 条补丁。
- **注册级（整包停用）**：从 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 删除 `"dsh-perf-tuner"` 行，重启 → 恢复“安装但未加载”原状。
- **代码级**：`git`（如 perf-tuner 仓库有历史）revert `lib/client.js` 本次改动。
- 幂等性：CSS 以 `data-plugin-css="dsh-perf-tuner/perf.css"` 单例注入；theme 层以 source id 单例；停用后重载即移除，无残留。

---

## 五、回归/验证建议（补真实数据）
- 本环境无 CDP，上述收益均为**【假设】**。以 `--remote-debugging-port=9222` 起 dev 实例后，用 Performance 面板对「①长会话开关侧栏 ②流式长回复」各录 P1/P2/P3 开/关两组，核对：
  - P1：`Recalculate Style` 中 `@container` 匹配耗时是否随开关变化、侧栏滑动长任务是否下降；
  - P2：右栏内容到位时刻与 frame 轨道结束时刻的差值是否趋零；
  - P3：`Rasterize`/`Paint` 中文本模糊相关是否消失。
- **不要**在未验证分页前把 `chatRowContentVisibility` 打开（见 §二冲突说明）。

---

## 六、第二轮安全优化（2026-11-16）

| 项 | 内容 | 文件 | 收益 | 风险 |
|---|---|---|---|---|
| P5 `streamFollowSnap` | `[data-conversation-scroll].dss-smooth-follow{scroll-behavior:auto!important}`：关掉 smooth-stream 流式期间每帧 smooth 滚动重定向（诊断 #10） | `lib/client.js` | 【假设】减少持续合成器滚动 / 重定向 | 跟手滚动由“丝滑”变“每次增长一跳”；可 config 关 |
| 启动标记 | `apply()` 末尾 `console.info("[dsh-perf-tuner] active / css-bytes=… / <config>")` | `lib/client.js` | 重启后凭日志**定论是否真加载** | 无（仅一行日志） |

**加载定论命令（重启后）**：`grep "dsh-perf-tuner active" ~/.dsh/logs/desktop-next.log` —— 有则客户端半确已运行；无则未加载，需查 `dsh.compatibility.dsh`（包写 `0.2.0-rc.1`，应用 `0.2.2-rc.3`）等门禁。

**能力边界（重申，不假装已解）**：诊断 **#1**（全量挂载 + 每新节点整窗 `O(n log n)` 重排）、**#2**（`:has()` 跨行重样式）、**#4**（markdown 整段重解析）均在宿主/装配层，纯插件 CSS **无法消除**；因此**长会话、长流式仍会卡**，属“结构性天花板”，不是补丁没生效。唯一剩余的大 CSS 杠杆是 `chatRowContentVisibility`（行 `content-visibility:auto` 窗口化）。

**2026-11-16 按用户选择已启用**：`chatRowContentVisibility: true`（行窗口化）+ `ui-chat.transcriptView: compact`（`cordis.patch.yml`）。若遇历史区滚动跳动/分页错位，回滚：窗口化→改回 `chatRowContentVisibility:false`；视图→把 `cordis.patch.yml` 改回 `transcriptView:detailed`；两者都需重载。

---

## 七、第三轮执行（2026-11-16 复诊后，按修复方案 1/3/4 项）

| 项 | 状态 | 内容 | 验证 |
|---|---|---|---|
| 1 补丁载体 | ✅ 已完成 | 通过 `plugin_manager set_bundle` 正式启用 `dsh-perf-tuner`（application:applied；profile bundles 由 26→27，`dsh-perf-tuner` 在列）——非手改，不会被 dshmarket 重写覆盖 | `package.json` bundles=27 且含 perf-tuner |
| 3 定位 renderer JS | ✅ 已实施，待重启采样 | perf-tuner 新增 `diagnostics:true`：每 10s 输出 `[dsh-perf-tuner] diag rows=… seats=… dom=… longtasks=… total=…ms worst=…ms lag=…ms heap=…MB top=…`（PerformanceObserver longtask + 事件循环延迟 + DOM/行数 + JS 堆） | `test_perftuner_diag.mjs` PASS（ACTIVE_LOG_OK / DIAG_LOG_OK） |
| 4 长会话结构 | ⚠️ 部分完成 | 插件侧：`[data-chat-flow-key]{content-visibility:auto;contain-intrinsic-size:auto 140px}` 行窗口化已启用（`chatRowContentVisibility:true`）；**宿主侧“增量排序/局部插入”无法在插件内实现**：`chat-snapshot-builder.ts:1159–1167` 的整窗 `sort/rebuild` 在打包的 app.asar 内，需上游改 `@deepseek-ai/dsh-client-ui-chat`（增量排序键 + 局部 locations/navigation 更新）；本轮不改 asar | 代码路径已定位；无运行时验证 |

**重启后采样**：`grep -E "dsh-perf-tuner (active|diag)" ~/.dsh/logs/desktop-next.log` —— `active` 确认加载；`diag` 给出 rows/seats/dom/longtasks/lag/heap，用于定位 renderer 55% 的 JS 来源（若 longtasks 高且 top 指向某容器，即目标；若 lag 高但 longtasks 少 → 定时器/微任务轮询）。
