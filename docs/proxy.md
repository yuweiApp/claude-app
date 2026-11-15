# 网络代理

> 进度：第 1 到 4 步，以及 SOCKS5、终端面板都已实现：网关（`gateway/src/net/proxy.ts`、`gateway/src/net/socks-bridge.ts`、`gateway/src/http/routes/proxy.ts`）、设置页（`client/src/components/ProxyPage.tsx`）、桌面版内置浏览器和查系统代理（`desktop/src/browser/network-proxy.ts`）。Windows、macOS 真机还没测过。

设置页加「网络代理」，让软件发出去的请求都走用户设的代理：模型请求、网关自己发的请求、claude 子进程里的工具（Bash、MCP、git）、内置浏览器。

## 1. 现在有哪些出口

| 出口 | 位置 | 现在怎么连 | 能不能走代理 |
| --- | --- | --- | --- |
| 模型请求、WebFetch、Claude Code 内部的请求 | claude 子进程，环境变量来自 `agentEnv()`（`gateway/src/config.ts`） | 直连，继承网关进程的环境变量 | Claude Code 认 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`，**不支持 SOCKS** |
| Bash 工具、MCP 服务器、hooks | claude 子进程的子进程 | 继承上一行的环境变量 | `curl`、`git`、`npm`、`pip` 都认这些变量（`curl` 的 `http_proxy` 只认小写） |
| 插件市场（`claude plugin …`，git 克隆） | `plugin-market.ts`，`env: agentEnv()` | 同上 | 同上 |
| 网关自己的 `fetch` | `models.ts`（模型列表）、`title.ts`（生成标题）、`connectors.ts`（连接器目录）、`ssh/deploy.ts`（给远端下载 SDK、claude 二进制） | Node 内置 fetch（undici），不读代理变量 | 要设全局 dispatcher，或者启动时加 `NODE_USE_ENV_PROXY=1` |
| 网关自己的 `https.request` | `ssh/model-proxy.ts`（远端 claude 的模型请求经 SSH 回到本机，从这里发给模型接口） | 直连 | `https.Agent` 加 `proxyEnv` 选项 |
| 内置浏览器 | 桌面版，分区 `persist:claude-browser`（`desktop/src/browser/views.ts`） | Electron 默认跟随系统代理 | `session.setProxy()`，支持 HTTP、HTTPS、SOCKS5，改了马上生效 |
| 远程会话的内置浏览器 | 每台主机一个分区，代理指向外壳里的本地代理（`ssh-proxy.ts`） | 远端的 localhost 经 SSH 连过去；其他地址按 `defaultSession.resolveProxy` 的结果直连，或者经 HTTP、SOCKS5 代理连 | 已经会经代理连，但还不会做代理认证 |
| 终端面板 | `terminal-manager.ts`，`env: process.env` | 继承网关的环境变量 | 加环境变量就行（第 7 节） |

不在这次范围内：

- 外部浏览器（用户自己的 Chrome、Edge）：走那个浏览器自己的代理设置。
- 网页 → 网关：用户的浏览器连本机网关，跟代理无关。
- SSH 连接本身（ssh2 连远端的 22 端口）：要经代理的话需要 HTTP CONNECT 或 SOCKS 隧道，以后再做。
- 远端主机上的 Bash、浏览器、终端：用的是远端自己的网络。`ssh/spawn.ts` 只把 `PASS_ENV` 里的变量传过去，代理变量本来就传不过去，保持这样。远端 claude 的模型请求会回到本机，从 `model-proxy.ts` 发出去，所以会跟着本机的代理走。

本机已经实测过（Node v22.23.3，代理指向一个没人监听的本机端口，域名用 `.invalid`，不会真的发到外网）：

- 设 `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY` 后，`fetch` 和 `https.get` 都去连代理（报 `ECONNREFUSED`，不是 `ENOTFOUND`），同时打一条 `EnvHttpProxyAgent is experimental` 警告。
- `new https.Agent({ proxyEnv: { HTTPS_PROXY } })` 同样会去连代理。

## 2. 设置项

### 模式

| 模式 | 意思 |
| --- | --- |
| 跟随系统（默认） | 桌面版：用操作系统的代理设置（见第 5 节）。网页版、没有外壳连着时：沿用网关进程继承来的 `HTTPS_PROXY` 等变量，也就是现在的行为 |
| 不使用 | 一律直连。传给子进程的环境变量里删掉继承来的 `*_PROXY` / `*_proxy`；内置浏览器设成 `direct` |
| 手动 | 用下面填的地址 |

手动模式填：

- **代理地址**：`http://host:port`、`https://host:port` 或 `socks5://host:port`（SOCKS5 没写端口是 1080，`socks5h://` 当成 `socks5://`）。SOCKS5 怎么接见第 6 节。
- **用户名、密码**：可以不填。
- **不走代理的地址**：每行一个，域名（`*.corp.example.com`、`.example.com`）、IP、CIDR 都行。本机地址 `localhost`、`127.0.0.1`、`::1` 总是不走代理，写死不能删，页面上显示成灰色的固定项。原因是浏览器工具、桌面工具、Playwright MCP、本地开发服务都要连本机，送进代理就会断。

页面上还有：

- **测试连接**：网关按当前填的内容（还没保存的也能测），经代理请求 `ANTHROPIC_BASE_URL` 的 `/v1/models`；没配 `ANTHROPIC_BASE_URL` 时请求 `https://api.anthropic.com`。显示结果：连上了（状态码、耗时）、代理连不上、代理要认证（407）、代理连上了但目标不通。
- **当前生效的代理**：跟随系统时显示查到的系统代理（或者「直连」）。系统代理是 SOCKS、网关没法用时，在这里说明。
- 一句说明：「正在运行的会话在这一轮结束后切换」。

导航放在「个人」那一组，排在「外观」后面，标题「网络代理」。

### 存储和接口

- 存在 `claude-home/gateway-proxy.json`，文件权限 600，读写方式同 `gateway-browsers.json`（先写 `.tmp` 再 rename）。
- `GET /proxy`：返回模式、地址、用户名、`hasPassword`、不走代理的列表、当前生效的代理。**不返回密码明文**。
- `PUT /proxy`：保存。密码字段不传表示不改，传空字符串表示清掉。
- `POST /proxy/test`：按请求体里的设置测一次，不保存。
- 类型放 `gateway/src/shared/types.ts`（`ProxySettings`、`ProxySettingsView`、`ProxyTestResult`）。

## 3. 网关

新文件 `gateway/src/net/proxy.ts`，所有地方都从它取代理：

```ts
/** 当前生效的代理：null 表示直连 */
effectiveProxy(): { url: string; username?: string; password?: string; noProxy: string[] } | null
/** 给子进程的环境变量：HTTPS_PROXY、HTTP_PROXY、NO_PROXY 及小写形式；不使用时这几个键的值是 undefined（用来删掉继承来的） */
proxyEnv(): Record<string, string | undefined>
/** 设置改了：换全局 dispatcher，通知会话管理器和外壳 */
onProxyChange(listener)
```

带认证的代理拼成 `http://user:pass@host:port`（用户名、密码要做 URL 编码），子进程、undici 都认这种写法。

### 3.1 claude 子进程

- `agentEnv()` 最后合并 `proxyEnv()`。`NO_PROXY` = 写死的本机地址 + 用户填的列表，用逗号连起来。
- 大写、小写都设：Claude Code 和 Node 认大写，`curl` 的 `http_proxy` 只认小写。
- 远程会话不用改：`spawn.ts` 的 `PASS_ENV` 本来就把这些变量挡在外面。

**什么时候生效**：环境变量只在子进程启动时读。会话管理器记下每个本机会话的子进程启动时的代理变量（`proxyEnvKey()`），和现在的不一样的就是旧的：

- 设置改了：空闲的马上关掉子进程。下次发消息时会照常 resume，模型、推理强度、后台任务记录都会接上（现在空闲回收走的就是这条路）。
- 正在跑一轮的，或者有后台子代理（`agentsRunning`）、有待处理通知（`noticePending`）的，先留着。之后每分钟清理一次时再换；在那之前用户就发了下一条消息的话，`activate()` 里先关掉再 resume。
- 什么时候算「空闲、能关」，条件和空闲回收一样（`reclaimable()`）。

### 3.2 网关自己的请求

- **fetch**：依赖 `undici`（7.30.1，写死）。启动时（`index.ts` 的 `initProxy()`）和设置改了以后调用 `setGlobalDispatcher()`：有代理时用 `EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy })`，直连时用普通的 `Agent`；旧的 dispatcher 等进行中的请求结束再关。不用重启网关。
  - 实测过：Node v22.23 内置的 `fetch` 认 npm 版 undici（6.29、7.30、8.12 都试了）设的全局 dispatcher，切回直连也生效。
  - 不选 `NODE_USE_ENV_PROXY`：它只在进程启动时读一次，改了设置得重启网关；还会打 experimental 警告；而且桌面版检测到网关已经在跑就不再拉起，外壳也没法替它加这个变量。
- **model-proxy.ts**：从 `https.request` 改成 undici 的 `request`，走同一个全局 dispatcher。不用 `https.Agent` 的 `proxyEnv`：类型里标的是 v24.5 起才有，旧版本的 Node 会悄悄忽略、直连。
- **测试连接**用一个单独的 dispatcher，不影响正在用的那个。

### 3.3 日志

经代理失败时，报错里带上「经代理 host:port」，不带用户名、密码。对话日志、`GET /proxy` 都不出现密码。

## 4. 桌面版（内置浏览器）

代码在 `desktop/src/browser/network-proxy.ts`，`main.ts` 建一个 `NetworkProxy`，交给 `ssh-proxy.ts` 和 `bridge.ts`。

### 4.1 拿到设置

外壳和网关之间已经有一条 WebSocket（`bridge.ts`，`/browser/host`）。网关 → 外壳加一种消息 `{ type: "proxy", config }`（`gateway/src/net/proxy.ts` 的 `browserProxyConfig()`）：外壳连上时（`BrowserHost.attach`）发一次，每次保存（`onProxySaved`，不管变没变）再发。`config` 里带着密码：这条连接只在本机，网关设了 `API_TOKEN` 时还要带令牌。

外壳把收到的设置（不含密码）存在 userData 的 `browser-proxy.json`。启动时先按它设好分区的代理，再恢复上次的标签页，免得连上网关之前开的页面走错路。

### 4.2 应用到浏览器

对 `persist:claude-browser` 分区调用：

| 模式 | `setProxy` 参数 |
| --- | --- |
| 跟随系统 | `{ mode: "system" }` |
| 不使用 | `{ mode: "direct" }` |
| 手动 | `{ mode: "fixed_servers", proxyRules: "host:port"（https 代理写成 "https://host:port"）, proxyBypassRules }` |

- `proxyBypassRules`：用户填的不走代理的地址。域名同时写 `example.com` 和 `*.example.com`：Chromium 的 `example.com` 只管它自己，而网关、curl 的 `NO_PROXY` 包括子域名。本机地址 Chromium 本来就不走代理，不用写（也不能写 `<-loopback>`，那是去掉这个默认）。
- 设完调用 `closeAllConnections()`，已经建立的连接也换过来；再调用 `clearAuthCache()`，不然 Chromium 会一直用记住的旧密码。

**代理认证**：`app.on("login")` 里 `authInfo.isProxy`，并且 host、port 和手动设置的代理一样时，用设置里的用户名、密码回答。

- 不是第一次问（`details.firstAuthAttempt` 为 false）就取消：说明刚给的密码代理不认，再给同样的只会无限重试。页面显示代理认证失败。
- 外壳刚启动、网关还没推过设置时来的认证先等着（最多 15 秒），设置到了再回答。
- `ssh-proxy.ts` 自己也有一个 `login` 处理，只管指向它自己端口的情况，两个处理互不干扰。

### 4.3 远程会话的分区

这个分区的代理一直指向 `ssh-proxy.ts` 的本地端口，不改。改的是 `ssh-proxy.ts` 连「其他地址」的方式：

- 以前按 `defaultSession.resolveProxy(url)`，现在按 `NetworkProxy.routes(url)`：问本机会话的分区 `resolveProxy`。Chromium 按代理设置、不走代理的规则、PAC 算好路线，两边的规则完全一样，也不用另开一个分区。
- 路线是手动设置的代理时带上用户名、密码。`viaHttpProxy` 发 CONNECT 时带 `Proxy-Authorization`（Basic）；HTTPS 代理先和代理建 TLS。
- 设置变了（`NetworkProxy.onChange`）：清掉连接池里按旧设置建的连接，远程分区也 `closeAllConnections()`。不清的话，连接池会继续复用经旧代理的连接。

### 4.4 主窗口

主窗口加载的是本机网关的页面，`defaultSession` 不用设代理。favicon、`window.open` 交给系统浏览器的链接也不用管。

### 4.5 实测（独立的 Electron 进程、本地带认证的测试代理）

| 情况 | 结果 |
| --- | --- |
| 手动 + 认证 | 第一次 407，`login` 回答后经代理打开 |
| 不走代理的 `direct.test`、`a.direct.test`，以及 `localhost` | 直连，代理没收到请求 |
| 远程分区打开外网地址 | 经 ssh-proxy CONNECT 到代理，带着认证 |
| 改成错误密码 | 代理不认，取消，不再重试；改回正确密码马上能用 |
| 不使用 | 本机分区、远程分区都直连 |
| 启动时网关还没推密码 | 等到设置推过来再回答，页面正常打开 |

## 5. 跟随系统

Electron 会读系统代理（Windows 的 WinINet 设置、macOS 的网络设置、PAC 和自动检测都算），Node 和 Claude Code 不读。所以网关要用系统代理，得靠外壳去查了报过来。

**外壳**（`network-proxy.ts` 的 `startReporting`、`checkSystem`）：

- 网关推设置时带上 `probeUrl`，也就是模型接口的地址（`ANTHROPIC_BASE_URL`，没配是 `https://api.anthropic.com`）。
- 外壳用一个单独的、不落盘的分区（`claude-proxy-probe`，代理固定 `mode: "system"`，不受内置浏览器的设置影响）`resolveProxy(probeUrl)`，每次查之前 `forceReloadProxyConfig()`。
- 收到网关推的设置时查一次，连着网关时每 30 秒再查一次。结果变了才报：外壳 → 网关 `{ type: "systemProxy", route }`。
- 断开网关时停止。

不由网关临时去问：`agentEnv()` 是同步的，很多地方都在用；改成外壳主动报，网关手里随时有一个现成的结果。

**网关**（`net/proxy.ts` 的 `setSystemProxy`）：

- 只看路线的第一项：`PROXY host:port` 用 `http://host:port`，`HTTPS host:port` 用 `https://host:port`。
- `SOCKS5 host:port` 用 `socks5://host:port`，经第 6 节的转接。
- `DIRECT`、`SOCKS`（SOCKS4，网关和 Claude Code 用不了），以及外壳从没报过时，回到继承的环境变量，都没有就直连。
- 跟随系统并且系统代理能用时：网关自己的请求马上换；子进程的 `HTTPS_PROXY` 等换成它（盖过继承来的）。环境变量变了的子进程，按「设置改了」的规矩换掉。
- 外壳断开时清掉报来的结果，回到继承的环境变量：桌面版关着时系统代理变了（比如退出了代理软件）网关不知道，留着旧的会一直连一个已经关掉的代理。网关重启后、外壳报过来之前也用环境变量。实测时就遇到过：网关单独跑着，桌面版关了以后还在用它最后报的测试代理，只能重开一次桌面版让它报新的。
- 不是跟随系统的模式下也记着报来的结果，但什么都不换；切回跟随系统时用上。
- `GET /proxy` 的 `system` 字段是报来的结果（没报过是 null），设置页按它说明现在用的是什么。

**局限**：

- PAC 可能对不同网址给出不同的代理，网关只按模型接口的地址查，所有出口都用这一个结果。内置浏览器是按每个网址分别判断的，没有这个局限。
- 系统设置里「不走代理的地址」网关拿不到，网关只用本机地址和继承来的 `NO_PROXY`。
- 系统代理要认证的，网关不知道用户名、密码。

纯网页版（没有外壳）的「跟随系统」就是继承环境变量，页面上有说明。

**实测**：

- 网关（单独的配置目录）：报 `PROXY` 时，网关的 fetch 经它，子进程变量换成它，通知换掉子进程；报重复的不通知；报 `SOCKS5`、`DIRECT` 时回到环境变量；报 `HTTPS` 时用 `https://`；「不使用」时报来的不生效。
- 外壳（独立的 Electron 进程）：本机 XFCE、系统没设代理时报 `DIRECT`；用环境变量给 Chromium 一个系统代理时报 `PROXY 10.9.8.7:3128`；结果一样的不重复报。
- 对正在跑的网关发 `systemProxy`，`GET /proxy` 的 `system` 跟着变。
- Windows、macOS 的系统代理设置（包括 PAC）还没在真机上测过。

## 6. SOCKS5

Claude Code、curl、git、Node 的 fetch 只认 HTTP 代理（`HTTPS_PROXY`），所以网关在本机开一个转接（`gateway/src/net/socks-bridge.ts`）：

- 一个 HTTP 代理，监听 `127.0.0.1` 的随机端口，网关启动时就开好（`initProxy()`），之后地址都能同步拿到（`agentEnv()` 是同步的）。
- 收到的 CONNECT 和普通 HTTP 请求（curl 对 `http://` 地址这样发）都经 SOCKS5 连出去，域名交给 SOCKS5 代理解析。支持用户名、密码认证（RFC 1929）。
- 要认证（Basic，用户名 `claude-app`，密码是令牌），本机别的进程不能拿它当跳板。每个令牌对应一个上游：正在用的设置用一个固定令牌，所以 SOCKS5 的地址、账号变了，转接的地址不变，子进程不用换；测试连接临时开一个令牌，测完删掉。
- 用的是 SOCKS5 时，子进程的 `HTTPS_PROXY` 等和网关自己的 dispatcher 都指向这个转接；设置页显示的还是 `socks5://…`。
- 测试连接先直接经 SOCKS5 连一下目标，连不上时报 SOCKS5 自己的原因（连不上代理、认证失败、代理连不上目标等）；经转接的话只看得到 502。
- 跟随系统时，操作系统的代理是 SOCKS5（Chromium 报 `SOCKS5 host:port`）也经这个转接。SOCKS4 还是用不了。

内置浏览器（`network-proxy.ts`）：

- 不认证的：Chromium 直接用 `socks5://host:port`。远程分区经 `ssh-proxy.ts` 的 `viaSocks5`。
- 要认证的：Chromium 的 SOCKS5 不支持用户名、密码，网关推给外壳的设置换成这个转接（HTTP 代理，用户名 `claude-app`，令牌当密码），之后同 HTTP 代理认证。这要求桌面版和网关在同一台电脑上（转接只监听 127.0.0.1），桌面版默认就是这样。

实测：

- 网关（单独的配置目录、本地测试用的 SOCKS5）：fetch、curl 的普通 http 和 CONNECT 都经 SOCKS5；不带令牌连转接是 407；测试连接能分出 SOCKS5 没开、要认证没填、密码不对；加上认证后转接地址不变；跟随系统时报 `SOCKS5` 也能用，报 `SOCKS` 显示用不了。
- Claude Code 经转接、再经一个真往外连的 SOCKS5 跑了一次真实的对话。
- 内置浏览器（独立的 Electron 进程）：SOCKS5 直连、不走代理的地址、远程分区，以及要认证时经转接，都对。

## 7. 终端面板

本机的终端（`terminal-manager.ts` 的 `localPty`）打开时也按 `applyProxyEnv()` 设好 `HTTPS_PROXY`、`NO_PROXY` 等，和 claude 子进程一样，不另设开关。环境变量只在终端打开时读，改了设置以后已经开着的终端不变，新开的才用新设置（设置页上有说明）。远程会话的终端在远端，用远端自己的网络。

## 8. 待定

- **默认模式**：默认用「跟随系统」，和现在的行为差别最小：内置浏览器现在就跟随系统，网关现在继承环境变量。
- **`.env.local` 里写了 `HTTPS_PROXY` 的情况**：手动、不使用模式下以设置页为准；跟随系统模式下没有外壳时用它。
- **证书**：公司代理做 HTTPS 解密时，需要信任它的根证书。Node 侧有 `NODE_EXTRA_CA_CERTS`，Claude Code 也认它；可以以后在同一页加「额外的 CA 证书」。

## 9. 分步实施

1. 网关：`net/proxy.ts`、设置存储和接口、`agentEnv()`、undici dispatcher、`model-proxy.ts` 的 Agent、会话按 `envStale` 回收。每一步都能单独用 `curl` 加一个本地代理（比如 mitmproxy、tinyproxy）验证。
2. 网页：设置页「网络代理」、测试连接。
3. 桌面版：bridge 消息、`setProxy`、代理认证、`ssh-proxy.ts` 改成按设置。
4. 跟随系统：外壳回答 `resolveProxy`。
5. 文档：`docs/README.md` 加一节，链到这里；`README.md` 的配置说明里提一句。

验证：

- 本机起一个带认证的 HTTP 代理，三种模式各跑一遍：对话（模型请求）、WebFetch、Bash 里的 `curl`、模型菜单、生成标题、内置浏览器打开外网和 `localhost`、远程会话的对话和远端 localhost 页面。
- 在代理的日志里确认请求确实经过了它，并且本机地址的请求没有经过。
- 改设置后：空闲会话下一条消息就走新代理；正在跑的会话这一轮结束后切换。
- Windows、macOS 各测一遍「跟随系统」，包括 PAC。
