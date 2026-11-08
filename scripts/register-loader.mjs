/**
 * 用 `module.register()` 注册解析钩子（替代已弃用的 `--experimental-loader`）。
 *
 * 用法：
 *   node --import ./scripts/register-loader.mjs scripts/e2e-apply.ts
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./deepseek-loader.mjs', pathToFileURL(import.meta.filename));
