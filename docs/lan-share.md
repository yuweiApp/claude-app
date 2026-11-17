# 局域网会话分享

> 状态：第一版已完成（2026-11-16）。Linux 本机实测过对话、文件、终端、内置浏览器；Windows、macOS 还没实测。

把一个会话分享给同一局域网里的人。对方用自己的浏览器打开分享链接，进的是**同一个会话**，可以接着对话，会话里能做的和本机一样；右侧面板有文件、终端、内置浏览器。

## 1. 范围

| 项 | 访客看到的 |
| --- | --- |
| 对话 | 被分享的这一个会话，和本机实时同步：发消息、中断、排队、权限确认、切模型和推理强度、权限模式、目标、压缩、清空、附件、注释、后台任务 |
| 输入框上面 | 什么都不放（没有技能、插件、浏览器、Computer Use）；输入框里的 `@`、`/` 照常能用 |
| 右侧面板 | 文件、终端、内置浏览器（分享方桌面版里这个会话的标签页） |
| 没有的 | 侧栏、其他会话、设置页、删除和重命名会话、分叉 |
| 工具 | 会话照常挂所有工具（Computer Use、外部浏览器、终端……），分享不改会话本身 |

## 2. 总体结构

原来的网关监听（`127.0.0.1:8788`）、Vite（`localhost:5180`）、`API_TOKEN` 鉴权钩子、事件流都没改。局域网的访问另走一个入口，只在有分享时才监听。

```
访客的浏览器 ──http://<本机局域网 IP>:8789──▶ 网关的局域网入口（share/lan-server.ts，有分享时才监听 0.0.0.0:8789）
                                              │ 校验分享令牌、只放行这个会话用到的接口
                                              ├─ /api/*  ──转发──▶ 网关 127.0.0.1:8788（原样）
                                              └─ 其他    ──转发──▶ Vite localhost:5180（页面、HMR）
本机的桌面版、网页：照旧直连 5180 / 8788，不经过这个入口
```

- **为什么另开入口**：Vite 改成监听局域网的话，局域网请求经它的代理到网关时都是 127.0.0.1，网关分不清本机和访客；没分享时 5180 也对局域网开着。另开入口时，进来的请求一律是访客，原来的逻辑一行不用动。
- **页面**：开发时转发给 Vite（`SHARE_CLIENT_URL`，默认 `http://localhost:5180`），和本机是同一份代码，改了代码访客那边也热更新。转发时 `Host`、`Origin` 换成 Vite 自己的（Vite 8 只认本机的 Host）。以后打包桌面版时，入口改成直接发 `client/dist`。
- 没带令牌打开 `/`、`/index.html` 时返回一句提示（否则会加载成本机的界面，接口全是 401）；Vite 的 HMR 也连 `/`（WebSocket），放过去。

## 3. 分享的管理（网关）

- **存储**（`share/store.ts`）：`$CLAUDE_CONFIG_DIR/gateway-shares.json`（600），每条 `{ sessionId, token, createdAt }`，一个会话最多一条，令牌是 24 字节随机数的 base64url。网关重启后照旧有效，启动时有分享就开始监听入口。
- **接口**（`http/routes/shares.ts`，给本机用，局域网入口不放行）：
  - `GET /shares`：所有分享，加上入口端口和本机的 IPv4 地址（`os.networkInterfaces()`，去掉回环和 169.254.x.x）
  - `POST /sessions/:id/share`：开分享，已有就用原来的。入口没能监听（端口被占用）时撤掉这次新开的、报 500
  - `DELETE /sessions/:id/share`：停止分享
- **入口的开关**（`LanServer.sync()`）：有分享时监听 `0.0.0.0:<SHARE_PORT>`（默认 8789），最后一条停掉时关闭；停掉的分享的连接（事件流、终端、浏览器）立刻断开。
- **会话删除时**删掉它的分享；**会话清空后**（Claude Code 换了新的会话 id）分享跟到新 id，令牌不变（`routes/sessions.ts` 的 delete、clear 里各一行）。

## 4. 局域网入口（`share/lan-server.ts`）

独立的 `http.Server`，自己转发 HTTP 和 WebSocket 升级请求。

- **令牌**：页面地址 `/share/<令牌>`；之后的请求带 `X-Share-Token` 请求头，EventSource、WebSocket、`<img>` 用 `?share=<令牌>`。对不上 → 401。转给网关时令牌放在 `X-Share-Token` 里（`/share/info`、`/share/browser` 据此认出是哪个分享），网关设了 `API_TOKEN` 时补上 `Authorization`。
- **放行的接口**（`allowed()`，`/api` 后面的路径；`:id` 必须是这个分享的会话），其余 403：

| 用途 | 接口 |
| --- | --- |
| 分享本身 | `GET /share/info`（会话 id、工作目录、标题、是不是普通会话）、`/share/browser`（WebSocket，第 6 节） |
| 会话 | `GET /sessions/:id`，`/sessions/:id/` 下除了 `fork`、`share` 的所有接口（不能 PATCH 重命名、DELETE 删除） |
| 输入框要的 | `GET /config`、`/models`、`/capabilities`、`/external/tabs`（消息里 `@Chrome` 之类的名字和图标）、`/health`，`POST /uploads` |
| 右侧面板 | `/files*`、`/terminals*` |

  网页预览（`/files/page/…`）网关本身就不要求令牌，入口也直接放行。
- **转发**：事件流不缓冲；上游断了访客这边也断开（同 `client/vite.config.ts` 的处理），访客关掉页面时取消上游的请求。

## 5. 访客的网页

- **入口**（`client/src/main.tsx`）：地址是 `/share/<令牌>` 时设上分享令牌（`api.ts` 的 `setShareToken`），渲染 `ShareApp`；否则照旧渲染 `App`。
- **http 打开时缺的接口**（`client/src/insecure-context.ts`，入口最先加载）：访客用 `http://<局域网 IP>` 打开，不是安全来源，浏览器不给 `crypto.randomUUID`（界面到处用它生成 id，没有时页面一加载就出错、一片空白）和 `navigator.clipboard`。没有时补上：前者用 `crypto.getRandomValues` 拼，后者只能写文字（`execCommand("copy")`），复制图片不行。本机是 localhost，本来就有，走不到这里。只用 127.0.0.1 测发现不了，要用局域网 IP 打开测。
- **请求**（`api.ts`）：有分享令牌时请求都带上（`authHeaders()`、`withToken()`、事件流）。本机不设，和原来完全一样。
- **`ShareApp`**：每 5 秒问一次 `/share/info`。会话清空换了 id 就换到新会话；401 或连续 3 次连不上（最后一个分享停掉时入口不再监听，约 15 秒）显示「分享已结束」。对话是本机同一个 `Chat`，传 `guest`：输入框上面不放按钮、没有分叉。没有侧栏、设置。
- **右侧面板**：同一个 `SidePanel`。文件的上传下载走 HTTP（访客不是桌面版，本来就走这条）；终端按会话列、按会话建（接口本来就支持）；回复里的文件链接、网址照本机打开在面板里。

## 6. 内置浏览器

本机面板里的网页是外壳的原生视图；访客那边没有外壳，改成外壳推画面、访客的操作发回来。

```
访客：RemoteBrowserTab（<img>）── RemoteBrowser（WebSocket /api/share/browser）──▶ 局域网入口 ──▶ 网关 ShareBrowserRelay
   ──原有的 /browser/host WebSocket（share 开头的消息）──▶ 外壳 GatewayBridge ──▶ ShareStream（desktop/src/browser/share-stream.ts）──▶ BrowserViews
```

- **访客页面**（`client/src/state/remoteBrowser.ts`）：`RemoteBrowser` 实现和桌面版一样的 `DesktopBrowserApi`，`ShareApp` 经 `RemoteBrowserContext` 交给面板。`SidePanel` 在没有桌面版、有它时用它，标签页逻辑（补标签页、切换、新标签页的地址栏）照用；标签页内容换成 `RemoteBrowserTab`。本机的界面没有这个 context，走原来的 `BrowserTab`。
- **网关**（`share/browser-relay.ts`）：按访客记着看哪个会话、看哪些标签页的画面；同一个会话、同一个标签页几个人看，外壳那边只推一份。对标签页的操作只认这个会话的标签页（外壳推来的列表里有的）。外壳断开、重连时告诉访客，重连后重新要列表和画面。`BrowserHost` 多了 `onShare` / `postShare`，外壳发来的 share 开头的消息交给它。
- **外壳**（`share-stream.ts`）：
  - 列表：有访客看的会话，标签页一变就推（50ms 合并）；AI 切标签页（`activate`）也推。
  - 画面：有访客看的标签页接连 `capturePage`（约每秒 10 帧），宽于 1600 像素的缩小，JPEG 质量 70，和上一帧一样不发，发给网关的积压超过 2MB 时跳过这一帧。不在主窗口显示的标签页用 `stayHidden` 截，截图期间照常渲染（同 `views.ts` 的 `whileRendering`），本机没在看的标签页也有画面。
  - 输入：经标签页的调试接口注入（`Input.dispatchMouseEvent`、`Input.dispatchKeyEvent`、`Input.insertText`，同 AI 的 Playwright），网页不在前台、窗口没有焦点也收得到。网页收到的输入算「用户」的（`input-event`），告诉模型时和本机用户一样。
  - 鼠标指针形状（`cursor-changed`）推给访客。
  - 新建、关闭、跳转、前进后退、地址栏建议用 `BrowserViews` 原有的方法。
- **`RemoteBrowserTab`**：画面按比例缩放居中，鼠标坐标按比例换回网页的 CSS 像素；左键、中键、移动（每 33ms 最多一次）、滚轮转发，右键不转发（菜单会弹在分享方的屏幕上）。键盘接在一个看不见的输入框里：按键阻止默认、整个发过去（可打印字符带 `text`）；输入法组字结束（`compositionend`）、粘贴、没经过按键的输入（手机软键盘）整段用 `insertText` 送。
- **画面尺寸**：访客在前面看着的标签页，把画面区域的大小（CSS 像素，大小变了停 200ms 再报）发给外壳（`shareResize`）。本机没在显示这个标签页时（停放着），网页按访客的大小排版，画面铺满（`views.ts` 的 `fitParked`，停放窗口比它小就放大；截图循环里每轮再对一次，本机在面板里看过、又收回停放窗口后改回访客的）；本机正显示着时按本机面板的大小，访客那边按比例缩放、留边。几个访客看同一个标签页按最后报的；访客不看了网页保持最后的大小，本机在面板里打开时变回本机的。
- **前提**：分享方的桌面版开着；没开时访客的浏览器标签页显示「分享方的桌面版没有打开」。
- **没做的**：网页弹的选择文件对话框、alert（弹在分享方屏幕上）、剪贴板从网页复制到访客这边、选择元素和网页标注、下载列表（下载照旧存进会话的工作目录，访客在文件树里能看到、能下载）。

## 7. 本机的界面

- 侧栏会话的「…」/ 右键菜单（`Sidebar.tsx`）在「重命名」「删除」之间：没分享时「分享到局域网」（开分享、复制第一个地址的链接），分享中是每个地址一条「复制分享链接」和「停止分享」。
- 分享中的会话标题后面有个分享图标。分享列表（`state/shares.ts`）和会话列表一起每 10 秒刷新。
- 复制、出错的提示浮在窗口底部，几秒后消失；复制不了（没有剪贴板权限）时直接显示链接。
- 链接：`http://<地址>:<SHARE_PORT>/share/<令牌>`。地址列出本机所有 IPv4 网卡（包括 Docker 的网桥、公网地址），选局域网里对方连得到的那个。

## 8. 对现有逻辑的影响

没有开分享时，网关不多监听任何端口，代码路径和原来一样。改到原有代码的地方：

1. 删除会话时一起删掉它的分享；清空会话时分享跟到新 id（`routes/sessions.ts`）。
2. 访客开的标签页、终端，本机面板里也会出现（属于同一个会话）；访客在内置浏览器里的操作告诉模型时记成「用户」。
3. 侧栏菜单多了分享的项，分享中的会话多一个图标；主页刷新会话列表时多取一次 `/shares`。
4. 有访客看内置浏览器时外壳多做截图，多占些 CPU；没人看时不做。外壳和网关之间多了 share 开头的几种消息，旧版本的一边收到会忽略。
   访客看着本机没在显示的标签页时，网页按访客面板的大小排版（AI 在这个标签页上截图、操作也是这个大小，原来停放着的是 1280×800），停放窗口可能被放大。
5. 第一次开分享时，Windows 会问是否允许 Node.js 访问网络，要点允许；macOS 可能也会提示。
6. 分享存在文件里，网关重启后仍然有效。
7. `Chat` 导出了，多一个 `guest` 属性；`SidePanel` 多读一个 context；`BrowserTab.tsx` 导出了 `loadErrorText`、`displayUrl`；`api.ts` 的请求头统一由 `authHeaders()` 生成（本机没有分享令牌时内容和原来一样）；`views.ts` 多了只读的 `isShown()` 和 `fitParked()`；`BrowserHost` 多了 `onShare` / `postShare`。

## 9. 要实测的

- Windows、macOS：分享入口的防火墙提示；macOS 隐藏的停放窗口里的标签页截图有没有画面。
- 另一台设备打开链接（Linux 本机只用本机的局域网 IP 测过）。
- 手机浏览器打开：软键盘输入、触屏（现在只转发鼠标事件）。
