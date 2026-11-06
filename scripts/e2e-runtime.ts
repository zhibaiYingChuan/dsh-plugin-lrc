/**
 * 运行时管理的端到端测试。
 *
 * 用法：node scripts/e2e-runtime.ts
 *
 * 覆盖三种模式与一条安全红线：
 *   1. external —— 已有 LRC 时直接复用，不下载
 *   2. managed  —— 下载 + SHA256 校验通过后启动
 *   3. degraded —— 清单缺失 / 哈希不符时降级，**绝不运行未校验的二进制**
 */
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LrcRuntime } from '../src/runtime.ts';

let failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// ── 1) external：已有实例 ──────────────────────────────
console.log('=== 1) external 模式 ===');
const healthServer = createServer((req, res) => {
  if (req.url === '/health') return send(res, 200, { status: 'running' });
  send(res, 404, {});
});
await new Promise<void>((resolve) => healthServer.listen(0, '127.0.0.1', resolve));
const healthAddr = healthServer.address();
if (healthAddr === null || typeof healthAddr === 'string') throw new Error('端口获取失败');
const externalUrl = `http://127.0.0.1:${healthAddr.port}`;

const workDir = mkdtempSync(join(tmpdir(), 'lrc-runtime-'));
process.env.LRC_BASE = externalUrl;
const externalRuntime = new LrcRuntime({ cacheDir: join(workDir, 'a') });
const external = await externalRuntime.ensure();
check('识别为 external', external.mode === 'external', external);
check('复用给定地址', external.baseUrl === externalUrl, external);
check('没有下载二进制', !existsSync(join(workDir, 'a', 'bin')), 'bin 目录不应存在');
delete process.env.LRC_BASE;
await new Promise<void>((resolve) => healthServer.close(() => resolve()));

// ── 2) degraded：清单缺失 ─────────────────────────────
console.log('=== 2) degraded：清单缺失 ===');
const noManifest = new LrcRuntime({
  cacheDir: join(workDir, 'b'),
  manifest: {},
  probeLocal: false,
  healthTimeoutMs: 1000,
});
const degraded1 = await noManifest.ensure();
check('降级为 degraded', degraded1.mode === 'degraded', degraded1);
check('给出可读原因', (degraded1.reason ?? '').includes('二进制清单'), degraded1.reason);

// ── 3) degraded：哈希不符（安全红线）──────────────────
console.log('=== 3) degraded：SHA256 不符 ===');
const fakeBinary = Buffer.from('this is not a real lrc binary');
const fakeHash = createHash('sha256').update(fakeBinary).digest('hex');
const fileServer = createServer((req, res) => {
  if (req.url?.endsWith('.exe') || req.url?.endsWith('lrc-sidecar')) {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(fakeBinary);
    return;
  }
  send(res, 404, {});
});
await new Promise<void>((resolve) => fileServer.listen(0, '127.0.0.1', resolve));
const fileAddr = fileServer.address();
if (fileAddr === null || typeof fileAddr === 'string') throw new Error('端口获取失败');
const fileUrl = `http://127.0.0.1:${fileAddr.port}`;

const wrongHashRuntime = new LrcRuntime({
  cacheDir: join(workDir, 'c'),
  mirror: fileUrl,
  manifest: {
    [`${process.platform}-${process.arch}`]: {
      file: 'lrc-sidecar.exe',
      // 故意给一个错误哈希
      sha256: '0'.repeat(64),
    },
  },
  probeLocal: false,
  healthTimeoutMs: 1000,
});
const degraded2 = await wrongHashRuntime.ensure();
check('哈希不符时降级', degraded2.mode === 'degraded', degraded2);
check('原因含 SHA256', (degraded2.reason ?? '').includes('SHA256'), degraded2.reason);
check(
  '未校验的二进制已被删除',
  !existsSync(join(workDir, 'c', 'bin', process.platform === 'win32' ? 'lrc-sidecar.exe' : 'lrc-sidecar')),
  '下载的文件必须删除',
);

// ── 4) 正确哈希：下载通过校验 ─────────────────────────
console.log('=== 4) 正确哈希：校验通过 ===');
const goodHashRuntime = new LrcRuntime({
  cacheDir: join(workDir, 'd'),
  mirror: fileUrl,
  manifest: {
    [`${process.platform}-${process.arch}`]: { file: 'lrc-sidecar.exe', sha256: fakeHash },
  },
  probeLocal: false,
  healthTimeoutMs: 1500,
});
const good = await goodHashRuntime.ensure();
// 假二进制启动不起来，所以最终仍是 degraded —— 但原因必须是"启动失败"而不是"校验失败"
check('校验通过后进入启动阶段', (good.reason ?? '').includes('启动失败'), good.reason);
check(
  '校验通过的二进制被保留',
  existsSync(join(workDir, 'd', 'bin', process.platform === 'win32' ? 'lrc-sidecar.exe' : 'lrc-sidecar')),
  '校验通过的文件不应删除',
);
goodHashRuntime.stop();

await new Promise<void>((resolve) => fileServer.close(() => resolve()));
rmSync(workDir, { recursive: true, force: true });

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
