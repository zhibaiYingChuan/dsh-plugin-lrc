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

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
