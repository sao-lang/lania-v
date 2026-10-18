# Benchmark Guide

## 目标

这套 benchmark 用于在真实浏览器里横向比较 `lania-v`、`React`、`Vue`、`Solid` 的核心更新路径，而不是只看 `jsdom` 或单次体感。

当前基线覆盖以下 4 个目标：

- `Lania TSX`
- `React`
- `Vue`
- `Solid`

它们都在同一套 benchmark harness 下运行，保证场景、数据量、操作序列、浏览器环境和结果 schema 一致。

## 运行方式

执行完整 benchmark：

```bash
npm run bench
```

只根据现有 `latest.json` 生成 Markdown 报告：

```bash
npm run bench:report
```

以有头模式运行，便于观察页面：

```bash
npm run bench:headed
```

## 运行模式

benchmark 使用以下基建：

- 独立 workspace：`playground/benchmark`
- 独立 Playwright 配置：`playwright.bench.config.ts`
- 浏览器目标：当前默认 `chromium`
- 运行模式：先 `vite build`，再 `vite preview`
- 对比方式：单页面切换不同 target，由同一套 runner 执行

这样做的目的，是避免把 dev server 的热更新、额外调试开销和源代码即时编译噪音混进结果。

## 当前场景

当前默认跑 5 个 case：

- `mount`
  - 批量重复卸载并挂载基准组件，测量挂载成本
- `text-update`
  - 批量执行计数更新，测量文本更新成本
- `list-patch`
  - 批量 patch 一个 1000 项数组中的中间项，并测量中间项投影更新成本
- `toggle`
  - 批量切换条件块，测量结构型显隐切换
- `model-input`
  - 批量写入 input 并触发 `input` 事件，测量输入同步链路

## 批量采样

当前 benchmark 不再直接把“单次点击”当作一个样本，而是采用：

- `warmupSamples`
- `sampleCount`
- `operationsPerSample`

也就是：

- 每个 case 先做若干轮预热
- 每个正式样本里连续执行 N 次同类操作
- 最终再把整批耗时折算成单操作耗时

这样可以减少 `performance.now()` 分辨率过低导致的 `0ms` 噪音。

## DOM 稳定等待规则

每个样本在操作序列结束后都要等到 DOM 反映目标状态，这一步叫 settle。settle 的实现直接影响读数公平性：

- 先用微任务让渡（最多 8 次 `await Promise.resolve()`）等一次提交
- 只有仍未满足时才退回 `setTimeout(0)` 轮询

原因：把更新合并在微任务里提交的框架，本来在一次微任务后就能完成；
如果直接轮询 timer，会额外计入浏览器对嵌套定时器的钳制开销（通常 ≥1ms），
而同步提交的框架首读即命中、不会被计入。
这会让口径系统性偏向"同步写 DOM"的实现，而不是真实提交延迟。

由此带来一个约定：

- 同一次运行内跨框架比较有效
- 与采用旧 settle 规则（直接 `setTimeout` 轮询）的历史读数**不可直接比较**，尤其是单操作耗时低于 0.1ms 的 case

## 结果输出

Playwright runner 会把最新结果写入：

```text
test-results/benchmark/latest.json
```

报告脚本会额外生成：

```text
test-results/benchmark/latest.md
```

结果结构大致如下：

```json
{
  "framework": "comparison",
  "browser": "chromium",
  "generatedAt": "2026-05-18T07:48:23.738Z",
  "suites": [
    {
      "framework": "lania-v",
      "target": "lania-fc",
      "variant": "fc",
      "label": "Lania FC",
      "cases": [
        {
          "name": "text-update",
          "sampleCount": 24,
          "warmupSamples": 4,
          "operationsPerSample": 120,
          "minMs": 0.039,
          "maxMs": 0.045,
          "meanMs": 0.041,
          "medianMs": 0.04,
          "p95Ms": 0.043,
          "batchMeanMs": 4.8,
          "batchMedianMs": 4.8,
          "batchP95Ms": 5.1,
          "samplesMs": [0.039, 0.04],
          "sampleBatchMs": [4.7, 4.8]
        }
      ]
    }
  ]
}
```

## 读数建议

默认优先看：

- `medianMs`
- `p95Ms`
- `operationsPerSample`

不要优先看：

- 单次最小值
- 首次运行的第一条样本

原因：

- 首次运行常常包含初始化和 JIT 热身
- 单次最小值容易过于乐观
- `median + p95` 更适合观察常态表现和长尾抖动
- 批量采样下必须确认 `operationsPerSample` 一致，结果才有可比性

## 扩展方式

如果后面要加入更多框架或更多场景，建议保持下面这几个约束：

- 同一个 case 名称必须对应相同 UI 语义
- 同一个 case 必须保持相同数据量
- 所有实现必须跑生产构建
- 所有结果统一落到同一份 JSON schema

推荐的后续扩展方向：

- 增加 `memory` 采样
- 增加更大数据量档位，例如 `5000`、`10000`
- 拆分 `mount` 与 `hydrate` 场景
- 增加更多真实列表和结构型 DOM case

## 自动报告

执行 `npm run bench` 后，会自动生成 Markdown 报告，内容包括：

- 总览表
- 每个 case 的最快目标
- 每个 case 的明细排行

报告文件位置：

```text
test-results/benchmark/latest.md
```

## 注意事项

- benchmark 结果高度依赖机器状态，最好在空闲环境下运行
- 比较不同提交时，尽量固定浏览器版本和硬件环境
- 不要把 dev 模式的结果拿去和别人的 production benchmark 对比
