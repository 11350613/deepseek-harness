# Agent Note: 工作区目录树是按分栏保存的状态，在每个文件 tab 内绘制；挂载它的插件决定文件在哪里打开

Status: implemented

[English](2026-10-20-workspace-tree-state-per-pane.md) | 中文

## 问题

连续阅读多个工作区文件需要预览旁的目录树在每次切换 tab 后保留展开状态、已加载的层、宽度、滚动位置与键盘位置。停靠布局只挂载选中 tab 的正文，因此组件实例不能拥有分栏内各文件 tab 共用的状态。

一个浮窗只容纳一个 tab。预览的文件选择器必须在浮窗内替换该 tab，文件页则必须保持可用，并在停靠区打开内容。遮盖正文的目录树应在内容被导航到的地方关闭，而不是在发起点击的地方关闭。

## 决定

### 目录树在每个文件 tab 内绘制，其状态按分栏保存

`ui-sidebar-right` 通过 `useTabInfo().panel` 提供所在分栏的 `id` 与 `isFloating`；移动 tab 时更新这些字段，`tab.id` 保持不变。它不提供分栏生命周期。`ui-sidebar-files` 拥有各分栏的目录树状态、可见性、宽度、列举、目录监听、滚动与上次定位的文件。导航栏和开关是 Session 作用域的 Component Factory；`ui-sidebar-documentpreview` 在 tab 的内容行与头部渲染它们，加载状态变化时保持位置稳定。停靠套件不增加 files 专属的覆盖层或布局规则。

分栏记录跟随最近在该分栏绘制导航栏的 tab，以各 tab 的 `signal` 为依据。同一分栏内的替换保留记录。移走的 tab 使用目标分栏的记录；没有记录的分栏默认隐藏目录树、使用默认宽度。tab 拥有的预览滚动状态独立于目录树状态。最后一个关联 tab 关闭或在别处绘制导航栏后，记录被释放。

目录监听跟随可见的绘制，而不是保留的记录。隐藏的目录树不持有 Host 目录监听；再次显示时保留行并刷新根目录与已展开目录。同一分栏内切换 tab 时，替代绘制之间保留目录列表与监听。这把[目录监听生命周期](../feature/2026-09-17-sidebar-file-and-directory-auto-refresh.zh.md)从单个 tab 扩展为分栏中已绘制的目录树。

files face 负责跨绘制的祖先定位、滚动、行宽测量与焦点。另一 tab 在同一分栏内替代持有焦点的目录树时，键盘焦点跟随当前文件所在行；揭示另一分栏时，发起侧目录树保持不变。工作区命令显示已登记在停靠 tab 旁的导航栏，否则打开始终可见的文件页。[导航栏参考](../../../../packages/client/ui-sidebar-files/README.zh.md#the-navigator)定义布局阈值与键盘规则。

### 各行是以扁平条目为输入的受控 Component Factory

root 作用域的 `sidebar.files.tree` Factory 将可复用的行、局部 `accessory` slot 和本地化文案留在 files 插件。调用方负责数据访问、展开、打开与定位。工作区导航栏把分栏的目录状态转换为这些输入，不启用可复用 Factory 的可选新 tab 菜单。其他调用方仍可通过 `newTab` 启用该菜单，并接收 `TreeOpenOptions`。

### 挂载目录树的插件决定文件落在哪里

`FileNavigatorInput.onOpen(address)` 是容纳导航栏的插件提供的回调。导航栏构造文件地址，但不选择落位，也不在调用后关闭发起侧目录树。`page` 输入只控制布局。回调使同一导航栏能同时用于文件页与文档预览，不必让各行知道这两种宿主的打开策略。

- 预览回调使用 `tab.actions.openResource(address, { replaceTab: true })`。新内容占据预览在停靠 tab 条上的位置或其浮窗，保留 pane id、矩形与叠放顺序。浮动替换不展开停靠区；聚焦按普通规则将浮窗提到最上层。
- 文件页回调在停靠时传入 `{ paneId: panel.id }`，浮动时省略落位。文件页保持打开，新内容落在该停靠分栏或活动停靠分栏。停靠区为空时展开已有根分栏，不执行分栏。目标使用自己的目录树偏好。
- 已有内容被揭示，不关闭发起的 tab。`replaceTab` 控制新内容落位，不负责揭示后的清理。页只在目标分栏内去重。揭示后必须消失的引导页在打开之后显式调用 `close()`；这两个动作可能产生两条历史。

### 导航由目标 tab 消费

files face 仅跟随已关联到其导航栏的 tab 的现有导航可观察值。它独立于绘制保留各 tab 已消费的 revision，并在 tab 关闭或插件卸载时释放订阅。它不需要右侧 Sidebar 提供布局清单、导航来源字段或打开结果。

更新的导航 revision 只在目标预览的目录树遮盖内容行时关闭它。face 等待目标绘制并测量其当前行宽，不使用上一个 tab 的宽度。任何导航来源都遵循同一规则，包括浮动预览打开自己的文件。隐藏的目录树也消费 revision，因此之后手动显示不会重放先前的关闭操作。普通 tab 切换、浮出或停靠后的重新挂载，以及刷新或 undo 后的 revision `0` 都不算新导航。文件页不受 revision 影响，始终可见。

### 每个包都可以单独工作

各包通过右侧 Sidebar 的 tab 信息、files Factory 和 tab 类型注册表组合。预览仅导入 files Factory 的声明；files 不依赖预览。没有已注册查看器时，文件页仍列出工作区，并禁用无法打开的文件行。没有 files 插件时，未注册的 Factory 位置不绘制内容，预览保留自己的头部、正文和文件交接 slot。

## 考虑过的替代方案

**静态目录树包或 `ui-primitives` 中的组件。** [包形态规则](../../../../docs/defensive-patterns/package-surface.zh.md)排除新增静态库。primitive 还要求各调用方传入通用目录树文案。Factory 使文案与注册留在 files，代价是绘制各行必须加载该插件。

**由目录树读取目录，或要求完整路径列表。** 工作区逐个展开的目录列出。因此目录树接收不完整条目，以及各目录的加载、失败与截断状态。在每次绘制中拥有读取会拆散必须跨 tab 切换保留的状态和监听生命周期。

**分栏生命周期信号。** 浮出和停靠可能替换分栏，但保留 tab。分栏信号会过早结束目录树状态，还会诱使调用方把 tab 资源绑到错误的生命周期；转移信号则让它比用作状态键的 pane id 活得更久。tab 已有的信号提供了所需的释放条件。

**始终挂载的分栏级覆盖层。** 它需要在停靠与浮动 tab 宿主之上增加一层，并修改布局、焦点、测量与拖放目标，避免拦截包括浮窗缩放手柄在内的输入。在 tab 内绘制则让这些职责留在原有所有者处。

**保留已访问正文或复制逐 tab 的目录树。** 保留所有正文仍会为同一分栏的不同 tab 创建独立目录树与监听，并保留各预览的已渲染内容。复制状态无法转移监听，还需要在 tab 跨分栏移动时决定冲突如何处理。

**让监听与分栏同寿，或检查布局后释放。** 主停靠分栏很少消失，因此按其生命周期持有的监听在隐藏后仍存在。检查布局中的 tab 类型会让 files 与每个导航栏消费方耦合，仍不能表达目录树是否正在绘制。

**由组件 effect 消费的聚焦请求位。** 保存在发起分栏的请求可能在揭示别处后留存，影响之后的绘制；隐藏的消费方也没有可聚焦元素。face 则把焦点与实际绘制绑定。

**把被拖动 tab 的目录树偏好带到新分栏。** 这需要另一套转移策略，并与目标分栏已经拥有的状态冲突。新分栏使用与其他新分栏相同的默认值。

## 后果

tab 重新挂载不拥有也不重置分栏目录树。移动 tab 时选择目标状态，不复制源状态；隐藏释放目录监听，但不删除展开与滚动状态。导航消费按 tab 保存，显示偏好仍按分栏保存，因此在另一分栏打开内容不会关闭源目录树。

文件页保留目录重新读取与目录操作控件；预览保留文件控件与交接操作。预览的选择器原位替换新内容，文件页则打开普通停靠 tab。工作区选择器只提供一个打开动作；其他消费方保留通用目录树 Factory 的新 tab 选项。

## 验证

- `packages/client/ui-sidebar-right/tests/tab-info.client.spec.tsx`、`service.client.spec.ts` 与 `seat.client.spec.tsx` 覆盖实时分栏信息、原位替换、揭示与框架 tab hook。
- `packages/client/ui-sidebar-files/tests/` 覆盖逐分栏状态、导航消费、绘制生命周期、工作区根目录与文件打开回调。
- `packages/client/ui-sidebar-files/tests/file-tree.client.spec.tsx`、`file-tree-interactions.client.spec.tsx` 与 `file-tree-factory.client.spec.tsx` 覆盖通用行、可选菜单、局部附件，以及带 locale 和 fallback 的真实 Factory 组合。
- `apps/web/tests/file-browser.e2e.ts` 与 `apps/web/tests/file-browser-composition.e2e.ts` 负责浏览器验证；后者在随包发布的 Web 组合中分别禁用 `ui-sidebar-documentpreview` 与 `ui-sidebar-files`。
