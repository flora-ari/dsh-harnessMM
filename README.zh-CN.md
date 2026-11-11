# dsh-harnessMM

**DeepSeek Harness 的 HarnessMM 插件。** 在原生工具边界上复用已确定的决策：模型一次写出冻结的动作图，
每个候选带一条只读回执的守卫；守卫成立时，用一次带证书的原生替换代替慢思考回调。

论文：**HarnessMM: Recursive Self-Improvement for Harness Token Efficiency**
（[arXiv:2610.32813](https://arxiv.org/abs/2610.32813)），作者 Yuhua Jiang、Chang Xu、Feifei Gao、Li Zhao。
原始实现：[YuhuaJiang2002/HarnessMM](https://github.com/YuhuaJiang2002/HarnessMM)。
pi 的同源移植：[jlon/pi-harnessmm](https://github.com/jlon/pi-harnessmm)。

---

## 核心思想

一次慢速模型调用的代价很高，而它在第 n 步做的事，大部分是在重新推导第 n-1 步已经定下的决策。
HarnessMM 直接复用它：

1. **一次授权。** 慢速 actor 在发出唯一的根工具调用时，顺带写出一张可执行决策图（EDG）。每个节点是一个
   *完全字面* 的未来原生调用，外加一条 *只读回执* 的守卫。
2. **按回执判定。** 工具结果回来后，每个候选的守卫只对那份公开回执求值——`exit_code == 0`、
   `stdout_contains "PASS"` 之类。不做语义判断，不猜输出含义。
3. **替换回调。** 成立的候选直接走原生执行器执行，不再询问模型。只有一个候选成立时确定性命中；多个候选
   时交给单字符选择器。
4. **出具证书。** 每次替换都记录一张证书，绑定图哈希、候选、精确参数、精确原生回执，以及 *没有发生* 的
   那次推理回调。图耗尽后自然回到普通慢路径。

论文的第三部分——递归自我改进（RSI）——是离线数据与评分流程，运行时插件不实现，本插件也不声称实现。

## 挂载点

HarnessMM 只需要宿主提供一件事：能够用一个模型没写过的工具调用来应答一次推理请求。DSH 正好有这个缝隙。

| 钩子 | 作用 |
| --- | --- |
| `systemPrompt.section` | 注入 `CHISEL_PLAN` 编写方言，并绑定当前 profile 真正挂载的 shell 工具 |
| `llm/stream` | 把一次已结算的推理请求替换成一次带证书的原生工具调用 |
| `tools/execute` | 只有与授权节点字面完全相等的调用才被放行 |
| `tools/result` | 把真实结果解码为公开回执，并结算证书 |
| `tools.register` | 注册 `harnessmm_status`，会话可读自己的计数与最近一次判定 |

插件不替换原生执行器、评分器或计费：替换的动作走普通工具管道，界面卡片、会话日志与用量记账都由宿主自己完成。
控制器只重放模型已经冻结的动作，绝不扩大动作空间。

## 安装

```sh
dsh plugin --profile desktop  add /path/to/dsh-harnessMM
dsh plugin --profile web      add /path/to/dsh-harnessMM
dsh plugin --profile headless add /path/to/dsh-harnessMM
```

包内自带 bundle patch（`cordis.patch.yml`），因此 `dsh plugin add` 插入该行后控制器立即生效。
`@deepseek-ai/schemastery` 声明为 peer 依赖，与官方插件包一致；从 git 或 registry 安装时由 pnpm 默认的
`auto-install-peers` 提供。

**本地路径**安装是 link，pnpm 不会为被 link 的包解析 peer 依赖。请先在插件目录执行一次
`npm install`，让 `@deepseek-ai/schemastery` 能从那里解析；否则插件行会激活，但模块导入会以
`ERR_MODULE_NOT_FOUND` 失败。

手工管理时，把同一行写进 profile patch：

```yaml
- insert:
    - id: harnessmm
      name: 'dsh-harnessmm'
      config:
        policy:
          enabled: true
```

补丁层会 *整体替换* 一行的 `config`，不做深合并；只改一个开关也要把整块重述。

## 设置里的开关

除宿主半之外，包里还带一个**客户端半**（`dsh.client`、`exports["./client"]`）。profile 加载后，
设置里会多出一行 **HarnessMM**（就在「插件」之后），整行只有一个开关：

- 开启是绿色 **Y**，关闭是红色 **N**，字母画在轨道内部、与滑块相对的一侧；
- 开关通过 `ctx.configForms.get('harnessmm')` 写插件自己的设置命名空间里的 `policy.enabled`
  ——与内置插件配置页用的是同一个服务——因此按 profile 持久生效，宿主无需重装即可读到；
- 标签下方的提示会说明当前值的含义，或说明为什么改不了（配置不可用、只读 profile、宿主拒绝了写入）。

客户端半分只在 web/桌面 profile 生效（`"client": { "platform": "web" }`）；`headless` 与 `sdk`
没有设置界面，不会加载它，宿主半不受影响。

`dsh plugin add` 之后请重启一次应用，让 profile 提供新的客户端入口。

## 配置

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `policy.enabled` | `true` | 所有钩子的总开关；关闭即回到原生循环 |
| `policy.maximum_candidates` | `16` | 单张动作图的候选数，标号 `A`-`P` |
| `policy.maximum_fast_steps` | `8` | 图耗尽前允许的替换步数 |
| `policy.maximum_public_bytes` | `65536` | 选择器与守卫可见状态的字节上限 |
| `policy.admission_threshold_tokens` | `1024` | 经选择器替换前必须净省下的 token |
| `selector.enabled` | `true` | 关闭后多候选步骤直接回到慢路径 |
| `selector.provider` / `.model` | `''` | 留空则沿用边界请求自身的路由 |
| `selector.maxTokens` | `1024` | 推理模型要先思考才吐出那个字母 |
| `selector.timeoutMs` | `20000` | 选择器调用超时 |
| `shellTools` | `[]` | 留空从实时工具目录识别 `bash`/`pwsh` |
| `planSection` | `true` | 是否注入编写段落 |
| `receiptsFile` | `''` | 留空写入 `$DSH_HOME/harnessmm/receipts.jsonl` |

### 准入

只有当被替换的慢速回合的代价，超过替换它的快调用至少 `policy.admission_threshold_tokens` 时，
替换才被准入。设慢速回合自身用量为 `n`：

- 只有一个幸存候选 → 确定性命中，与 `n` 无关；
- 多个幸存候选 → 当 `n - selector_upper_bound > threshold` 时准入，该上界被夹到 512 token。

论文的 1024 是默认值，也是保守方向。单候选不受阈值约束，这正是控制器在低于阈值的步骤上仍然有用的原因。

## 编写契约

每回合一张图，写在裸 assistant 文本里（代码围栏内视为文档），旁边只能有唯一一次根工具调用：

```text
<CHISEL_PLAN>{"candidates":[
  {"candidate_id":"A","predecessor_id":"root","tool":"pwsh",
   "arguments":{"description":"Run the tests","command":"npm test"},
   "guard":{"exit_code":0},"required_receipt_fields":["exit_code"],
   "expected_local_cost":{"selector_upper_tokens":8192},"dependency_ids":[]},
  {"candidate_id":"B","predecessor_id":"A","tool":"pwsh",
   "arguments":{"description":"Show the diff","command":"git --no-pager diff"},
   "guard":{"exit_code":0,"stdout_contains":"diff"},"required_receipt_fields":["exit_code","stdout"],
   "expected_local_cost":{"selector_upper_tokens":8192},"dependency_ids":["A"]}
]}</CHISEL_PLAN>
```

解析器（以及测试）强制以下规则：

- 标号唯一，取值 `A`..`P`；`predecessor_id` 只能是 `root` 或更早的标号；
  `dependency_ids` 必须已经声明；
- 节点键集合是封闭的——多一个键就是违约，而不是提示；
- `arguments` 必须完全字面：出现 `${...}` 或 `{{...}}` 占位符会被拒绝，因为依赖
  未见输出的参数不是冻结的决策；
- 守卫字段仅限 `ok`、`exit_code`、`stdout_contains`、`stdout_equals`、
  `stderr_empty`、`json_equals`；且每个守卫字段都必须列进 `required_receipt_fields`，
  保证守卫永远不会读到回执可能缺失的字段；
- 候选不得重复根动作；
- 每回合恰好一张图、恰好一次根调用。同一段 JSON 在思考里起草、在回答里重述算同一次声明；两份 *不同*
  的计划则不是。

## 回执与证书

`receiptsFile` 中每行一个 JSON 对象：

| 类型 | 含义 |
| --- | --- |
| `bank` | 慢速回合声明了一张合法动作图 |
| `decision` | 门控收到回执，列出准入与被拒候选及原因 |
| `substitution-issued` | 已用原生调用代替慢速回调发出 |
| `substitution` | 证书，绑定精确原生结果 |
| `invalid-bank` | 声明违反封闭契约 |
| `boundary-error` | 流控制器异常；记录，不隐藏 |
| `dispatch-rejected` | `tools/execute` 拒绝了被改写或越图的调用 |
| `selector-abstain` / `selector-unmapped` | 选择器放弃，慢路径接管 |

守卫看到的回执先做规范化：CRLF 转 LF，去掉一个行尾换行，渲染器自带的状态尾标
（`[exit code: N]`、`[output truncated; ...]`）先用于取退出码再被剥掉。因此守卫比较的是
程序输出，而不是 shell 外壳。

证书（`harnessmm-dsh-certificate/v1`）携带论文六字段与审计计数，其中
`bypassed_slow_callback_id` 永远非空：宿主不提供 provider 请求 id，插件用边界请求序号与其中
的替换序号合成一个稳定 id。没有指明"哪次回调没有发生"的证书不成立。

证书的声明刻意收窄：**本 agent 循环内一次被绕过的回调**。这里没有 episode 级反事实，也不应与论文的
benchmark 运行身份做比较。

## 真实循环上的验证

`test/live-headless.mjs` 使用真实 CLI、真实原生 shell 执行器与真实会话日志，对本地脚本化的
Messages 端点运行。场景声明一张两步图：根回执满足 `A`，`A` 的回执满足 `B`。

```text
PASS  live harness run
  model requests      : 3 (2 substituted steps skipped)
  substituted calls   : chisel_..._A, chisel_..._B
  certificates        : A session-...:request-1:omitted:0 | B session-...:request-1:omitted:1
  status              : {"enabled":true,"gate":"commit","banks_authored":1,
                         "decisions_commit":2,"substitutions_issued":2,"substitutions_certified":2, ...}
```

相邻行为由单元测试与假宿主测试覆盖：守卫不成立时以
`{"kind":"slow","reason":"no_eligible_candidate"}` 交回控制权；被改写的 `chisel_` 调用在
到达执行器之前就被拒绝。

## 测试

```sh
npm install
npm test          # 协议契约 + 假宿主边界，54 个用例，不需要 provider
npm run test:live # 可选端到端，需要 harness CLI
```

## 与原始实现的有意差异

原始实现通过 SDK 桥与 benchmark 的 `terminal` 工具对话，DSH profile 没有这两者，所以本移植复现
的是协议，而不是论文的 harness：

- **回执方言**：shell 工具是`pwsh`/`bash`，必填 `description`，结果是渲染文本；
  因此守卫字段是 `exit_code`，回执需要解码而不是 `JSON.parse`。
- **选择器**：宿主不暴露 logprobs，选择器改为单字符补全并在候选标号内校验，其它一律视为放弃。
- **代价模型**：选择器开销上限 512 token，而非作者的重决策估计；准入阈值是可配置策略字段。
- **证书范围**：一张证书一次回调，不做 episode 级反事实。
- **不实现 RSI**：递归自我改进在原始仓库的离线流程中，本插件只做运行时适配。
- **不做历史压缩**：授权图保留在 transcript 中；删改会改变循环重放的内容，本版本不尝试。

## 安全

- 守卫是数据不是代码；读不懂的证据交回模型，而不是猜测。
- `tools/execute` 对每个 `chisel_` 调用重新核对授权的字面动作，即使流里出现被改写的参数也
  到不了原生执行器。
- 控制器保留 profile 的权限与动作空间，绝不扩大。
- 回执持久化是尽力而为：写不进去也不会中断回合。

## 许可

Apache-2.0。HarnessMM 是 Yuhua Jiang、Chang Xu、Feifei Gao、Li Zhao 的研究代码；见 [NOTICE](NOTICE)
与 [CITATION.bib](CITATION.bib)。