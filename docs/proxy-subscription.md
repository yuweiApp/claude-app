# 网络代理：订阅

> 进度：第 1 步（核实）、第 2 步（网关：`gateway/scripts/fetch-core.mjs`、`gateway/src/net/core.ts`、`net/proxy.ts` 的订阅模式、`/proxy/nodes` 等接口）、第 3 步（设置页：`client/src/components/ProxyPage.tsx`）都已实现，桌面版不用改。第 4 步在 Linux 上用本机的测试订阅实测过（第 10 节）；还没做的：用真实订阅在桌面版里跑内置浏览器和远程会话、Windows 和 macOS 真机（第 5 步）、安装包里带内核。

设置页「网络代理」加一种模式「订阅」：用户只填订阅链接，软件自己连上订阅里的节点，模型请求、网关自己的请求、Claude Code 跑的命令、终端、内置浏览器都经它出去。现有的代理功能见 [proxy.md](proxy.md)。

## 1. 为什么要内置一个代理内核

订阅给的是一份节点列表，节点用的是 VLESS（Reality、Vision）、VMess、Trojan、Shadowsocks、Hysteria2 这类协议。Claude Code、curl、git、Node 的 fetch、Chromium 都只认 HTTP 或 SOCKS5 代理，这些协议自己实现不现实。

做法和服务器上 sub2api 的出口代理一样（`/opt/sub2api` 的 `egress-proxy`：一个 sing-box 容器，入口是 `mixed 1080`，出口是 VLESS Reality 连洛杉矶节点，sub2api 填 `socks5h://egress-proxy:1080`）：

**网关在本机拉起一个代理内核当客户端，把订阅里的节点变成 `127.0.0.1` 上的一个 HTTP/SOCKS5 代理端口，「网络代理」的实际地址指向这个端口。** 后面的事现有代码都已经会做：子进程的 `HTTPS_PROXY`、网关的 dispatcher、内置浏览器（带认证的本机 HTTP 代理，同 SOCKS5 认证时经转接的路子）、改设置后换子进程。

## 2. 用哪个内核：mihomo

| | mihomo（Clash Meta） | sing-box |
| --- | --- | --- |
| 订阅 | `proxy-providers` 直接填订阅地址，自己下载、定时更新、解析 Clash YAML 和 v2ray 的 base64 链接 | 没有订阅功能，要网关自己下载、转换成 outbounds、写配置、重启 |
| 选节点、测延迟 | 自带控制接口（REST）：列节点、切换 `select` 组、测单个节点或整组延迟、手动更新订阅 | 有 Clash 兼容的控制接口，但节点来源要自己管 |
| 订阅的流量、到期时间 | 订阅返回 `subscription-userinfo` 头时，控制接口的 provider 信息里带着 | 自己解析 |
| 协议 | VLESS Reality / Vision、VMess、Trojan、SS、Hysteria2、TUIC 等 | 同样齐全 |
| 许可证 | GPL-3.0 | GPL-3.0（另有名称使用的限制） |

选 mihomo：订阅的下载、更新、解析、健康检查、选节点都是现成的，网关只管写一份配置、拉起进程、调控制接口。Clash Verge Rev 等客户端用的也是它，用户的订阅基本都兼容。

**订阅返回什么格式**：Remnawave 按请求的 User-Agent 返回不同格式。provider 请求头里带 `User-Agent: clash.meta`，它返回 mihomo 能直接用的完整 YAML（provider 只取其中的 `proxies`）；别的 User-Agent 拿到的是 base64 链接（mihomo 也能解析）。实测见第 9 节。

## 3. 内核从哪来

现在桌面版还没有安装包（`npm start` 直接跑源码），所以分两步：

**现在（开发、自己用）**：`gateway/scripts/fetch-core.mjs`，`npm --prefix gateway run fetch-core`：

- 按当前平台和架构下载 mihomo 的发布包（GitHub Releases），版本和每个平台文件的 sha256 写死在脚本里，校验不过不用。
- 解压到 `gateway/vendor/mihomo/<平台>-<架构>/mihomo(.exe)`，这个目录不提交（加进 `.gitignore`）。
- 下载本身要能连上 GitHub：脚本认 `HTTPS_PROXY`。连不上时也可以自己下载放到这个位置，或者用 `MIHOMO_PATH` 指到已有的 mihomo。

**以后（安装包）**：打包时把对应平台的 mihomo 放进安装包的资源目录，桌面版拉起网关时用 `MIHOMO_PATH` 告诉它位置。不在运行时下载：要用订阅的人，往往正是连不上 GitHub 的人。

**网关怎么找**：`MIHOMO_PATH` > `gateway/vendor/mihomo/<平台>-<架构>/` > `PATH` 里的 `mihomo`。都没有时，设置页显示「没有找到代理内核」和上面的获取方法，「订阅」模式保存不了（`PUT /proxy` 返回 400）。网关在跑的时候下载好了不用重启：设置页下一次查状态时网关发现内核有了就拉起。

## 4. 网关

新文件 `gateway/src/net/core.ts`：找可执行文件、写配置、拉起、重启、关闭，以及调内核的控制接口（节点、选节点、测延迟、更新订阅）。都在这一个文件里，没有另外拆 `subscription.ts`。

### 4.1 设置和存储

`gateway-proxy.json` 加两项（文件已经是 600）：

```ts
mode: "system" | "off" | "manual" | "subscription"
subscriptionUrl?: string     // 订阅地址，当密码对待：不回给网页、不进日志、不给模型
subscriptionInterval?: number // 自动更新间隔（小时），1 到 168，默认 12
```

- 订阅地址只收 `http://`、`https://` 开头的网址。换到别的模式时地址留着，切回来不用重填；传空字符串是清掉（订阅模式下清掉保存不了）。
- **选的节点不存在这里**，由内核自己记（`profile.store-selected`，在工作目录的 `cache.db` 里），内核重启、网关重启后都还在。原方案里的 `selected` 没有做：两边各记一份还要对齐，内核那份已经够用。

### 4.2 内核的配置

工作目录 `claude-home/proxy-core/`（权限 700，里面的文件 600：配置里有订阅地址，provider 缓存里有节点的密钥）。网关每次启动内核前重写 `config.yaml`：

```yaml
mixed-port: <随机端口>           # 网关启动时选好，之后不变
bind-address: 127.0.0.1
allow-lan: false
authentication: ["claude-app:<令牌>"]   # 本机别的进程不能拿它当跳板，同 SOCKS5 转接
external-controller: 127.0.0.1:<随机端口>
secret: <随机密钥>
mode: rule
log-level: warning
ipv6: true
profile:
  store-selected: true

proxy-providers:
  sub:
    type: http
    url: <订阅地址>
    path: ./providers/sub-<订阅地址的 sha256 前 16 位>.yaml
    proxy: DIRECT                  # 拉订阅一律直连，见下
    interval: <subscriptionInterval × 3600>
    header:
      User-Agent: ["clash.meta"]
    health-check:
      enable: true
      url: https://www.gstatic.com/generate_204
      interval: 300

proxy-groups:
  - name: 自动
    type: url-test
    proxies: [REJECT]   # 没有节点时只剩 REJECT；不写会用 COMPATIBLE，等于直连
    use: [sub]
    url: https://www.gstatic.com/generate_204
    interval: 300
    tolerance: 50
  - name: 节点
    type: select
    proxies: [自动]
    use: [sub]

rules:
  - MATCH,节点
```

- 规则只有一条：全部走代理。哪些地址不走代理由「不走代理的地址」管（本机地址、用户填的），和其他模式一样，在 `NO_PROXY` 和浏览器的绕过规则里处理，内核不用管。
- 不开 DNS 模块、不开 TUN：只是一个本机代理端口，不接管整台电脑的流量，不用管理员权限。没有 GEOIP 之类的规则，内核不会去下载地理数据库（实测工作目录里只有配置、`cache.db`、订阅缓存）。
- **拉订阅一律直连（`proxy: DIRECT`）**：不写的话，拉订阅也按规则走，也就是经当前选的节点。节点过期、挂掉时订阅就更新不了，拿不到新节点，卡死。第一次没有节点时它是直连拉的，写成 `DIRECT` 行为一致、可预期。代价是订阅服务器本身被墙时拉不到（这种情况下第一次也拉不到，没有区别）。
- **工作目录必须是 700**：内核自己建的文件是 664、目录是 755（`providers/` 下的订阅缓存里有节点的密钥），不受网关的 umask 管，只能靠上一层目录挡住。
- **订阅缓存的文件名跟着订阅地址走**：内核启动时缓存文件还没到更新间隔就直接用、不重新拉。文件名固定的话，换了订阅地址用的还是上一个订阅的节点（实测）。所以文件名里带订阅地址的哈希，写配置时把 `providers/` 下别的文件删掉。
- **订阅地址清掉了，整个工作目录删掉**（缓存里有节点的密钥，配置里有订阅地址）。只是换到别的模式时留着。
- 启动前先 `mihomo -t -d <目录> -f config.yaml` 检查配置，不通过就不拉起，把它的报错显示在设置页。
- 字段名、默认值以写死的 mihomo 版本的文档为准，实现时核对一遍。

### 4.3 进程管理

- **什么时候跑**：模式是「订阅」并且填了地址时拉起；切到别的模式、清掉地址、网关退出时关掉。
- **端口**：`mixed-port` 和控制接口的端口在网关启动时选好、整个网关进程内不变。这样内核重启、换订阅都不改子进程的 `HTTPS_PROXY`，不用换掉正在跑的 Claude Code 进程，只有在「订阅」和别的模式之间切换时才换。
- **拉起**：`mihomo -d <工作目录> -f config.yaml`，`windowsHide`，环境变量里去掉继承来的代理变量。拉起后轮询控制接口 `GET /version`，通了以后再等订阅拉完（有节点了，或者拉过一次没有节点）才算启动好，一共最多等 15 秒；这期间状态是 `starting`。启动好了但没有节点时状态是 `running`，带一句「订阅里没有取到节点」的提示，之后取到了自动清掉。
- **挂了**：记下退出码和最后 50 行输出，按 1、2、4…最长 60 秒的间隔重启；设置页显示状态和原因。
- **关掉**：先正常结束，3 秒没退再强制结束（Windows 用 `taskkill /T /F`，同桌面版关网关的做法）。网关收到 SIGINT、SIGTERM 时一起关（`index.ts` 的 `shutdown`）。
- **订阅地址、更新间隔变了**：重写配置，重启内核；端口不变。

### 4.4 接到现有的代理上

`net/proxy.ts` 的 `effectiveOf` 加一个分支：

```ts
if (mode === "subscription") return { url: proxyCore.proxyUrl, display: "订阅", noProxy: [...FIXED_NO_PROXY_ENV, ...stored.noProxy], replaceEnv: true };
```

- `proxyCore.proxyUrl` 是 `http://claude-app:<令牌>@127.0.0.1:<mixed-port>`。`display`（`GET /proxy` 的 `effective`、测试结果的 `via`）只是「订阅」两个字，现在用的节点由设置页从节点接口拿到后拼上去（「经 订阅（美国 1）」）。
- **内核没起来时不退回直连**：请求照样指向这个端口，连不上就报错（设置页、模型报错里都看得出是代理内核没在跑）。选了订阅的用户，直连多半也连不上，还可能让本来要走代理的请求直接出去。
- 内置浏览器：`browserProxyConfig()` 推 `http://127.0.0.1:<mixed-port>` 加用户名、令牌，桌面版按带认证的 HTTP 代理处理（`login` 事件回答），和 SOCKS5 认证时经转接一样，桌面版不用改。同样要求桌面版和网关在同一台电脑上。
- 远程会话：远端 Claude Code 的模型请求经 SSH 回到本机网关，由 `model-proxy.ts` 发出去，走全局 dispatcher，也就是这个内核。不用改。
- 测试连接：照现在的逻辑经 `proxyCore.proxyUrl` 请求模型接口。只能测正在跑的内核：订阅地址改了还没保存时提示先保存；内核没在跑时直接报「代理内核没有运行」或它最后的错误；内核断开连接（选的节点连不上、没有节点）时报「代理内核断开了连接：现在选的节点连不上目标，或者订阅里没有能用的节点」。

### 4.5 接口

| 接口 | 作用 |
| --- | --- |
| `GET /proxy` | 现有的视图加 `subscription`：`hasUrl`（地址本身不返回）、`intervalHours`、`core`（内核状态 `missing` / `stopped` / `starting` / `running` / `error`，带版本号和原因） |
| `PUT /proxy` | `mode: "subscription"` 时可以带 `subscriptionUrl`（不传是不改，空字符串是清掉）、`subscriptionInterval`。没有内核、没填地址时 400 |
| `GET /proxy/nodes` | `ProxyNodes`：`selected`（选的节点，`null` 是「自动」；控制接口 `GET /proxies/节点` 的 `now`）、`nodes`（名字、协议类型、`alive`、最近一次延迟；`GET /providers/proxies/sub` 的 `proxies[].alive`、`history`）、`subscription`（上次更新时间 `updatedAt`，订阅返回了 `subscription-userinfo` 时还有已用的上行、下行、总流量、到期时间，总流量和到期时间 `null` 是不限；订阅取不到、用的是缓存时没有流量这几项） |
| `PUT /proxy/node` | `{ name }`：节点名，或 `null`（自动）。调控制接口 `PUT /proxies/节点`，再 `DELETE /connections` 断开已有的连接（见下），返回新的 `ProxyNodes`。节点不存在 400 |
| `POST /proxy/nodes/delay` | 整组测延迟（控制接口 `GET /group/自动/delay?url=&timeout=5000`），返回新的 `ProxyNodes` 加 `delays`（节点名 → 毫秒，不通的是 `null`）。单个节点测延迟没有做（要做的话用 `GET /providers/proxies/sub/<节点>/healthcheck`：订阅里的节点不在全局的 `/proxies` 里，`/proxies/<节点>/delay` 是 404） |
| `POST /proxy/subscription/update` | 立即更新订阅（控制接口 `PUT /providers/proxies/sub`），返回新的 `ProxyNodes`；订阅取不到时返回内核的报错 |

节点这四个接口在内核没在跑时返回 503 和原因；内核控制接口的错误原样带上状态码。类型 `ProxyCoreStatus`、`ProxyNodes` 在 `gateway/src/shared/types.ts`。

**切节点要断开已有的连接**：内核换了选的节点以后，已经建立的连接（keep-alive 的、正在传的）还走原来的节点，实测切到一个不通的节点后请求照样成功。所以选节点后调一次 `DELETE /connections`，之后的请求才都走新选的；代价是正在进行的请求（比如正在输出的模型回复）会断，Claude Code 自己会重试。

控制接口的密钥只在网关里，网页、桌面版都不直接连内核。

## 5. 设置页

`client/src/components/ProxyPage.tsx`。「模式」下拉加「订阅」。选了以后「代理」这张卡片里显示：

- **订阅地址**：输入框，同密码框的做法（内容不显示）：已经填过时显示「已填写，输入新的可以替换」，旁边「清除」。说明里写：订阅地址就是凭证，拿到的人都能用你的节点。点了「清除」以后要么填新的地址，要么换一种模式再保存（订阅模式下没有地址保存不了）。
- **自动更新**：间隔下拉（6、12、24 小时；存的是别的值时也列出来）。
- **代理内核**：一行状态。「运行中（mihomo v1.x.x）」「启动中…」「出错了，正在自动重试：…」「没有找到代理内核…」（附获取方法）；还没保存成订阅模式时是「保存后启动」。
- 「不走代理的地址」「测试连接」「保存」同手动模式。

保存成订阅模式以后，下面多一节「订阅」（这一节的操作都马上生效，不经「保存」）：

- **订阅信息**：节点数、已用流量 / 总流量、到期时间、上次更新时间，「立即更新」按钮。
- **节点**：单选列表，第一项「自动（选延迟最低的）」，后面每个节点一行（名字、协议、延迟；不通的显示「超时」，没测过的显示「没测过」），右上角「测延迟」。

页面开着时轮询 `GET /proxy` 和 `GET /proxy/nodes`：内核没跑起来时 2 秒一次，跑起来以后 10 秒一次。「当前」一行显示「经 订阅（节点名或「自动选节点」）」。

桌面版不用改：网关把订阅模式当成「带认证的本机 HTTP 代理」推给外壳（`browserProxyConfig()` 返回 `mode: "manual"`、`http://127.0.0.1:<mixed-port>`、用户名和令牌）。

## 6. 安全

- 订阅地址、节点的密钥只在网关这台电脑上：设置文件和内核工作目录都只有当前用户能读；`GET /proxy` 只返回 `hasUrl`；不进对话日志、不进模型能看到的任何内容（不写进 `agentEnv()`，子进程只看得到本机的代理地址和令牌）。
- 内核的两个端口都只监听 127.0.0.1；代理端口要认证；控制接口有密钥。
- 不开 TUN、不改系统代理设置、不要管理员权限。

## 7. 要先定的事

- **许可证**：mihomo 是 GPL-3.0。作为独立进程、单独的可执行文件随软件分发，一般要附上它的许可证和源码获取方式（发布地址和版本号）。软件要商业分发的话，先确认一下。
- **合规和分发**：软件里带代理客户端，可能影响应用商店审核，在部分地区分发有风险。要看打算怎么发布。
- **杀毒误报**：Windows 上代理内核偶尔会被误报，安装包最好签名。
- **macOS**：下载来的可执行文件会被打上隔离标记，开发时要 `xattr -d com.apple.quarantine`，安装包里的随签名处理。
- **范围**：第一版只支持一个订阅。不做多个订阅、自定义规则、分流（国内直连）、TUN。分流以后要做的话，在 `rules` 里加，界面另说。
- **安装包**：桌面版打包时带上对应平台的 mihomo，并用 `MIHOMO_PATH` 告诉网关（第 3 节「以后」），等有安装包时一起做。

## 8. 分步实施

1. **核实**（已做，第 9 节）：下载 mihomo（写死版本），拿真实订阅手工跑一份上面的配置，确认能取到节点、能连、控制接口的字段（节点列表、延迟、provider 的流量和到期信息）和写法。把实测结果补到这份文档里。
2. **网关**（已做）：`fetch-core` 脚本；`core.ts`（找可执行文件、写配置、拉起、重启、关闭、控制接口）；`net/proxy.ts` 加「订阅」模式；接口。用 tsx 单独测：起内核、经它请求、切节点、更新订阅、杀掉内核看重启和报错。
3. **设置页**（已做）：订阅地址、状态、节点列表、测延迟、更新。
4. **整体实测**（做了一部分，第 10 节）：启动桌面版，「订阅」模式下跑一次真实对话（模型请求、内置浏览器）、终端里 curl、远程会话；切节点后马上生效；网关重启后内核跟着起来、选的节点还在。
5. **Windows、macOS**（没做）：真机各测一遍，包括可执行文件的权限、隔离标记、杀毒软件、退出时内核有没有留下。
6. **文档**（已做）：更新 [proxy.md](proxy.md)、`docs/README.md` 第 15 节。

工作量估计：第 1 步半天，第 2 步两三天，第 3 步一天，第 4、5 步看问题多少，一到两天。

## 9. 实测（第 1 步）

环境：洛杉矶这台 Linux（38.244.38.37，也就是订阅里那个节点所在的机器），mihomo v1.19.33（2026-10-21 发布，`mihomo-linux-amd64-v1-v1.19.33.gz`，sha256 和 GitHub 发布页给的一致），用你的真实订阅、按第 4.2 节的配置跑。

**订阅**

| User-Agent | 返回 |
| --- | --- |
| `clash.meta`、`mihomo/1.19.33` | 完整的 mihomo YAML（`text/yaml`），1 个节点「美国 1」：`vless`，带 `flow`、`reality-opts`、`client-fingerprint` 等，自带三个代理组和规则（provider 只用 `proxies`） |
| `sing-box 1.14`、`curl/8` | base64 链接列表，1 条 `vless://` |

响应头都带 `Subscription-Userinfo: upload=0; download=1516120165; total=0; expire=0`（`total`、`expire` 为 0 是不限）、`Profile-Update-Interval: 12`、`Profile-Title`（base64 的「余威的vpn加速器」）。

**代理端口**

- 不带认证：HTTP 的 CONNECT 被拒，SOCKS5 握手失败。
- 带认证：HTTP（CONNECT）、SOCKS5h、普通 `http://` 请求都通，`generate_204` 约 35 ms。
- 出口 IP 是 38.244.38.37（和直连一样，因为测试机就是节点本身）；控制接口把日志调到 info 后看到 `127.0.0.1:… --> www.gstatic.com:443 match Match using 节点[美国 1]`，确认经节点出去。
- 内核没在跑时经代理的请求是连接被拒（curl 7），不会直连出去。

**控制接口**（`external-controller` + `secret`）

- 不带密钥 401。
- 启动后约 30 ms `GET /version` 就通（`{"meta":true,"version":"v1.19.33"}`）；订阅在启动时自己拉下来了。
- `GET /proxies/节点`：`{"type":"Selector","now":"自动","all":["自动","美国 1"]}`。
- `GET /providers/proxies/sub`：`vehicleType: HTTP`、`updatedAt`、`subscriptionInfo: {Upload, Download, Total, Expire}`、`proxies[]`（`name`、`type: Vless`、`alive`、`history: [{time, delay}]`）。启动时的健康检查已经填好了延迟（58 ms）。
- `GET /group/自动/delay?url=…&timeout=5000` → `{"美国 1":64}`。
- `GET /providers/proxies/sub/美国 1/healthcheck?url=…&timeout=5000` → `{"delay":41}`；`GET /proxies/美国 1/delay` 是 404（订阅里的节点不在全局列表里，全局只有内置的和自己写的组）。
- `PUT /proxies/节点 {"name":"美国 1"}` → 204；不存在的节点 → 400 `Selector update error: proxy not exist`。
- `PUT /providers/proxies/sub` → 204，`updatedAt` 更新（手动更新订阅）。
- `PATCH /configs {"log-level":"info"}` 能临时调日志级别（排查时用）。
- 选的节点（`store-selected`，存在 `cache.db`）内核重启后还在。

**出错时**

| 情况 | 表现 |
| --- | --- |
| 订阅连不上，有上次的缓存 | 内核照常跑，用缓存里的节点，代理能用；日志 `[Provider] sub pull error: …`；`subscriptionInfo` 变成空的 |
| 订阅连不上，没有缓存 | 内核照常跑，0 个节点。**更正**：「自动」组只剩内置的 `COMPATIBLE`，它等于直连，请求会直接出去（第 2 步用 info 日志确认：`using 节点[COMPATIBLE]`；第 1 步看出口 IP 判断错了，测试机就是节点，直连和经节点的 IP 一样）。修法：「自动」组加 `proxies: [REJECT]`，没有节点时请求被拒（日志 `using 节点[REJECT]`），有节点时 REJECT 测不出延迟、不会被选上（实测「自动」选的是「美国 1」） |
| 配置写坏 | 进程立刻退出，退出码 1，`Parse config error: …`；`mihomo -t` 也能提前查出来（退出码 1） |
| 不写 `proxy: DIRECT` | 拉订阅按规则走当前节点（日志 `dial 节点 (match Match/)`）；写了以后是 `mihomo --> 38.244.38.37:8443 using DIRECT` |

**对方案的改动**（已改进上面各节）：provider 加 `proxy: DIRECT`；工作目录必须 700；启动前 `mihomo -t`；单个节点测延迟用 provider 的 `healthcheck` 接口；节点数 0 要单独提示。

**还没测**：Windows、macOS 上的 mihomo；节点真的连不通时（这台就是节点，测不出来）的延迟和报错；订阅里有多个节点时「自动」的切换。

## 10. 实测（第 2 到 4 步）

环境：同一台 Linux，mihomo v1.19.33。订阅用本机的测试服务（不是真实订阅）：一个返回 Clash YAML 的 HTTP 服务（带 `subscription-userinfo` 头，可以切成返回 500、空订阅、两个节点的订阅），三个 Shadowsocks 节点，其中两个连到本机另一个 mihomo 开的 SS 入口（能用），一个指向没人监听的端口（不通）。

**网关单独测**（tsx 脚本，`CLAUDE_CONFIG_DIR` 指到临时目录，不起网关）

- 保存：没填地址、地址不是 http(s)、没有内核（`MIHOMO_PATH` 指到不存在的文件）时保存不了；保存后返回的视图里没有订阅地址，内核状态马上是 `starting`，约 0.4 秒后 `running`。
- 出口：子进程的 `HTTPS_PROXY` 是 `http://claude-app:<令牌>@127.0.0.1:<端口>`，`NO_PROXY` 带本机地址；给内置浏览器的是 `mode: manual`、`http://127.0.0.1:<端口>` 加用户名、令牌；网关自己的 fetch 经内核请求外网 204。
- 节点：三个节点、默认「自动」；流量、到期时间、更新时间都拿到；测延迟两个有数、不通的是 `null`；选不通的节点后请求失败（没有直连出去），选回能用的马上恢复；选不存在的节点 400。
- 更新订阅：更新时间变了；订阅服务返回 500 时「立即更新」报错，节点还在（用缓存），代理照常能用。
- 内核被杀（SIGKILL）：状态 `error`，这时请求是连接被拒（不直连）；1 秒后自动重启，端口不变（子进程的代理变量不变），选的节点还在，进程只有一个。
- 换订阅：内核重启、端口不变。换成空订阅：0 个节点，有「没有取到节点」的提示，请求被拒，测试连接失败；再换成两个节点的订阅：两个节点，提示清掉。
- 切到「不使用」：内核进程没了，订阅地址和工作目录留着；切回订阅不用重填。清掉订阅地址：工作目录删掉。
- 权限：工作目录 700，`config.yaml` 600，`gateway-proxy.json` 600。
- 网关关闭（`stopProxy()`）后没有内核进程留下。

**查出来并改了的问题**

| 问题 | 改法 |
| --- | --- |
| 换了订阅地址，内核用的还是上一个订阅的节点（缓存文件没到更新间隔，内核不重新拉） | 缓存文件名带订阅地址的哈希，别的缓存删掉（第 4.2 节） |
| 切节点后已有的连接还走原来的节点 | 选节点后 `DELETE /connections`（第 4.5 节） |
| 启动超时后重启时，被网关关掉的旧进程的退出又排了一次重启，把刚拉起的进程关掉 | 网关自己关的进程，退出时不当成「挂了」 |
| 保存后返回的内核状态是 `stopped`（关旧进程、检查配置是异步的） | 保存时马上置成 `starting` |
| 没有内核时订阅模式也能保存（保存后所有请求都失败） | 保存时检查，返回 400 和获取方法 |
| 网关在跑的时候下载好内核，要再保存一次设置才拉起 | 查状态时发现内核有了就拉起 |

**设置页和整条链路**（开发用的网关 `tsx watch` 加 Vite，在浏览器里点）

- 选「订阅」、填地址、保存：状态从「启动中…」变成「运行中（mihomo v1.19.33）」，「订阅」一节显示「3 个节点 · 已用 1.41 GB / 100 GB · 2026-12-14 到期 · 上次更新 …」和节点列表（两个有延迟，一个「超时」）。
- 选节点马上生效，「当前」一行跟着变；「测延迟」「立即更新」「测试连接」都正常；选不通的节点时测试连接显示「代理内核断开了连接…」。
- 点「清除」后在订阅模式下保存被拦住（要填新地址）；换成「跟随系统」保存后内核停掉、地址清掉。
- 订阅模式下跑了一次真实对话：模型请求正常；模型在 Bash 里看到的 `HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY` 是内核的地址，`curl https://www.gstatic.com/generate_204` 返回 204。
- 网关重启（改代码触发 `tsx watch` 重启）：旧内核进程没有留下，新内核跟着起来，选的节点还在。
- 对话日志里搜不到订阅地址。

**还没测**：真实订阅走一遍设置页（第 1 步用真实订阅测的是内核本身）；桌面版里的内置浏览器、远程会话；Windows、macOS；节点延迟很高或时通时断时「自动」的切换；`fetch-core` 脚本在 Windows、macOS 上的下载和解压。
