# DSH 渲染卡顿诊断报告

- **日期**：2026-11-15
- **范围**：DSH Web UI（打包于 `resources/app.asar`）在三类场景下的渲染卡顿 —— ①会话记录较长、②正在流式输出、③better-sidebar 滑动/打开/滚动
- **方法**：从 `app.asar` 解出宿主 UI 的完整 TypeScript 源码（`@deepseek-ai/dsh-client-ui-chat` / `-ui-conversation` / `-ui-sidebar-right`），结合在装的 `dsh-better-sidebar`、`dsh-plugin-smooth-stream`、`dsh-aniplus`（本工作区）与 `dsh-perf-tuner` 源码，做**代码路径级归因**。逐条标注置信度：`代码证实`=所引代码行确实执行该工作；`假设`=量级/形状合理但本环境不可观测。
- **并行调查来源**：子代理 `inv-longsession2`（场景①，长会话）、`inv-streaming`（场景②，流式）、`inv-sidebar`（场景③，better-sidebar）；另有 `inv-longsession` 对场景①做独立复检（追加 §7b 订阅扇出等）并由主代理复核采纳。主代理汇总、交叉复核、剔除不可复现项后归因。

>## 0. 结论摘要（先看这里）
>
>1. **三个场景的根因都在“宿主渲染/装配层”，而非单个插件；且高度收敛为两条主线：**
>   - **主线 A（长历史）**：聊天记录**完全不虚拟化**（所有已加载行一次性挂载，`ChatFlow.tsx:52`）；**每新增一个节点**就对整个已加载窗口做一次**重排序 + 重索引**（`O(n log n)`，`chat-snapshot-builder.ts:1159–1167/522/281/1173`）；同时 `ChatView.module.css` 的 `:has()`+兄弟选择器间距规则会在**任意一行的后代变更时跨所有行重匹配**（源码自述 `:81`）。会话越长，这两项越贵 → “会话记录较长”越卡。
>   - **主线 B（每帧尺寸/内容变化）**：中心列是 `container-type: inline-size` 容器（`ChatView.module.css:8,37`），**任何逐帧的宽度变化都会重算其下所有 inline-size `@container` 查询**。这既是 **side-bar 轨道过渡的支配成本**（唯一有实测尺度：1500 行转录，轨道过渡 `.3s→9100`、`none→3400` task ms），也是 fold / 流式滚动跟进等逐帧写布局场景的共同放大器。
>2. **“流式输出”有独立根因，不在上面两条之内**：smooth-stream 每 **200ms** 就把**整段已累积前缀**交给 markdown 重新解析/渲染（`O(n)/flush`，`O(n²/批)`/条回复，`plugin.client.js:693,960–975`）；且入场动画 `filter:blur` 长达 **520ms** 却每 200ms 重新触发一次（`plugin:306,399,404,684,688`）→ 动画**永远播不完**，等于对不断变长的文本持续做模糊/遮罩 raster。
>3. **AniPlus 是放大器，不是根因。** 它的聊天动画确实只作用于末 3 行且**明确排除 `assistant-step`（即正在流的助手正文）**（`client.js:604`）；MutationObserver 只监听 `childList`（结构性增删，非文本增长）；`scroll→measure` 只量“已打开浮层”，与聊天行无关。唯一可感知的次生抖动是**右栏 8px 上浮 + 双淡入（~180–200ms）与“被 perf-tuner 缩短后的 fast 轨道”不同步**（`client.js:577–585,754–763`）。
>4. **关键运维发现：`dsh-perf-tuner` 已安装但当前 profile 未加载。** 它只出现在 `dependencies`（`package.json:15`），**不在 `dsh.profile.bundles`、`cordis.patch.yml`、`cordis.yml`、任何 runtime patch 中**。也就是说，它自带的、恰好针对本报告两个最大成本项的补丁——聊天行 `contain:layout`、菜单 `blur(40px)→14px`、side-bar 轨道 `--ds-transition-duration-fast`——**当前都没生效**。这是**成本最低、可立竿见影**的一项（见 §7）。
>5. **已实测（唯一）尺度来自 dsh-perf-tuner 文档记载的 1500 行转录数据**（非本环境测得）：side-bar 轨道过渡 `.3s→9100 / .15s→7700 / .1s→6000 / .05s→5900 / none→3400` task ms；`none` 仍有 3400ms 的“整窗 reflow 地板”，说明**缩短时长只是削帧数、抹不掉地板**——真正结构解要到 §7。
>6. **最坏组合（三场景叠加）**：`ui-chat` 以 `transcriptView: detailed` 运行 + 数百 turn 已载入 + 正在流式长回复 + 同时打开 better-sidebar（含大文件树/首次打开编辑器）。此时主线 A、B 与 §2 的 P0/P1 一起触发。

---

## 1. 取证方法与局限（务必先读）

- **本环境无可用性能剖析器**：标准 CDP 端口 9222/9229 均未监听；应用只暴露自身 HTTP/ws 端口（28748 等），无 devtools 协议入口。因此**本次不是“实测剖析”，而是“代码路径归因”**。任务口径允许以“可疑代码路径”为证据；下文所有“影响”均为**代码推演量级**，非采样结果。
- **唯一真实数字**：`dsh-perf-tuner/lib/client.js` 注释中自带的 side-bar 轨道过渡实测（1500 行转录）。下文凡引用均标“prior measurement”。
- 宿主源码来自 `app.asar`（打包件），已解出到 `.tmp_clean/host/` 便于复现检索；行号以包内 `src` 为准。
- **运行 profile 实况**（`~/.dsh/profiles/desktop`）：

| 组件 | 状态 | 依据 |
|---|---|---|
| `dsh-aniplus`（本工作区） | **已启用**（link 本仓库） | `package.json` bundles 含 `dsh-aniplus` |
| `dsh-plugin-smooth-stream` 1.6.0 | **已启用**（替换助手节点渲染器） | bundles 含之；`plugin.client.js:818` |
| `dsh-better-sidebar` 0.32.1 | **已启用** | bundles 含之 |
| `dsh-perf-tuner` | **已安装、未加载** | 仅在 `dependencies:15`；bundles/patch/runtime 全无 |
| `@deepseek-ai/dsh-client-ui-chat` | `transcriptView: detailed`（全量转录，折叠负担更重） | `cordis.patch.yml` |

---

## 2. 病因列表（按影响排序）

分级：**P0 = 高影响、应优先**；**P1 = 中高**；**P2 = 中/受限**。每条含：场景 · 复现条件 · 证据 · 影响评估 · 置信度 · 来源。

### P0

**#1｜长会话：全量挂载 + 每个新节点整窗重排/排序/索引重建（O(n log n)）**
- **场景**：①会话记录较长（尤其流式中向长历史追加 step/tool 节点）
- **复现条件**：已加载大量 turn（数百）后助手继续产出新 step/工具节点；`transcriptView: detailed` / 工作细节 verbose（不折叠）时最重。
- **证据**：`ChatFlow.tsx:52`（`entries.map(...)` 每项一个 seat，无范围/无占位/无 slice → 无虚拟化）；`ChatView.tsx:83`（`entries` 是整个已加载窗口）；`chat-snapshot-builder.ts:1159–1167`（新节点 `structural=true` → `orderedVisibleChatNodes(store.values())…` + `locations.rebuild`），`:522`（内部 `visible.sort(...)`），`:281`（`rebuild` 遍历全 `order`），`:1173`（`navigation.rebuild` 遍历全 `timeline.turnOrder`）。
- **影响评估**：**High**。每新增一个节点在主线程同步做一次随 N 增长的排序+重建；N 大时每次 step/tool 切换都有可见顿挫。机型越弱越明显。
- **置信度**：代码证实（机制与规模）；具体 ms 需 trace。
- **来源**：`inv-longsession2` · 场景①。

**#2｜长会话：`:has()` + 兄弟选择器间距规则在任意后代变更时跨行重匹配**
- **场景**：①长会话（叠加②流式写入时尤其明显）
- **复现条件**：历史行多，且有任一行发生后代 DOM 变更（流式文本进入、折叠切换）。
- **证据**：`ChatView.module.css:82–97,141–155,240`（大量 `:is(...) :has(...) ~ / +` 组合的 gap 规则）；**:81 源码自述**“an ancestor :has() here also invalidates the history on unrelated descendant edits.”（祖先 `:has()` 会在无关后代编辑时使历史失效）
- **影响评估**：**High**（机制确定）。每次后代编辑令这些规则在整行集合上重匹配，随行数增长；是“长会话一边流式一边卡”的强机制。
- **置信度**：代码证实（机制）/ 量级假设。
- **来源**：`inv-longsession2` · 场景①。

**#3｜better-sidebar：grid 轨道过渡每帧重算中心列 inline-size `@container` 查询**
- **场景**：③better-sidebar 滑动/打开（**与①长会话强耦合**：长转录上开关最坏）；左栏展开/收起同理。
- **复现条件**：在长转录上打开/关闭右栏（或拖宽）；转录越长、帧数越多越贵。
- **证据**：`SidebarRight.module.css:54–67`（dock 项 `transform: translateX(var(--dsh-sidebar-width))` 随 `--ds-transition-duration-slow` 过渡，与 frame 轨道同一时长变量）；`ChatView.module.css:8,37`（`.frame`/`.scroll` 均 `container-type: inline-size`）；**prior measurement**：1500 行转录轨道过渡 `.3s→9100 / .15s→7700 / .1s→6000 / .05s→5900 / none→3400` task ms——**每帧重解析中心列下的 inline-size 容器查询**。
- **影响评估**：**High**（本报告唯一有实测尺度的成本项，且量级最大）。注意数据形状：`none→3400` 表明存在“一次性整窗 reflow 地板”，**缩短时长削不掉**。
- **置信度**：代码证实（机制）+ 外部实测（量级）。
- **来源**：`inv-sidebar` · 场景③。

**#4｜流式：整段已累积前缀的 markdown 每 200ms 重解析/重渲染（O(n²/批)）**
- **场景**：②正在流式输出
- **复现条件**：回复越长越糟（后段 flush 更慢）；token 越快越明显；batch 极小（≈80）或极大（≈2000）都放大。
- **证据**：`plugin.client.js:942–943`（`ctx.interval(grow('body'), BODY_POLL_MS=200)`；`:4–6` 常量）；`:911–938`（`grow` 遍历所有 block 用 `paragraphTarget` 前进 `shown`）；`:960–975`（每次 `MarkdownView` 拿到 `text = b.text.slice(0, shown)` 整段前缀）；宿主 `AssistantMarkdown.tsx:86`（同样每 chunk 传整块 `text`）。
- **影响评估**：**High**。每次 flush 的成本 ∝ 已显示前缀长度，整条回复累计 O(n²/批)。
- **置信度**：代码证实（每次传整段前缀）；“是否全量重解析 vs 增量 diff”为**假设**——`MarkdownText` 原语包（`@deepseek-ai/dsh-client-ui-primitives`）不在本次解包范围。
- **来源**：`inv-streaming` · 场景②。

**#5｜流式：520ms 入场 `filter:blur`/mask 动画每 200ms 重触发 → 永不完成**
- **场景**：②正在流式输出（motion 开启）
- **复现条件**：快流 + 小 batch；`prefers-reduced-motion` 关时才存在（`plugin:475`）。
- **证据**：`plugin.client.js:684,688`（`restartFade` 每个 flush 都重挂：新子节点逐个动画，**否则重挂最后一个子节点**）；`:305–312`（`restartFade` 内 `node.classList.remove('dss-fresh'); void node.offsetWidth; … add('dss-fresh')`）；`:399,404`（`dss-fade` 时长默认 **520ms**，含 `filter:blur(2px)`/`mask`）。**520ms 动画 > 200ms 轮询** → 未播完即重开。
- **影响评估**：**High（绘制）**。对不断变长的文本块持续做模糊/遮罩批量 raster，表现为持续“发虚/抖”。
- **置信度**：代码证实。
- **来源**：`inv-streaming` · 场景②。

### P1

**#6｜流式：每个 token 上游重渲染助手子树（无 memo、按节点订阅）**
- 场景：②。复现：token 越快越明显。证据：`ChatNodeSeat.tsx:69`（`useChatNode(nodeKey)` 按节点订阅，每次流式更新重渲）；`plugin:818,671,693`（`SmoothAssistantNode`/`MarkdownView` 均为未 memo 的普通函数，每次重建 blocks/MarkdownText 元素）。影响：**Med-High**——200ms 门控只压**绘制**，不压 **React 渲染/markdown 解析频率**。置信：渲染频率代码证实 / 解析成本假设。来源：`inv-streaming`·②。
**#6·补｜长会话/流式：每 seat 多个 snapshot 订阅 → 每次 publish O(N·M) 选择器唤醒（复检新增）**
- 场景：①长会话 / ②流式（每次 settle 边界、折叠提交）。复现：长会话多 seat 同时在线并流式更新。证据：`ChatNodeSeat.tsx:55–61,72–73`（每 node seat ~6 个订阅：`useChatNodeBottom`/`useChatNode`/`useChatNodeProcess`/`useStore`/`usePresentation`×2）；`ChatGroupSeat.tsx:137–166`；`assembly.ts:141–148`（publish 三重 rAF 合并流式更新）、`:183–184`（`snapshot.set(...)` 一次发布唤醒全部订阅）。影响：**Med-High**——单次 O(n) 快照被放大为每次 publish 的 O(N·M) 选择器唤醒，即使无行变化。置信：订阅结构代码证实 / “set 通知全部监听者”为标准 observable-store 假设（store 包未解包）。来源：`inv-longsession`·①（独立复检 §7b）。

**#7｜better-sidebar：重型查看器“首次挂载”正落在动画窗口内**
- 场景：③。复现：**首次**打开编辑器/mermaid/diff/terminal 标签。证据：`chunk-loader.ts:1–20`（CodeMirror/mermaid 为“数 MB”独立包，首次使用才 fetch）；`lazy-chunk.tsx:33–57`（占位→加载后 `createElement(Comp)`）；`TextEditor.tsx:494`（`new CodeMirrorView({…})`）；`SidebarRight.module.css:73–80`（`@starting-style`——因为“被打开动作挂载的 item 需从关闭边缘起步”，即**动画中挂载**）。影响：**High（仅首次打开该类标签）**——网络+解析+执行+挂载与滑动同帧。置信：路径代码证实 / 精确 ms 假设。来源：`inv-sidebar`·③。

**#8｜better-sidebar：未虚拟化的文件树 reveal/mount**
- 场景：③。复现：大/深目录展开后显示右栏。证据：`FileTree.tsx:2082–2102`（`visibleRows` walk 逐行 push，无窗口裁剪）；`:2231–2336`（`renderLevel` 对每展开层 `entries.map(...)`）；行组件虽 `memo`（`:313,417`）只利于重渲、不利于首挂/布局；`.explorerBody{overflow-y:auto}`（`sidebar.module.css:778–784`）。影响：**Med-High**——数百至数千节点在宽度动画中一次性挂载/布局。置信：代码证实。来源：`inv-sidebar`·③。

**#9｜长会话：`settleAssistant` 每次助手完成扫描全部 inputs（O(total events)）**
- 场景：①（每次助手流结束）。证据：`conversation/assembler.ts:316`（`settleAssistant` 内 `[...this.inputs.values()].filter(...)` 物化并过滤整个输入表）。影响：**Med-High**，随已加载事件窗口增长。置信：代码证实。来源：`inv-longsession2`·①。

**#10｜流式：scroll-follow 每次增长读布局 + 写 floor `scrollTop` + smooth 滚动重定向**
- 场景：②（跟随尾部时）。证据：`use-chat-viewport.ts:134–146`（`ResizeObserver` 读 `scrollHeight/clientHeight`）、`:961–968`（`scroller.scrollTop = top`(floor)）；`use-scroll-follow.ts:121`（`element.scrollTop = target`）；`plugin:444`（`.dss-smooth-follow{scroll-behavior:smooth}`）、`:902`（流式时加该类）；`ChatView.module.css:47`（跟随时 `overflow-anchor:none`）。影响：**Med**——每次增长=布局读+写 floor+启动/重定向一段原生平滑滚动，而非一次廉价 snap。置信：代码证实。来源：`inv-streaming`·②。

**#11｜流式：`restartFade` 的 `void node.offsetWidth` 每 flush 强制同步布局 × blocks**
- 场景：②。证据：`plugin.client.js:305–312,684,688`。影响：**Med**——每 block 每 flush 一次强制 reflow/样式重算。置信：代码证实。来源：`inv-streaming`·②。

### P2

**#12｜长会话：fold 批次逐行 `offsetHeight`+`getComputedStyle` 强制同步布局（**仅当前折叠批**的行，已纠正）**
- 场景：①。复现：折叠/展开一个含大量 process 行的 turn 且 motion on（`running` 或 `MOTION_TAIL_MS` 内）。证据：`flow-motion.ts:195–196`（`runBatch` 逐 box `offsetHeight`+`getComputedStyle(...).marginTop`）、`:387–388,436–438`（`collapse`/`reveal` 同样读）。**纠正**：`boxes`（`:154`）只含**本次折叠批 owning 的行**，非全部行（详见 §6 剔除项）。影响：**Med**，被折叠 turn 行数上界。置信：代码证实。来源：`inv-longsession2`·①。
**#13｜better-sidebar：拖拽调宽每帧重排 CodeMirror**
- 场景：③（拖分隔条）。证据：`EditorHost.tsx:474–497`（batched 到 1/帧，但每帧 `setDragWidth` 仍让 EditorHost 重渲、**CodeMirror 因宽度变化重排**，注释明言 `#315`）。影响：**Med**（约 60 次/秒编辑器重排）。置信：代码证实。来源：`inv-sidebar`·③。

**#14｜开关右栏：AniPlus 8px 上浮 + 双淡入与“fast 轨道”不同步（次生可感抖动）**
- 场景：③。证据：`client.js:577–585`（`[data-sidebar-right-opening] [data-dockkit-pane]` 播 `anip-panel-content-in` = 8px 上浮+淡入；子元素再叠 `anip-fade-in 180ms`）、`:754–763`（keyframes）；AniPlus 时长（~180–200ms）**独立于**宿主轨道时长——若轨道被 perf-tuner 改成 fast，轨道先到、内容滞后 ~180–200ms → “开完又抖一下”。影响：**Med（放大器）**。置信：代码证实。来源：`inv-sidebar`·③。

---

## 3. 放大器与已缓解（非根因）

| 项 | 证据 | 影响 | 说明 |
|---|---|---|---|
| AniPlus 全行 `:nth-last-child` 选择器重匹配 | `client.js:604–611` | 低（放大器） | 动画本身确限末 3 行；残余成本是**选择器**在每次 childList 变更时对整行集合重匹配 |
| AniPlus body `childList` MutationObserver | `client.js:328–338,201–237` | 低-中（放大器） | 只处理**变动的** added/removed 节点（非整 body 扫描）；文本增长是 `Text` 节点被跳过；随**结构性**变更量增长；且**即使 exits 组关闭仍在 `ctx.effect` 无条件安装运行**（`client.js:1169`），`collect()` 在 `allowed()` 判定前先跑 `matches/querySelector` |
| AniPlus `scroll→measure`（capture） | `client.js:344,187–201,114–122` | 可忽略（放大器） | `tracked` 只装 `EXIT_TARGETS`（菜单/对话框/浮层），**从不含聊天行/文件树行**；常见情形为 0 |
| `dsh-perf-tuner`（现成补丁） | `lib/client.js` 注释：row `contain:layout`；menu `blur(40px)→14px`；sidebar track `fast` | 已被记载可削成本，但**未加载** | 见 §7：启用它是最低成本的第一步 |

---

## 4. 根因链与跨场景耦合

- **长历史 × 容器查询 × `:has()` × 无序重建**：会话越长 → 行越多 → #1 每次新节点的整窗排序、#2 的 `:has()` 跨行重匹配、#3 的容器查询重算全都随 N 放大。这解释了为什么“会话记录较长”本身就卡，也解释了为什么在长会话上做②流式、③开关右栏会显著更卡。
- **每帧尺寸/内容变化 = 强制布局的公共出口**：side-bar 轨道（#3）、fold（#12）、scroll-follow（#10）、`restartFade`（#11）本质都是“每帧读布局→写布局”。宿主对行锚点的设计与 `container-type: inline-size` 让“窗口化 / `content-visibility`”这道最大可能的优化被卡死（perf-tuner 明确拒绝 `contain:size`，因宿主 `retain()` 读行 `getBoundingClientRect()`、`beginPaging()` 查 `[data-chat-paging-anchor]`）。
- **流式的双重叠加**：smooth-stream 的“批处理”只压**绘制节流**（段落级、200ms），**不压** React 渲染与 markdown 解析频率；动画 520ms 反而比轮询更长 → 持续重绘（#4/#5/#6）。

---

## 5. 待验证疑点（需真实 trace 才能定论，当前不臆断）

1. P0 中 **#1（结构重排）vs #2（CSS `:has()` 重匹配）vs #3（容器查询重算）** 的相对权重——三者都 ~O(N)，只有真实 trace（Performance 火焰图/长任务）能排序。
2. `MarkdownText` 是否**增量**解析：原语包未在本次解包范围；若为增量，则 #4 影响应下调。
3. `collapseTiming='next-input'`（延迟折叠）净效应——是降低峰值抖动还是把“大折叠”整体后移放大？未知。
4. `ui-web` shell 是否在侧栏移动的每一帧对 `[data-animating]` 标记行做 `getBoundingClientRect` 扫描（外部包，`SidebarRight.tsx` 注释提及 `#32341`）——若成立为额外 per-frame rect sweep。
5. 启用 perf-tuner 后的实际改善幅度，及其 `fast` 轨道与 AniPlus 右栏 ~200ms 内容动效的**不同步**是否反而更明显。
6. AniPlus 运行时是否处于 `data-anip-ready` 等就绪态（bundles 已启用，但未采样运行时 DOM 状态）。

---

## 6. 已剔除 / 不可复现项（按要求剔除）

以下为调查中被证伪或无法复现的假设，**不作为病因**：

- ❌“虚拟化损坏/窗口尺寸错误”——**根本无虚拟化**（`ChatFlow.tsx:52` 全量挂载），无虚拟器可坏。
- ❌“`flow-motion` 遍历所有行做强制布局”——`boxes` 只含**当前折叠批**的行（`flow-motion.ts:154`），影响由 High 纠正为 Med（见 #12）。
- ❌“scroll capture 对每个聊天行强制布局”——`tracked` 只装浮层（`client.js:114–122,210–219`），与聊天行无关。
- ❌“MutationObserver 扫描整 body 子树 / 每个 token 触发”——仅 `childList` 的**变动节点**；文本增长不触发（`client.js:328,202`）。降级为结构性放大器。
- ❌“AniPlus 动画了流式文本行”——规则**明确排除** `assistant-step`（`client.js:604`），正在流的正文不受其动画。
- ❌“只动画 3 行 ⇒ 数百个动画齐发”——规则确实限 `:nth-last-child(-n+3)`；残余只是选择器匹配成本。
- ❌“`flow-motion` 每个 chunk 都运行”——只在折叠边界成 burst（~160ms），非每 chunk。
- ❌“better-sidebar 的 frame-batcher 缺失/失效”——滑动是纯 CSS，无逐帧 JS 可批；batcher 已正确覆盖所有指针拖拽路径（`frame-batcher.ts:25–62`）。
- ❌“center-column ResizeObserver 每帧 `setState` 重渲染整个侧栏”——已改为**直接 DOM 写**、零 React（`use-center-column.ts:1–20`），`#315` 老路径已移除。
- ❌“panel `position:absolute` + inline `width` 每帧重渲”——`width` 是**目标值**非动画中间值，无逐帧重渲证据。
- ❌“`will-change:transform` 缺失是缺陷”——故意仅拖拽时启用（`sidebar.module.css:243–254`），静止不付 compositing。
- ❌**所有绝对 ms/帧时数字**——本环境无 profiler/CDP，除“prior measurement”外全部不臆造。

---

## 7. 建议的处理顺序（低成本 → 结构性）

1. **立即（配置级，零改码）**：把 `dsh-perf-tuner` 加入 profile 的 `bundles`（或 `cordis.patch.yml` 显式启用），默认开关 `chatRowContainment:true / sidebarTrackSpeed:'fast' / menuMaterial:'balanced'`——直接命中 #3（轨道）、#12（行 contain:layout）、菜单 blur(40px)。**注意 desync**：需同时把 `SidebarRight.module.css` 的 `.panel` 与 better-sidebar `sidebar.module.css` 底部面板的 `--ds-transition-duration-slow` 一并改为 `fast`，否则内容滞后于轨道（见 #14）。
2. **短期（AniPlus 侧，代码级）**：右栏内容动效跟随宿主轨道时长（`client.js:577–585` 的 `--anip-dur-base` 改为读 `--ds-transition-duration-fast`）；流式场景将 `restartFade` 的入场动画改为“仅首帧/新块触发”，避免 520ms 动画被 200ms 轮询无限重挂（#5/#11）。
3. **中期（宿主，结构调整）**：
   - #3 的真解是**停止动画 grid 轨道**（改为 overlay 的 `transform`/`clip`，或给转录 `content-visibility`，或去掉中心列的 inline-size 容器查询）——缩短时长削不掉 3400ms 地板。
   - #4 让 markdown 渲染**增量**（只解析新增 delta，或对已稳定段落做缓存），把 O(n²) 降为 O(n)。
   - #1 让结构变更**增量**（新节点走局部插入 + 稳定排序键，避免每次全量 `sort`/`rebuild`）。
4. **语义层**：`transcriptView: detailed` / verbose 工作细节模式会关闭整 turn 折叠、最大化 #2/#1 成本；长会话默认建议折叠。

---

## 8. 附录：如何补齐真实性能数据（本环境缺失的一环）

- **取 trace**：以 `--remote-debugging-port=9222` 启动 DSH（或用一次性 dev 实例），`chrome://inspect` 或 CDP `Tracing.start`/`Performance.getMetrics` 采集；重点看长任务（>50ms）、`Recalculate Style`/`Layout` 归因到 `:has()` 规则与容器查询、`Long Animation Frame`。
- **合成复现**：脚本注入 500–1500 行转录；`Performance` 面板分别录制①打开长会话、②流式长回复、③开关右栏 + 展开大树 + 首次打开编辑器；对照组：启用/停用 perf-tuner、motion on/off、`transcriptView` detailed/compact。
- **预期排序校验**：用 trace 验证 §5 疑点 1 的三者权重，并量化 §2 各条的 ms 归因。

---

*说明：本报告为“代码路径归因 + 单一外部实测尺度”，未在本环境做采样剖析；结论区分了“根因（宿主）”与“诱因/放大器（插件）”，并剔除了不可复现项。*
