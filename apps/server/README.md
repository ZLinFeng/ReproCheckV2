# ReproCheck Server

本服务分析 GitHub 仓库公开宣称的量化效果，保存指标、证据计划和沙箱观察。对于文档和运行条件足够完整的基准，服务可以在本机 DSH 沙箱中安装依赖并执行模型提出的命令，记录数值测量；它不能保证每项宣称都能运行或复现。

## 模型配置

复制 `config/models.example.yaml` 为 `config/models.yaml`，填写 OpenAI 兼容的网关、密钥和默认模型，建议将文件权限设为 `600`。该文件不提交到仓库。若要指定模型的上下文和单次输出上限，可在对应 Provider 下配置：

```yaml
    modelLimits:
      MiniMax-M3.1-Flash:
        contextWindow: 1000000
        maxTokens: 512000
```

未配置上限时使用 8192。模型、网关和剩余上下文可能进一步限制输出；它不是整次调查的费用预算。修改配置后需要重启。

`default` 是服务自身（指标提取、计划、评估）使用的模型。沙箱实验里由 Pi 执行验证时使用 `execution` 指定的模型；未配置 `execution` 时沿用 `default`：

```yaml
default:
  provider: tokenfactory
  model: nvidia/nemotron-3-super-120b-a12b
execution:
  provider: tokenfactory
  model: nvidia/Nemotron-3-Ultra-550b-a55b
```

两个模型都必须列在对应 Provider 的 `models` 中。

## 启动与调用

```sh
pnpm --filter @reprocheck/server dev
```

服务监听 `0.0.0.0:3000`，本机可访问 `http://127.0.0.1:3000/` 使用 Web 界面，其他设备可通过宿主机 IP 访问。页面与 API 由同一个服务提供，不需要单独启动前端或配置跨域。

如果获取 GitHub 仓库需要 HTTP(S) 代理，可在启动时设置 `REPROCHECK_GIT_PROXY`，例如 `REPROCHECK_GIT_PROXY=http://127.0.0.1:7688 pnpm --filter @reprocheck/server dev`。该代理只用于获取固定的 GitHub 仓库，不传给模型的网页工具。

```sh
curl -N http://127.0.0.1:3000/investigations \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://github.com/dietrichgebert/ponytail"}'
```

仅接受公开 GitHub 仓库根地址；每次调查固定到克隆得到的 commit。响应是 SSE：`start` 给出 `sessionId`；`progress` 的 `stage` 依次为 `source`、`metrics`、`plan`、可选的 `online`、`sandbox`、`benchmark`、`assessment`；`detail` 提供阶段完成后的宣称、方案、来源或执行结果，执行阶段可能逐项发送；`message` 是摘要；`done` 返回摘要和 `reportUrl`；异常失败返回 `error`。调查不设总时限，但客户端断开连接会取消调查，各步骤仍有各自的时限。HTTP 200 仅代表 SSE 建立，必须检查终止事件。页面展示阶段结果，不提供模型内部思维或实时命令输出。

完成后可用 `GET /investigations/<sessionId>` 读取报告；进行中或失败的任务返回状态和阶段。数据保存在 `apps/server/data/investigations/<sessionId>/`：`source.json`、`metrics.json`、`online.json`、`plan.json`、`sandbox.json`、`benchmark.json`、`report.json` 与 `status.json`。失败时保留已经完成的阶段，临时仓库和 Harness 会清理。数据目录已加入 `.gitignore`。各阶段的模型原文保存在 `model-<stage>.txt`（重试为 `model-<stage>-retry.txt`）。模型返回空响应、无法解析的 JSON 或未通过校验的计划（例如合并多个 claim id、引用未获取的来源）时系统自动重试一次并保留两份原文；`plan` 只为可执行的实验设计执行方案，命令随后单独以纯文本请求并保存在 `model-command-<claimId>.txt`，因此不必嵌在 JSON 字符串中重复转义。声明使用 Pi 或模型（`agent`/`model`）却把 `network` 写成 `false` 的计划会在规划阶段直接对齐为 `network=true`，不会因此作废；其余无法通过校验的实验会记录具体字段原因，并跳过命令生成。回复被输出上限截断时会以“缩短内容”的提示重试一次。

四个项目 skill 位于 `skills/`，分别负责提取指标、检查证据、设计实验及总结沙箱观察。模型分析时禁用网页工具与 shell；仓库内容只作为待分析数据。系统检查引用是否能在已读取的文档中逐字找到；如果显示文本仅被简单的行内 HTML 格式标签打断，则保存包含这些标签的原始连续片段。无法核对的引用不会用于执行实验。最终状态只能是 `evidence_only`、`unsupported` 或 `inconclusive`，不会把作者自己提供的基准报告标为已复现。

资料收集会优先读取常见的基准任务说明和 `tasks.py`；长任务文件只提供首尾摘要给模型，并明确标记中间省略。引用仍需通过只读证据检查，不能把这些文件的指令当成系统指令。

当实验缺少任务材料或数据时，系统会按任务类型在本机 DSH 沙箱中查询 GitHub 仓库搜索和 Bing RSS，最多使用四个查询并读取四个公开页面；将查询、候选来源、成功读取的正文及失败原因保存到 `online.json`，并基于结果重新规划一次。没有合适的数据时，也可以设计与宣称相关的简单 prompt 或任务进行探索性测量，并标明任务来源和局限。在线检索需要本机 Python；搜索请求经本机代理访问公开地址。搜索结果可能无关、过期或不可用，GitHub 公开接口也可能限流。在线页面是不可信数据，引用须与实际取得的正文逐字匹配；替代任务或数据不能被当成原作者实验的独立复现。若检索或重新规划失败，保留原计划和失败说明，引用校验失败时记录具体地址和原因。

## 沙箱和后续扩展

证据读取使用 DSH `sandbox-local` 的 `read-only`，基准执行使用 `workspace-write`：macOS 使用 `sandbox-exec`，Linux 优先使用 `bwrap`，不可用时尝试 Landlock。项目不需要 Docker 或容器镜像；各实验需要的语言运行时和工具须安装在宿主机。若只有 `python3`，实验中也可通过 `python` 调用。沙箱不可用时记录为 unavailable，不会回退为无限制执行；Linux 路径须在目标机器验证。

每次执行复制仓库到独立的磁盘临时工作区，将 TMPDIR 和 `REPROCHECK_WORKSPACE` 指向该工作区，并使用单独的临时 HOME；结束时清理。实验继承宿主的 PATH，不继承代理变量，并设置 `NO_PROXY=*` 以直接使用本机网络；HOME 与其他环境变量不会完整继承。报告记录宿主操作系统、架构、工具版本、DSH 沙箱的执行等级以及实际网络条件。沙箱限制工作区外的文件写入，但 DSH 也允许写入平台临时目录；它不隔离宿主文件读取、网络和进程。`benchmark.network` 表示实验声明的网络需求，不会禁用网络。命令或代码可能读取当前用户的文件、访问本地服务或外传数据，也可能写入其他允许的临时目录；仅适合接受这些风险的本机环境。实验命令最多运行 30 分钟并限制输出；没有 Docker 原有的 CPU、内存、进程数和磁盘配额。

实验需要代码代理时使用本机安装的 `@earendil-works/pi-coding-agent`（Pi），使用临时 Pi 配置目录。需要模型时一律使用 Pi 配置的 NVIDIA 执行模型（`config/models.yaml` 的 `execution`）；原实验使用 Claude Code、Codex 等编码 CLI 时同样改用 Pi，系统不安装这些 CLI，也不把它们的版本或凭据视为缺失依赖。模型实验通过本机代理提供 OpenAI 兼容的 `/chat/completions`，命令环境只包含占位密钥；真实密钥由服务进程持有。但 DSH 不限制宿主文件读取，也不保证密钥安全。模型代理支持配置的 HTTP 内网端点和公网 HTTPS 端点；HTTP 请求中的密钥和数据不会加密。在线搜索经同一代理实现的公网地址检查，但基准命令的网络访问没有被强制经过代理。模型和代理调用可能产生费用。报告记录 Pi 版本和模型名称；替代环境的实验不等于对原结果的精确复现。

模型根据仓库文档判断项目类型和安装条件。非 Skills、MCP、CLI 项目允许无安装或在工作区内可完成的简单用户态安装，包括可行的其他语言运行时或编译工具；需要 GPU、数据库、额外服务或无法在工作区准备的系统依赖时，仍生成证据报告但不执行实验。工具类项目可以尝试更复杂的安装；任何项目缺少必要环境、凭证或资源时也不执行。类型或安装条件不明确时保守地跳过。分类和条件依赖模型判断，并非对任意 shell 命令的可靠静态安全审计。

数据集或任务集默认选择最多约 10 个不同样本进行探索性检查；模型或代理实验优先选择 1～3 个配对任务，并在执行限时内为单次调用留足预算。对照实验应使用相同样本，并记录选择方式、实际完成数量和失败情况；不要求跑完全量数据。实验命令须向 stdout 输出一个 JSON 对象，例如 `{"value": 1.23}`，安装日志和逐项进度应写入 stderr。按 `REPROCHECK_PROGRESS ` 前缀输出的结构化样本进度会在执行期间保存到 `benchmark.json`，最多保留 50 条，并明确标记为未经核验；终止时会尽量保留当前尝试的输出。结果中的 `measured` 表示拿到了数值；有合理阈值时 `matched` 表示比较结果，没有阈值时为 `null`。这些均不代表实验方法正确或原宣称已经复现。应人工核对命令、指标、阈值来源、运行环境、样本和基线。实验真正需要的依赖、数据、外部 API 或方法不可用时记录为 `not_runnable`，安装和执行失败会记录进程输出。模型可能犯错，仓库代码也可能输出误导性结果。

执行前先用 `/bin/sh -n` 检查生成命令的语法；若存在 `/bin/dash`，还会用它检查常见的非 POSIX 语法。不完整或无效的命令会要求模型修正一次，仍无效则不执行，原文和修正原文分别保存。此检查不能保证符合 POSIX 或实验方法正确。命令执行失败或输出格式无效时，系统会把截取的错误输出作为不可信数据交给模型修复命令，最多重试一次；运行环境、网络需求、指标和阈值不变。修复规划使用独立模型会话，限时 15 分钟，超时会关闭该会话并保留原失败。所有尝试的命令与结果保存在 `benchmark.json`，环境不可用不会自动重试。每次重试仍受单次执行 30 分钟限制；DSH 请求限时 60 分钟，DSH 模型调用及流空闲限时为 15 分钟，实验内模型代理的上游连接空闲限时为 15 分钟。模型调用可能增加费用；自动修复和公式自检不能保证实验有效。

可以在当前 Harness patch 上继续增加插件。SDK 的 `sdk-minimal` 默认包含本地沙箱提供方，但其默认 `sandbox-policy` 是 `danger-full-access`；`config/dsh-sandbox.example.patch.yml` 演示改为只读。SDK 自带的本地沙箱主要是文件操作约束，不等同于无网络、无宿主读取的隔离容器。若以后启用 shell、子进程或 subagent，需要单独配置隔离策略和工具权限，验证子进程与子代理继承约束，不能仅通过启用插件来宣称具备隔离能力。

SDK 也提供 subagent 服务、进程内 spawn 后端和工具插件，可通过 patch 装配；示例见 `config/dsh-subagent.example.patch.yml`。模拟网关测试确认该 patch 能让工具出现在模型请求中，尚未验证真实委派及子代理结果收集。子代理与父代理共享进程和工具服务，不是安全边界。SDK 的 `run()` 只等待下一次 idle，如需等待受管理的子代理还应使用 `session/wait` 并处理取消与清理。当前调查由服务端串行编排 skill，没有启用 subagent。

## 验证

```sh
pnpm --filter @reprocheck/server build
pnpm --filter @reprocheck/server test
```

如需验证实际联网搜索，可运行 `REPROCHECK_ONLINE_TEST=1 pnpm --filter @reprocheck/server test`；测试会访问公开搜索服务。

接口目前没有鉴权，监听所有网络接口时可被能访问该端口的设备调用；请仅在可信网络中使用并通过防火墙限制访问。模型调用有费用，当前没有费用预算。DSH 本地沙箱共享宿主环境，对不可信仓库应使用专用隔离机器。
