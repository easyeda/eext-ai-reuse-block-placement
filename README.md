# ai-reuse-block-placement 复用模块智能助手

嘉立创EDA专业版（EasyEDA）扩展：**复用模块（CBB）对话助手**。

用自然语言找模块、改描述、导出目录；放置 / 写库 / 导出都会先出确认卡，确认前不改动画布。

## 使用

原理图菜单 →「AI Reuse Block Placement → Open AI Reuse Block Placement...」打开对话面板。

### 1. 配置（首次）

- **模型接入**：API 格式（openai-chat / openai-responses / anthropic）、baseUrl / apiKey / model，保存后可「测试连接」。
- **Jev模型接入**（可选增强）：TypeSafe 决策模型的专用 Key。未配置不影响使用——找模块自动回落关键词检索；配置后语义推荐可用（baseUrl 默认 `https://api.typesafe.ai/v1`，model 默认 `jev-latest`）。
- **库范围**：个人库 / 团队库 / 本地库可用性自动检测（随客户端模式裁剪）。
- 未配置主模型时，对话会引导到设置页。

### 2. 对话

| 需求 | 说明 |
|---|---|
| 找模块 | 精确型号 / 名称 → 关键词检索；宽泛、口语化或功能描述（如「找个能降压供电的」）→ Jev 语义推荐，按匹配度返回带分数的明细 |
| 放置 | 明确要求放置时自动出示确认卡（默认**复用模块符号**形式，可逐项切换图页；位置支持当前图页 / 新建图页 / 新板子 / 新工程）；落点按对齐网格自动排布并避让已占用区域 |
| 改名称 / 描述 | 自动读取模块自带原理图分析后出编辑确认卡 |
| 导出 | 工程包 zip（catalog.json 清单 + 本地模块 .eprj2），支持按需导出指定模块或全量 |

写操作一律走确认卡令牌：不在模型工具表内，卡上勾选确认后才执行；目录刷新会使旧卡作废。

### 3. 设置页其他项

- **放置排布**：模块间距、标注框颜色 / 线宽 / 边距。
- **本地库复用**：工程包 zip 导出 / 导入。
- 自检、清空对话与目录快照。

## 开发

```bash
npm install
npm run compile   # esbuild 产出 dist/index.js
npm run build     # compile + 打包 build/dist/ai-reuse-block-placement_v<ver>.eext
npm run lint
```

安装：客户端「设置 → 扩展 → 导入扩展」选择 `.eext`。

## 当前状态（v0.8.0）

| 能力 | 状态 |
|---|---|
| 对话 agent（≤12 轮工具循环 + 确认卡） | ✅ |
| 目录拉取三源（个人 / 团队 / 本地）→ 单持久层 catalog_store.v1 | ✅ 真机验证，跨重启 |
| 关键词检索 search_modules | ✅ |
| Jev 语义推荐 recommend_modules（分类缓存 → 类别筛选 → 打分 → 意图出卡） | ✅ 需配置 TypeSafe Key |
| 确认后放置，默认符号形式，三类库均支持图页 | ✅ 真机验证 |
| 多模块网格放置（单卡 ≤20 项） | ✅ |
| 编辑名称 / 描述（原理图自动分析） | ✅ |
| 工程包导出（按需 cbbUuids / 全量）与导入 | ✅ |
| Jev 语义推荐 + 关键词检索并存分工 | ✅ 未配 Key 自动回落 |

## 已知限制

- 出网走嘉立创代理（`sys_ClientUrl.request`）；`api.openai.com` 经代理实测 500——`baseUrl` 必须可配，用国内可达端点。
- `lib_Cbb.search` 分页 1 起；本地库须把磁盘路径作 libraryUuid。
- `lib_Cbb.create` 静默失败 → 只做修改，不做创建。
- 假 uuid 调放置 API 会挂起 ≥8s——放置 / 修改均有超时。
- 开源广场无扩展 API；要纳入目录请先复制到个人库。
- Jev 语义推荐首次调用会全量分类（模块数 / 16 个请求），之后走缓存；目录刷新后自动重建。

## 源码结构

```
src/
  index.ts            入口 + iframe 桥（eda.ai_reuse_block_placement）
  host.ts             宿主 API 汇集
  settings.ts         设置双写（LLM + Jev + 库范围 + 放置排布）
  env.ts              客户端模式检测
  catalog.ts          目录类型、三源拉取、.eprj2 索引
  cbb.ts              放置 + 改描述
  pkg.ts              工程包 zip 导出/导入
  agent/
    loop.ts           对话循环 + 工具执行 + 确认卡令牌
    tools.ts          系统提示 + 工具注册表（10 个工具）
    llm.ts            三格式请求构造 / 解析
    http.ts           sys_ClientUrl 出站 + 错误分类
    store.ts          目录持久层（catalog_store.v1）
    jev.ts            Jev 语义推荐流水线（jev_classify.v1）
iframe/chat.html     对话面板（双页：对话 + 设置）
```
