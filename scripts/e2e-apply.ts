/**
 * 入口层冒烟测试：真正 import `src/index.ts` 并调用一次 `apply()`。
 *
 * 用法：
 *   node --experimental-loader ./scripts/deepseek-loader.mjs scripts/e2e-apply.ts
 *
 * 为什么必须有这一套：其余六套 e2e 都只测纯函数，没有一个 import 入口。
 * 结果 `lrc_handoff` 参数写了 `required: false`（DSH 规定该键出现时必须为
 * true）抛 JsonSchemaError，把整个 apply() 掀翻，六套测试却全绿。
 *
 * 覆盖：
 *   1. apply() 不抛错
 *   2. 两个工具都注册成功，且 schema 合法
 *   3. 事件监听挂上
 *   4. 工具注册失败时不掀翻 apply（P2 韧性）
 */
import { apply } from '../src/index.ts';

let failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

/** 与 Config schema 默认值一致的完整配置。 */
const config = {
  // ⚠ 这个端口**必定连不上**，本文件只验「加载不抛错 + 工具注册」。
  //
  // 历史教训：正因为这里用了必连不上的地址，`client` 一直是 null，
  // 而本文件从不调用任何工具 execute()，于是「client 为 null 就永久返回
  // 未就绪」的缺陷带着 15 套全绿测试发布出去了（真实事故 session-3b497669）。
  //
  // 工具**行为**的验证见 `e2e-entry-tools.ts`（真连 mock LRC，逐个 execute）。
  baseUrl: 'http://127.0.0.1:1',
  token: '',
  project: 'test',
  offloadTurns: 8,
  offloadChars: 6000,
  offloadSteps: 8,
  maxItems: 40,
  pruneEnabled: true,
  pruneResultThreshold: 4096,
  pruneArgsEnabled: true,
  pruneArgsThreshold: 4000,
  pruneArgsHead: 2000,
  pruneReasoningEnabled: true,
  keepRecentNodes: 8,
  trimEnabled: true,
  contextWindowTokens: 0,
  trimRatio: 0.03,
  pruneRatio: 0.004,
  trimMinTokens: 30000,
  trimMinSteps: 10,
  trimMaxNodes: 120,
  trimMaxSummaryChars: 2000,
  reconnectBaseMs: 2000,
  reconnectMaxMs: 60000,
  capabilityRecheckSteps: 20,
  budgetRecheckSteps: 20,
};

interface StubCtx {
  logger: { info: (m: string) => void; warn: (m: string) => void };
  get: () => undefined;
  effect: () => () => void;
  on: (event: string) => void;
  tools: { register: (tool: unknown) => void };
}

function makeCtx(options: {
  logs: string[];
  tools: unknown[];
  events: string[];
  register?: (tool: unknown) => void;
}): StubCtx {
  return {
    logger: {
      info: (m: string) => options.logs.push(`info:${m}`),
      warn: (m: string) => options.logs.push(`warn:${m}`),
    },
    get: () => undefined,
    effect: () => () => {},
    on: (event: string) => {
      options.events.push(event);
    },
    tools: { register: options.register ?? ((tool: unknown) => options.tools.push(tool)) },
  };
}

// ────────────────────────────────────────────────────────────
// 1. 正常加载
// ────────────────────────────────────────────────────────────
console.log('=== 1) apply() 正常加载 ===');

const logs: string[] = [];
const tools: unknown[] = [];
const events: string[] = [];
let threw: unknown = null;
try {
  apply(makeCtx({ logs, tools, events }) as never, config as never);
} catch (error) {
  threw = error;
}

check('apply 不抛错', threw === null, threw instanceof Error ? threw.message : threw);
check('注册了五个工具', tools.length === 5, tools.length);

const names = tools.map((tool) => (tool as { name?: string }).name);
check(
  '工具名正确',
  names.join(',') === 'lrc_remember_now,lrc_recall,lrc_forget,lrc_handoff,lrc_status',
  names,
);
check('订阅了 session/event', events.includes('session/event'), events);
check('订阅了 agent/pre-step', events.includes('agent/pre-step'), events);

// ────────────────────────────────────────────────────────────
// 2. 工具 schema 合法（本次回归的直接断言）
// ────────────────────────────────────────────────────────────
console.log('=== 2) 工具 schema ===');

const handoff = tools.find((tool) => (tool as { name?: string }).name === 'lrc_handoff') as
  | { parameters?: { properties?: Record<string, unknown>; required?: string[] } }
  | undefined;
check('lrc_handoff 已注册', handoff !== undefined);
check('note 参数存在', handoff?.parameters?.properties?.note !== undefined);
check(
  'note 不在 required 列表（可选参数）',
  !(handoff?.parameters?.required ?? []).includes('note'),
  handoff?.parameters?.required,
);
check(
  'note 属性上没有 required: false',
  (handoff?.parameters?.properties?.note as { required?: unknown } | undefined)?.required === undefined,
  handoff?.parameters?.properties?.note,
);

const remember = tools.find((tool) => (tool as { name?: string }).name === 'lrc_remember_now') as
  | { parameters?: { required?: string[] } }
  | undefined;
check('lrc_remember_now 的 text 是必填', (remember?.parameters?.required ?? []).includes('text'));

// ────────────────────────────────────────────────────────────
// 3. 工具注册失败不掀翻 apply（P2 韧性）
// ────────────────────────────────────────────────────────────
console.log('=== 3) 工具注册失败韧性 ===');

const logs2: string[] = [];
const events2: string[] = [];
let threw2: unknown = null;
try {
  apply(
    makeCtx({
      logs: logs2,
      tools: [],
      events: events2,
      register: () => {
        throw new Error('JsonSchemaError: unsupported JSON schema');
      },
    }) as never,
    config as never,
  );
} catch (error) {
  threw2 = error;
}

check('工具注册失败不掀翻 apply', threw2 === null, threw2 instanceof Error ? threw2.message : threw2);
check(
  '记录了工具注册失败',
  logs2.some((line) => line.includes('注册失败')),
  logs2,
);
check('事件监听仍然挂上', events2.includes('session/event') && events2.includes('agent/pre-step'), events2);

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
