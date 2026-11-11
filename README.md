# 灵动岛 · Claude Code Dynamic Island

> A Dynamic Island for Claude Code on macOS: one black capsule at the top of the screen shows every running Claude Code session — its current step, progress, running tool and timer — and opens into a full list on click or hover.

在 Mac 屏幕顶部用一枚黑色胶囊汇总所有 Claude Code 会话的进度：

- 有刘海的屏幕上，胶囊贴着刘海长出来。
- 没刘海的屏幕上，胶囊画在菜单栏正中，像一个「虚拟刘海」。
- 点一下或悬停，展开成会话列表。

思路参考了 Cindy 的灵动岛，界面和代码都是独立实现的。

```
● 2 个会话进行中  等你授权 Bash 05:12
```

## 安装

需要 macOS 14 或更高版本，以及 Claude Code（Claude 桌面客户端的 Code 标签页，或终端里的 `claude`）。

**1. 装插件**

在终端的 Claude Code 会话里输入：

```
/plugin install dynamic-island --marketplace aidai524/claude-dynamic-island
```

按 `y` 添加插件市场，范围选 user。也可以在普通终端里运行：

```bash
claude plugin install dynamic-island --marketplace aidai524/claude-dynamic-island
```

在 Claude 桌面客户端里（那里不能用 `/plugin`）：点输入框旁的 +，选 Plugins，用 Add marketplace 添加 `aidai524/claude-dynamic-island`，再点 Add plugin。

**2. 装屏幕顶部的灵动岛程序**

在任意一个 Claude Code 会话里输入：

```
/island app
```

它会用插件自带的源码编译 `~/Applications/ClaudeIsland.app` 并打开。编译需要 Xcode 命令行工具；没装的话会提示你先在终端运行 `xcode-select --install`。插件更新后再运行一次，就会换成新版本。

装好以后，每个 Claude Code 会话开始时会自动打开它，每轮任务开始时（最多每分钟一次）也会检查一下。程序意外退出或电脑重启后，下一轮任务一开始它就会回来。不加开机启动项。

想彻底关掉屏幕灵动岛，在会话里输入 `/island app off`，之后它不会再自动打开；输入 `/island app` 可以重新打开。

## 屏幕顶部显示什么

平时，只要有会话在运行、在等你处理，或刚结束还没看，胶囊就会出现；都没有时自动隐藏。

- **呼吸灯：**
  - 绿色：在运行
  - 橙色：在等你处理（授权工具、回答问题、审阅计划）
  - 绿勾：已完成
  - 红色：出错
- **胶囊内容：** 只有一个会话时，显示它当前的步骤、进度 `3/6` 和计时；有多个会话时，显示会话数量和最急的那个会话的状态。
- **提醒：** 有会话完成、出错或开始等你处理时，胶囊会弹开几秒，告诉你是哪个会话。

**展开：** 点一下胶囊马上展开；鼠标在胶囊上停约 0.25 秒也会展开；移开就收起。

展开后每个会话一行，包括：

- 标题（优先用 Claude 桌面客户端里的会话标题）
- 进行中的步骤
- 正在运行的工具
- 子任务
- 计时

点一行会打开 Claude。底部的「隐藏 1 小时」可以让它暂时不显示。

胶囊以外的地方，点击照常落到菜单栏和下面的窗口。

刚结束的会话会一直显示，直到以下任一条件满足：

- 你在 Claude 里打开过它
- 你在胶囊上悬停看过
- 过了 30 分钟

## 输入框上方的胶囊

插件还能在 Claude 输入框正上方显示一枚只看当前会话的胶囊，默认收起。

- `/island on`：显示，点「展开」看完整任务列表
- `/island off`：收起
- `/island app`、`/island app off`：打开、关闭屏幕顶部的灵动岛
- `/island`：切换

这个选择会记住，新会话沿用。

## 进度从哪来

- **任务清单：** Claude 桌面客户端 Code 标签页的任务清单（`update_plan` / `wrap_up`），以及终端里的 `TodoWrite`、`TaskCreate`、`TaskUpdate`。
- **工具调用：** 主对话的每次工具调用，包括开始、结束和出错。
- **后台任务：** 后台 Bash 和子代理的状态。
- **中途启用：** 插件在会话中途启用或会话被恢复时，会从对话历史里回放任务清单。

每个会话把自己的进度写到 `~/.claude/dynamic-island/sessions/<会话 ID>.json`，灵动岛程序再把这些文件汇总显示。

## 读写了哪些文件

全部在本机，不联网：

- **写：** `~/.claude/dynamic-island/sessions/*.json`（每个会话一份进度）；运行 `/island app off` 时写 `~/.claude/dynamic-island/off`。
- **读：** 上面这些文件；Claude 桌面客户端的会话记录 `~/Library/Application Support/Claude/claude-code-sessions/**/local_*.json`，只读取标题、是否归档和最后打开时间。

超过一天没更新的会话文件会被自动清理。

## 关闭与卸载

```bash
claude plugin disable dynamic-island@claude-dynamic-island   # 关闭：不再上报，也不再自动打开灵动岛
claude plugin enable dynamic-island@claude-dynamic-island    # 重新启用
claude plugin uninstall dynamic-island@claude-dynamic-island # 卸载插件
```

卸载后可以把 `~/Applications/ClaudeIsland.app` 和 `~/.claude/dynamic-island/` 一起删掉。

## 开发

- `hooks/`：插件（Claude Code 的函数钩子模块）。测试：`claude plugin test .`
- `island/`：屏幕灵动岛程序（Swift / SwiftUI）。
  - 编译：`sh island/build.sh [输出路径]`
  - `ClaudeIsland --self-test`：状态逻辑检查
  - `ClaudeIsland --hover-test`：在屏幕外放一个真窗口，模拟悬停和点击
  - `ClaudeIsland --snapshot <目录>`：不上屏，直接渲染几张预览图

## 已知限制

- 你点了「允许」之后，「等你授权」还会显示到那个工具跑完：Claude 没有「已批准」的事件可以监听。
- 插件装好之前就已经开着的会话，有时要重开一次才会出现。
- 屏幕灵动岛只支持 macOS。在其他系统上，只有输入框上方的胶囊可用。
