/**
 * 统一预算的单元测试。
 *
 * 用法：node scripts/e2e-budget.ts
 *
 * 覆盖：显式窗口 / 自动探测 / 探测失败兜底 / 上下限钳制 / 格式化。
 */
import { formatBudget, resolveBudget, type BudgetConfig } from '../src/budget.ts';

let failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

const baseConfig: BudgetConfig = {
  contextWindowTokens: 0,
  trimRatio: 0.03,
  pruneRatio: 0.004,
  trimMinTokens: 30000,
  pruneResultThreshold: 4096,
};

const agent = {
  session: {
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  },
};

// 1. 显式窗口
{
  const budget = await resolveBudget({
    ctx: {},
    agent,
    config: { ...baseConfig, contextWindowTokens: 1_000_000 },
  });
  check('显式窗口 source=configured', budget.source === 'configured', budget);
  check('1M 窗口 trim=30000', budget.trimMinTokens === 30000, budget.trimMinTokens);
  check('1M 窗口 prune=4000', budget.pruneResultThreshold === 4000, budget.pruneResultThreshold);
}

// 2. 自动探测
{
  const ctx = {
    get: (n: string) =>
      n === 'llm'
        ? { resolveModelInfo: async () => ({ context: { contextWindow: 200_000 } }) }
        : undefined,
  };
  const budget = await resolveBudget({ ctx, agent, config: baseConfig });
  check('自动探测 source=auto', budget.source === 'auto', budget);
  check('200K 窗口 trim=8000（下限）', budget.trimMinTokens === 8000, budget.trimMinTokens);
  check('200K 窗口 prune=2048（下限）', budget.pruneResultThreshold === 2048, budget.pruneResultThreshold);
}

// 3. 无路由目标 → 兜底
{
  const budget = await resolveBudget({
    ctx: {},
    agent: { session: { requestHeader: () => undefined } },
    config: baseConfig,
  });
  check('无路由目标 source=fallback', budget.source === 'fallback', budget);
  check('兜底用配置绝对值', budget.trimMinTokens === 30000, budget.trimMinTokens);
}

// 4. 探测抛错 → 兜底
{
  const ctx = {
    get: (n: string) =>
      n === 'llm'
        ? {
            resolveModelInfo: async () => {
              throw new Error('no such model');
            },
          }
        : undefined,
  };
  const budget = await resolveBudget({ ctx, agent, config: baseConfig });
  check('探测抛错 source=fallback', budget.source === 'fallback', budget);
}

// 5. 上限钳制
{
  const budget = await resolveBudget({
    ctx: {},
    agent,
    config: { ...baseConfig, contextWindowTokens: 10_000_000 },
  });
  check('超大窗口 trim 上限 200000', budget.trimMinTokens === 200000, budget.trimMinTokens);
  check('超大窗口 prune 上限 8192', budget.pruneResultThreshold === 8192, budget.pruneResultThreshold);
}

// 6. 格式化
{
  const budget = await resolveBudget({
    ctx: {},
    agent,
    config: { ...baseConfig, contextWindowTokens: 1_000_000 },
  });
  const line = formatBudget(budget);
  check('格式化含窗口', line.includes('1000000 tokens'), line);
  check('格式化含 trim/prune', line.includes('trim=30000') && line.includes('prune=4000'), line);
}

// 7. 探测值达到可信上限：视为未知模型的哨兵值，退回绝对值
{
  const ctx = {
    get: (n: string) =>
      n === 'llm'
        ? { resolveModelInfo: async () => ({ context: { contextWindow: 2_000_000 } }) }
        : undefined,
  };
  const budget = await resolveBudget({ ctx, agent, config: baseConfig });
  check('超大探测值降级为 fallback', budget.source === 'fallback', budget);
  check('降级后用配置绝对值', budget.trimMinTokens === 30000, budget.trimMinTokens);
  check('记录模型名', budget.model === 'm', budget.model);
  check('格式化含降级原因', formatBudget(budget).includes('note='), formatBudget(budget));
}

// 7b. 实测故障：宿主对未知模型返回 1,000,000 哨兵值
{
  const ctx = {
    get: (n: string) =>
      n === 'llm'
        ? { resolveModelInfo: async () => ({ context: { contextWindow: 1_000_000 } }) }
        : undefined,
  };
  const budget = await resolveBudget({ ctx, agent, config: baseConfig });
  check('1M 哨兵值不当作比例基线', budget.source === 'fallback', budget);
  check('1M 哨兵值 trim 用绝对值', budget.trimMinTokens === 30000, budget.trimMinTokens);
  check('1M 哨兵值 prune 用绝对值', budget.pruneResultThreshold === 4096, budget.pruneResultThreshold);
}

// 7c. 略低于上限的真实窗口仍按比例推导
{
  const ctx = {
    get: (n: string) =>
      n === 'llm'
        ? { resolveModelInfo: async () => ({ context: { contextWindow: 999_999 } }) }
        : undefined,
  };
  const budget = await resolveBudget({ ctx, agent, config: baseConfig });
  check('低于上限仍走 auto', budget.source === 'auto', budget);
  check('999999 窗口 trim=29999', budget.trimMinTokens === 29999, budget.trimMinTokens);
}

// 8. 探测值钳制：过小窗口钳到 8K
{
  const ctx = {
    get: (n: string) =>
      n === 'llm'
        ? { resolveModelInfo: async () => ({ context: { contextWindow: 100 } }) }
        : undefined,
  };
  const budget = await resolveBudget({ ctx, agent, config: baseConfig });
  check('过小探测值钳到 8K', budget.windowTokens === 8_192, budget.windowTokens);
  check('钳制后 trim=8000（下限）', budget.trimMinTokens === 8000, budget.trimMinTokens);
}

// 9. ★2026-11-12 实测回归：`requestContext()` 里的真实窗口必须优先于探测
//
// 事故：真实窗口 1,048,576 被 resolveModelInfo 探成 1,000,000 →
// 判为「哨兵值不可信」→ 退回 30000 绝对值 → 窗口利用率 2.9% 就压缩历史
// → 每次 trim 都打断前缀缓存（实测 2 次 cacheRead=0 全价重发）。
//
// ⚠️ 宿主契约（从 app.asar 的 dsh-session / dsh-agent-loop 核实）：
// - `requestHeader().config` 只有 { provider, model, maxTokens }，**没有** contextWindow
//   （实测 43 条 request/header，config 键集合仅这三个）；
// - 窗口在 `request/context` 事件里，由 `session.requestContext()` 折叠返回。
// 早期版本这里 mock 了 `requestHeader().config.contextWindow` —— 那是虚构契约，
// 测试全绿但生产永不执行，属于「假通过」。
{
  const declaredAgent = {
    session: {
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
      requestContext: () => ({ provider: 'p', model: 'm', contextWindow: 1_048_576 }),
    },
  };
  // 即使探测会返回哨兵值，也必须用声明值
  const ctx = {
    get: (n: string) =>
      n === 'llm'
        ? { resolveModelInfo: async () => ({ context: { contextWindow: 1_000_000 } }) }
        : undefined,
  };
  const budget = await resolveBudget({ ctx, agent: declaredAgent, config: baseConfig });
  check('requestContext 窗口优先于探测', budget.source === 'configured', budget);
  check('requestContext 窗口值被采用', budget.windowTokens === 1_048_576, budget.windowTokens);
  check(
    '1M 窗口按比例推导（不再退回 30000）',
    budget.trimMinTokens === Math.floor(1_048_576 * baseConfig.trimRatio),
    budget.trimMinTokens,
  );
  check('标注来源 requestContext', (budget.note ?? '').includes('requestContext'), budget.note);

  // 关键：声明值 = 1,000,000 恰好等于 MAX_TRUSTED_WINDOW，不得被当哨兵再判一次
  const exactAgent = {
    session: {
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
      requestContext: () => ({ contextWindow: 1_000_000 }),
    },
  };
  const exact = await resolveBudget({ ctx: {}, agent: exactAgent, config: baseConfig });
  check('声明值 1000000 不被二次误判为哨兵', exact.source === 'configured', exact);
  check('声明值 1000000 正常推导', exact.windowTokens === 1_000_000, exact.windowTokens);

  // 没有 request/context 事件（首次请求前）⇒ 回退探测
  const noContextAgent = {
    session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) },
  };
  const probed = await resolveBudget({ ctx, agent: noContextAgent, config: baseConfig });
  check('无 requestContext 时回退探测', probed.source === 'fallback', probed);

  // requestContext 返回空对象（事件存在但无 contextWindow）
  const emptyContextAgent = {
    session: {
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
      requestContext: () => ({}),
    },
  };
  const empty = await resolveBudget({ ctx, agent: emptyContextAgent, config: baseConfig });
  check('requestContext 缺 contextWindow 时回退探测', empty.source === 'fallback', empty);

  // 声明值不合理时不得采用（防止配置写错）
  const badAgent = {
    session: {
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
      requestContext: () => ({ contextWindow: 5 }),
    },
  };
  const bad = await resolveBudget({ ctx: {}, agent: badAgent, config: baseConfig });
  check('过小的声明窗口被忽略', bad.source === 'fallback', bad);

  const hugeAgent = {
    session: {
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
      requestContext: () => ({ contextWindow: 1e12 }),
    },
  };
  const huge = await resolveBudget({ ctx: {}, agent: hugeAgent, config: baseConfig });
  check('荒谬的声明窗口被忽略', huge.source === 'fallback', huge);

  // 显式配置仍然最优先（高于 requestContext）
  const explicit = await resolveBudget({
    ctx: {},
    agent: declaredAgent,
    config: { ...baseConfig, contextWindowTokens: 200_000 },
  });
  check('显式配置优先于 requestContext', explicit.windowTokens === 200_000, explicit.windowTokens);
}

// 10. 窗口很小时的下限：保证「攒够再裁」，避免每步重写历史
{
  const ctx = {
    get: (n: string) =>
      n === 'llm'
        ? { resolveModelInfo: async () => ({ context: { contextWindow: 128_000 } }) }
        : undefined,
  };
  const budget = await resolveBudget({ ctx, agent, config: baseConfig });
  check('128K×0.03=3840 → 抬到下限 8000', budget.trimMinTokens === 8000, budget.trimMinTokens);
}

// 11. 生产默认 trimRatio=0.10 的边界核算
//
// 0.03 → 0.10 的理由：trim 会重写早期历史，KV 前缀缓存整段失效；
// 实测每次 trim 只降 3~7K tokens 却丢 14~37K 缓存前缀，净亏。
{
  const prodConfig: BudgetConfig = { ...baseConfig, trimRatio: 0.1 };
  const cases: Array<{ window: number; want: number; note: string }> = [
    { window: 128_000, want: 12_800, note: '128K → 12800（宿主 compaction 在 102K 接手，安全）' },
    { window: 131_072, want: 13_107, note: '131K → 13107' },
    { window: 1_048_576, want: 104_857, note: '1M → 104857（实测会话峰值 81K，不会触发）' },
  ];
  for (const c of cases) {
    const a = {
      session: {
        requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
        requestContext: () => ({ contextWindow: c.window }),
      },
    };
    const b = await resolveBudget({ ctx: {}, agent: a, config: prodConfig });
    check(`${c.note}`, b.trimMinTokens === c.want, b.trimMinTokens);
  }
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
