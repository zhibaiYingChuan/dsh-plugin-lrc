/**
 * 测试用 ESM 解析钩子：把 `@deepseek-ai/*` 指到 DSH 的 node_modules。
 *
 * 为什么需要：插件把 `@deepseek-ai/*` 声明为 peerDependency，本地
 * `node_modules` 里没有这些包（生产由宿主提供）。直接 `import '../src/index.ts'`
 * 会在解析阶段失败，导致入口层（`apply()` / `defineTool`）永远测不到 ——
 * 这正是 `required: false` 回归能溜进生产的原因。
 *
 * 用法：
 *   node --experimental-loader ./scripts/deepseek-loader.mjs scripts/e2e-apply.ts
 */
import { pathToFileURL } from 'node:url';

/** DSH 宿主依赖所在目录（可用 DSH_PROFILES 覆盖）。 */
const PROFILES =
  process.env.DSH_PROFILES ?? 'C:/Users/Administrator/.dsh/profiles/node_modules/';

/** 一个不存在的锚点文件：只用来给 Node 一个解析起点。 */
const ANCHOR = pathToFileURL(`${PROFILES}__anchor__.js`).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@deepseek-ai/')) {
    return nextResolve(specifier, { ...context, parentURL: ANCHOR });
  }
  return nextResolve(specifier, context);
}
