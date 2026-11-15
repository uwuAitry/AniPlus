# dsh-AniPlus

**给 DSH Web UI 的“有方向”的非线性动效层。**

dsh-AniPlus 是一个客户端 DSH 插件，为菜单、窗口、列表、侧栏、对话行和微交互提供统一的
动效语言。它不替换、不修改、不 fork 任何宿主组件；所有效果都在运行中的页面内注入。

插件刻意坚持“从哪来、回哪去”：从触发器上浮出现的浮层，关闭时也沿原方向缩回，而不是原地淡出。

## 功能

- **菜单与浮层** — 所有 `MenuSurface`（模型列表、指令面板、权限模式、slash 菜单、右键菜单、子菜单）
  按锚点方向位移 + 缩放进入；入场瞬间材质短暂不透明，避免输入框占位文字透出。
- **窗口与面板** — Modal、Settings、审批窗口和全局面板使用轻微的缩放 + 上浮 + 模糊进入；关闭时以短促的
  方向性 ghost 收回。
- **原路收回** — 菜单回锚点方向，对话框向落点缩回，Tooltip 回锚点一侧，Toast 向下滑出淡出。
- **左右侧栏** — 轨道时长仍归宿主（不会拖慢 `dsh-perf-tuner` 的 fast 档），只替换缓动；内容行有轻微入场。
- **列表与对话** — 会话、文件、插件、计划任务行，以及对话区最后几行做轻微上浮淡入，不干扰宿主 FLIP 动画。
- **微交互** — Switch 滑块回弹、SegmentedTabs 指示条滑动、行 hover 位移、滚动到底按钮弹入。
- **设置页** — 设置 → **AniPlus**：总开关、三档强度（克制 / 标准 / 活泼）、分组开关、恢复默认。

所有新增动效都在 `prefers-reduced-motion: no-preference` 下生效；系统要求减少动态效果时，插件不添加任何动效。

## 安装

克隆仓库：

```sh
git clone https://github.com/uwuAitry/AniPlus.git
```

然后任选其一：

1. 从 npm 安装：

   ```sh
   dsh plugin --profile <profile> add dsh-aniplus
   ```

2. 或安装克隆下来的目录：

   ```sh
   dsh plugin --profile <profile> add <AniPlus 路径>
   ```

bundle id 是 `dsh-aniplus`，显示名为 **dsh-AniPlus**。如果插件行提示 `restart-required`，重启一次 DSH。

## 设置

打开 **设置 → AniPlus**：

| 设置 | 说明 |
|---|---|
| Motion enabled | 总开关；关闭后恢复 DSH 原生观感，无需卸载。 |
| Intensity | 克制 / 标准 / 活泼三档，控制位移、缩放和时长。 |
| Motion groups | 菜单、对话框、通知、收起动画、左侧栏、右侧栏、列表、对话、微交互、页面。 |
| Reset to defaults | 恢复标准档。 |

设置保存在当前浏览器的 `dsh-aniplus:settings` 中，不写入 DSH profile，修改立即生效。

## 动画曲线

| Token | 值 | 用途 |
|---|---|---|
| `--anip-ease-emphasized` | `cubic-bezier(0.16, 1, 0.3, 1)` | 菜单、窗口、页面入场：快出慢收 |
| `--anip-ease-standard` | `cubic-bezier(0.22, 1, 0.36, 1)` | 结构位移，同时替换全局 `--ds-ease-in-out` |
| `--anip-ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | 收回、关闭：加速离开 |
| `--anip-ease-spring` | `cubic-bezier(0.34, 1.36, 0.64, 1)` | 仅小元素：Toast、Switch、滚动按钮 |

时长采用 90 / 150 / 200 / 280–320ms 层级；位移控制在 `2–12px`，缩放保持在 `0.96–0.99`。

完整逐部件表见 [docs/MOTION.md](docs/MOTION.md)。

## 选中的宿主钩子

插件只使用宿主原样渲染的稳定属性：

- `data-menu-material`、`data-menu-phase`、`data-anchor-side`、`data-anchor-align`
- `data-trigger-menu`、`data-slot="conversation.input.overlay"`、`--dsh-model-anchor`
- `role="dialog"`、`aria-modal`、`role="tooltip"`、`data-side`
- `data-composer-placeholder`、`data-chat-flow-key`、`data-chat-flow-kind`
- `data-files-entry`、`data-plugin-row`、`data-plugin-item`、`data-row-key`

不选择任何 CSS Modules 哈希类名。DSH 升级后如果某个属性消失，对应规则会静默失效，而不会误伤其他元素。

## 兼容性

- 适配 DSH `0.2.2-rc.3` / DSH Desktop `2.0.23-next`。
- 与 `dsh-perf-tuner` 共存：不修改宿主 duration token 和 `[data-animating]` 轨道时长。
- 与 `dsh-plugin-smooth-stream` 共存：不接管 `assistant-step` 行。
- 右侧栏/dockkit 规则同样作用于 `dsh-better-sidebar`，可通过分组单独关闭。

## 已知限制

- 不 patch React 组件。宿主立即卸载的关闭层，会用有界、`pointer-events: none` 的 ghost 克隆重放
  90–180ms 的退出动画，然后移除。
- 含 `iframe`、`video`、`canvas`、`object`、`embed` 的弹层会跳过 ghost。
- 不改宿主 `AnimatedRows` 的 WAAPI 时长；列表入场只使用不冲突的 `translate`。
- HoverCard compact 卡片缺少稳定钩子，未覆盖。
- 视觉验证为人工检查；`verify.mjs` 是离线契约检查，不是截图测试。

## 开发

```sh
node verify.mjs
```

检查内容：manifest、locale、图标大小、CSS 大括号平衡、keyframe 命名、选择器对应的宿主属性、
slot 名称、reduced-motion 包裹，以及退出 ghost 使用的唯一有界 `MutationObserver`。

```text
AniPlus/
├─ package.json
├─ cordis.patch.yml
├─ index.js            # Host 半边：空 apply
├─ client.js           # 浏览器半边：样式、主题层、设置、ghost
├─ locale/             # en / zh
├─ docs/
│  ├─ ARCHITECTURE.md
│  └─ MOTION.md
├─ icon.svg
├─ verify.mjs
└─ LICENSE
```

## License

MIT，见 [LICENSE](LICENSE)。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
