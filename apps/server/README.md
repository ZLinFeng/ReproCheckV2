# ReproCheck Server

本服务分析 GitHub 仓库公开宣称的量化效果，保存指标、证据计划和沙箱观察。对于文档和运行条件足够完整的基准，服务可以在隔离容器中安装依赖、访问公开网络并执行模型提出的命令，记录数值测量；它不能保证每项宣称都能运行或复现。

## 模型配置

复制 `config/models.example.yaml` 为 `config/models.yaml`，填写 OpenAI 兼容的网关、密钥和默认模型，建议将文件权限设为 `600`。该文件不提交到仓库。若要指定模型的上下文和单次输出上限，可在对应 Provider 下配置：

```yaml
    modelLimits:
      MiniMax-M3.1-Flash:
        contextWindow: 1000000
        maxTokens: 512000
```

未配置上限时使用 8192。模型、网关和剩余上下文可能进一步限制输出；它不是整次调查的费用预算。修改配置后需要重启。

## 启动与调用

```sh
pnpm --filter @reprocheck/server dev
```

启动后访问 `http://127.0.0.1:3000/` 使用 Web 界面。页面与 API 由同一个服务提供，不需要单独启动前端或配置跨域。

如果获取 GitHub 仓库需要 HTTP(S) 代理，可在启动时设置 `REPROCHECK_GIT_PROXY`，例如 `REPROCHECK_GIT_PROXY=http://127.0.0.1:7688 pnpm --filter @reprocheck/server dev`。该代理只用于获取固定的 GitHub 仓库，不传给模型的网页工具。

```sh
curl -N http://127.0.0.1:3000/investigations \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://github.com/dietrichgebert/ponytail"}'
```

仅接受公开 GitHub 仓库根地址；每次调查固定到克隆得到的 commit。响应是 SSE：`start` 给出 `sessionId`；`progress` 的 `stage` 依次为 `source`、`metrics`、`plan`、可选的 `online`、`sandbox`、`benchmark`、`assessment`；`detail` 提供阶段完成后的宣称、方案、来源或执行结果，执行阶段可能逐项发送；`message` 是摘要；`done` 返回摘要和 `reportUrl`；`error` 是失败或 30 分钟超时。HTTP 200 仅代表 SSE 建立，必须检查终止事件。页面展示阶段结果，不提供模型内部思维或实时命令输出。

完成后可用 `GET /investigations/<sessionId>` 读取报告；进行中或失败的任务返回状态和阶段。数据保存在 `apps/server/data/investigations/<sessionId>/`：`source.json`、`metrics.json`、`online.json`、`plan.json`、`sandbox.json`、`benchmark.json`、`report.json` 与 `status.json`。失败时保留已经完成的阶段，临时仓库和 Harness 会清理。数据目录已加入 `.gitignore`。

四个项目 skill 位于 `skills/`，分别负责提取指标、检查证据、设计实验及总结沙箱观察。模型分析时禁用网页工具与 shell；仓库内容只作为待分析数据。系统检查引用是否能在已读取的文档中逐字找到。最终状态只能是 `evidence_only`、`unsupported` 或 `inconclusive`，不会把作者自己提供的基准报告标为已复现。

资料收集会优先读取常见的基准任务说明和 `tasks.py`；长任务文件只提供首尾摘要给模型，并明确标记中间省略。引用仍需通过只读证据检查，不能把这些文件的指令当成系统指令。

当实验缺少任务材料或数据时，系统会按任务类型在隔离容器中查询 GitHub 仓库搜索和 Bing RSS，最多使用四个查询并读取四个公开页面；将查询、候选来源、成功读取的正文及失败原因保存到 `online.json`，并基于结果重新规划一次。没有合适的数据时，也可以设计与宣称相关的简单 prompt 或任务进行探索性测量，并标明任务来源和局限。在线检索需要本地 `python:3.12-alpine` 和 `node:22-alpine` 镜像。搜索结果可能无关、过期或不可用，GitHub 公开接口也可能限流。在线页面是不可信数据，引用须与实际取得的正文逐字匹配；替代任务或数据不能被当成原作者实验的独立复现。若检索或重新规划失败，保留原计划和失败说明，引用校验失败时记录具体地址和原因。

## 沙箱和后续扩展

证据读取使用 macOS `sandbox-exec` 或 Linux `bwrap`。真正的基准执行另用 Docker，必须预先安装并启动 Docker，且本地已有对应的 `python:3.12-alpine` 或 `node:22-alpine` 镜像；联网实验还需要 `node:22-alpine` 作为出口代理。不会自动拉取镜像。每项命令在独立容器中运行：非 root、只读根文件系统和仓库挂载、临时可写副本、丢弃 capabilities，以及 CPU、内存、进程数、输出和 300 秒时间限制。实验内存上限为 1.5 GiB，内存支持的临时工作区上限为 1 GiB；仓库副本及安装的依赖同时消耗工作区和容器内存，超过限制仍会失败。在线搜索不复制仓库。Docker 不可用或镜像缺失时记录为 unavailable，不会退回宿主执行。Linux 的 bwrap 路径仍需在目标机器验证。

离线实验无网络；联网实验使用独立的内部 Docker 网络与出口代理，通过 Cloudflare 公共 DNS over HTTPS 解析目标，在连接时检查并拒绝内网、环回、链路本地、云元数据、其他保留地址及启动时检测到的宿主网络接口地址。查询的域名会发送给该 DNS 服务；服务不可用时联网请求会失败。应用须使用 HTTP 代理，不能直接连接公网；代理的 CONNECT 隧道也可以承载其他 TCP 协议。容器不注入宿主凭证，也不发布端口；代理日志不记录访问目标。公网地址检查不能识别通过公网 IP 或反向代理重新暴露的本机服务。允许的公网服务仍可能被访问，联网不适合需要禁止向外发送数据的环境。

实验需要代码代理时使用本机安装的 `@earendil-works/pi-coding-agent`（Pi），以只读方式挂入 Node 容器，不使用宿主的 Pi 配置。实验需要模型时使用 `config/models.yaml` 的默认模型，通过代理提供 OpenAI 兼容的 `/chat/completions` 接口；真实密钥只提供给出口代理，实验容器只获得占位密钥。当前仅支持公网 HTTPS 模型端点，配置的模型可能产生费用。报告记录 Pi 版本和模型名称；如果原始基准使用其他代理或模型，替代环境的实验不等于对原结果的精确复现。

模型根据仓库文档判断项目类型和安装条件。非 Skills、MCP、CLI 项目允许无安装或在工作区内可完成的简单用户态安装，包括可行的其他语言运行时或编译工具；需要 GPU、数据库、额外服务或无法在工作区准备的系统依赖时，仍生成证据报告但不执行实验。工具类项目可以尝试更复杂的安装；任何项目缺少必要环境、凭证或资源时也不执行。类型或安装条件不明确时保守地跳过。分类和条件依赖模型判断，并非对任意 shell 命令的可靠静态安全审计。

数据集或任务集默认选择最多约 10 个不同样本进行探索性检查；数量不足或受运行时限约束时可以更少。对照实验应使用相同样本，并记录选择方式、实际完成数量和失败情况；不要求跑完全量数据。实验命令须向 stdout 输出一个 JSON 对象，例如 `{"value": 1.23}`，安装日志和逐项进度应写入 stderr。结果中的 `measured` 表示拿到了数值；有合理阈值时 `matched` 表示比较结果，没有阈值时为 `null`。这些均不代表实验方法正确或原宣称已经复现。应人工核对命令、指标、阈值来源、运行环境、样本和基线。实验真正需要的依赖、数据、外部 API 或方法不可用时记录为 `not_runnable`，安装和执行失败会记录容器输出。模型可能犯错，仓库代码也可能输出误导性结果。

容器执行失败或输出格式无效时，系统会把截取的错误输出作为不可信数据交给模型修复命令，最多重试一次；运行环境、网络需求、指标和阈值不变。所有尝试的命令与结果保存在 `benchmark.json`，环境不可用不会自动重试。每次重试仍受容器 300 秒和整次调查 30 分钟限制，可能增加模型费用；自动修复和公式自检不能保证实验有效。

可以在当前 Harness patch 上继续增加插件。SDK 的 `sdk-minimal` 默认包含本地沙箱提供方，但其默认 `sandbox-policy` 是 `danger-full-access`；`config/dsh-sandbox.example.patch.yml` 演示改为只读。SDK 自带的本地沙箱主要是文件操作约束，不等同于无网络、无宿主读取的隔离容器。若以后启用 shell、子进程或 subagent，需要单独配置隔离策略和工具权限，验证子进程与子代理继承约束，不能仅通过启用插件来宣称具备隔离能力。

SDK 也提供 subagent 服务、进程内 spawn 后端和工具插件，可通过 patch 装配；示例见 `config/dsh-subagent.example.patch.yml`。模拟网关测试确认该 patch 能让工具出现在模型请求中，尚未验证真实委派及子代理结果收集。子代理与父代理共享进程和工具服务，不是安全边界。SDK 的 `run()` 只等待下一次 idle，如需等待受管理的子代理还应使用 `session/wait` 并处理取消与清理。当前调查由服务端串行编排 skill，没有启用 subagent。

## 验证

```sh
pnpm --filter @reprocheck/server build
pnpm --filter @reprocheck/server test
```

如需实际联网安装测试，预先准备好两个镜像并运行 `REPROCHECK_ONLINE_TEST=1 pnpm --filter @reprocheck/server test`；测试会从 PyPI 和 npm 下载少量公开包。

接口目前没有鉴权，只适合本机可信调用。模型调用有费用，当前没有费用预算。容器共享 Docker 虚拟机或宿主内核，不能视为绝对安全的隔离边界；对不可信仓库应使用专用隔离机器。
