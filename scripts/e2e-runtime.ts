/**
 * 运行时管理的端到端测试。
 *
 * 用法：node scripts/e2e-runtime.ts
 *
 * 覆盖三种模式与一条安全红线：
 *   1. external —— 已有 LRC 时直接复用，不下载
 *   2. managed  —— 下载 + SHA256 校验通过后启动
 *   3. degraded —— 拿不到二进制 / 哈希不符时降级，**绝不运行未校验的二进制**
 *
 * 注意：v0.2.2 起二进制清单不再硬编码版本号，期望哈希从远端 `.sha256` 现取
 * （见 `runtime.ts` 的 `fetchRemoteDigest`），因此「manifest 为空」不再是失败条件。
 */
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LrcRuntime, extractSha256, BINARY_FILES, orderDigestSources, BUILTIN_SOURCES } from '../src/runtime.ts';

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

// ── 2) degraded：拿不到二进制 → 优雅降级 ─────────────
//
// ★ 语义已变更（v0.2.2）：清单不再强制要求——文件名有内置兜底
//   （`BINARY_FILES`），因此「manifest 为空」不再等于失败，而是正常走下载。
//   本用例改测真正的失败条件：所有源都拿不到该文件（用不存在的文件名模拟），
//   且本地无缓存 ⇒ 必须降级，而不是崩溃。
console.log('=== 2) degraded：拿不到二进制 ===');
const noBinary = new LrcRuntime({
  cacheDir: join(workDir, 'b'),
  probeLocal: false,
  healthTimeoutMs: 1000,
  // 固定哈希避免依赖远端 .sha256；文件名故意不存在 ⇒ 所有源都会 404
  manifest: {
    [`${process.platform}-${process.arch}`]: {
      file: 'definitely-not-a-real-lrc-binary.bin',
      sha256: '0'.repeat(64),
    },
  },
});
const degraded1 = await noBinary.ensure();
check('降级为 degraded', degraded1.mode === 'degraded', degraded1);
check('给出可读原因', (degraded1.reason ?? '').length > 0, degraded1.reason);

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

// ── 5) 版本自发现：从远端 .sha256 取指纹，哈希变即重下 ──────────
//
// 锁住两条不变量（v0.2.2 去版本硬编码后的核心）：
//   a) 期望哈希来自远端 `.sha256`，代码里**不存任何版本号**；
//   b) 远端哈希变化 ⇒ 本地缓存被判过期 ⇒ 自动重下，无需插件升级。
//
// 用本地 HTTP 服务器模拟"发新版"：先发 A 版，再换成 B 版内容与哈希。
console.log('=== 5) 版本自发现：哈希变即重下 ===');

// 两个 .sha256 文本格式都要能解析（CI 真实产出两种：sha256sum / certutil）
const sumStyle = `${fakeHash}  lrc-sidecar.exe`;
const certutilStyle =
  `SHA256 hash of lrc-sidecar.exe:\r\n${fakeHash}\r\n` +
  'CertUtil: -hashfile command completed successfully.\r\n';
check('解析 sha256sum 格式', extractSha256(sumStyle) === fakeHash, extractSha256(sumStyle));
check('解析 certutil 格式', extractSha256(certutilStyle) === fakeHash, extractSha256(certutilStyle));
check('无哈希内容返回 null', extractSha256('no hash here') === null);

// 内置稳定文件名必须不含版本号——否则又回到"LRC 发版插件就 404"
const versioned = Object.entries(BINARY_FILES).filter(([, f]) => /\d+\.\d+\.\d+/.test(f));
check('稳定文件名不含版本号', versioned.length === 0, versioned);

// A 版 → 写入
const verBinA = Buffer.from('AAAA-binary-v1');
const hashA = createHash('sha256').update(verBinA).digest('hex');
// B 版 → 模拟 LRC 发新版
const verBinB = Buffer.from('BBBB-binary-v2-different');
const hashB = createHash('sha256').update(verBinB).digest('hex');

let currentBin = verBinA;
let currentHash = hashA;
let downloadCount = 0;
const verServer = createServer((req, res) => {
  if (req.url?.endsWith('.sha256')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`${currentHash}  lrc-sidecar.exe`);
    return;
  }
  if (req.url?.endsWith('lrc-sidecar') || req.url?.endsWith('.exe')) {
    downloadCount += 1;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(currentBin);
    return;
  }
  send(res, 404, {});
});
await new Promise<void>((resolve) => verServer.listen(0, '127.0.0.1', resolve));
const verAddr = verServer.address();
if (verAddr === null || typeof verAddr === 'string') throw new Error('端口获取失败');
const verUrl = `http://127.0.0.1:${verAddr.port}`;
const verCache = join(workDir, 'e');
const rmBin = () => join(verCache, 'bin', process.platform === 'win32' ? 'lrc-sidecar.exe' : 'lrc-sidecar');

// 第一次：拉到 A 版（不注入 manifest ⇒ 哈希来自远端 .sha256）
// 注：本组要验证"每次启动都重新比对指纹"，故关掉复用窗口（recheckAfterMs=0）——
// 线上默认 1 小时，见 runtime.ts 的说明。
const verOpts = { cacheDir: verCache, mirror: verUrl, probeLocal: false, healthTimeoutMs: 800, recheckAfterMs: 0 };
const v1 = new LrcRuntime(verOpts);
await v1.ensure();
v1.stop();
check('首次按远端哈希下载', downloadCount === 1, `downloads=${downloadCount}`);
check('缓存内容为 A 版', readFileSync(rmBin()).toString() === verBinA.toString(), '内容不符');

// 第二次：哈希未变 ⇒ 复用，不应再下载
const v2 = new LrcRuntime(verOpts);
await v2.ensure();
v2.stop();
check('哈希未变时复用（不重复下载）', downloadCount === 1, `downloads=${downloadCount}`);

// 第三次：远端换成 B 版 ⇒ 必须自动重下
currentBin = verBinB;
currentHash = hashB;
const v3 = new LrcRuntime(verOpts);
await v3.ensure();
v3.stop();
check('远端发新版后自动重下', downloadCount === 2, `downloads=${downloadCount}`);
check('缓存已更新为 B 版', readFileSync(rmBin()).toString() === verBinB.toString(), '内容未更新');

await new Promise<void>((resolve) => verServer.close(() => resolve()));

// ── 6) 镜像滞后：版本仍按真源判定，且能自动绕过落后镜像 ─────────────
//
// 现实约束：国内镜像靠人工同步，LRC 发版后会滞后。若"第一个能连上的源"决定版本，
// 用户会被永久钉在旧版上且毫无提示。这里锁住三条：
//   a) 查指纹时真源排在镜像之前（顺序不因"下载要快"而被镜像抢占）；
//   b) 指纹取真源；
//   c) 镜像内容与真源指纹不符 ⇒ 判为"镜像落后"并继续换源，而不是当成篡改直接失败。
console.log('=== 6) 镜像滞后：按真源判版本并绕过落后镜像 ===');

// a) 顺序：显式源 > 真源 > 镜像
{
  const ordered = orderDigestSources(['http://explicit.local'], BUILTIN_SOURCES);
  const mirrorIdx = ordered.indexOf('https://sfang.cc/xd/downloads');
  const ghIdx = ordered.indexOf(
    'https://github.com/zhibaiYingChuan/LRC/releases/latest/download',
  );
  check('显式源排第一', ordered[0] === 'http://explicit.local', ordered);
  check('真源排在镜像之前', ghIdx !== -1 && mirrorIdx !== -1 && ghIdx < mirrorIdx, ordered);
}

// b)+c) 真源给新指纹、镜像给旧内容 ⇒ 必须跳过镜像并成功落到真源
const freshBin = Buffer.from('FRESH-binary-latest');
const freshHash = createHash('sha256').update(freshBin).digest('hex');
const staleBin = Buffer.from('STALE-binary-previous-release');

let staleHits = 0;
let freshHits = 0;
function makeBinServer(kind: 'fresh' | 'stale'): ReturnType<typeof createServer> {
  return createServer((req, res) => {
    if (req.url?.endsWith('.sha256')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`${kind === 'fresh' ? freshHash : 'f'.repeat(64)}  lrc-sidecar.exe`);
      return;
    }
    if (kind === 'fresh') freshHits += 1;
    else staleHits += 1;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(kind === 'fresh' ? freshBin : staleBin);
  });
}
const staleServer = makeBinServer('stale');
const freshServer = makeBinServer('fresh');
await new Promise<void>((r) => staleServer.listen(0, '127.0.0.1', r));
await new Promise<void>((r) => freshServer.listen(0, '127.0.0.1', r));
const staleAddr = staleServer.address();
const freshAddr = freshServer.address();
if (staleAddr === null || typeof staleAddr === 'string') throw new Error('端口获取失败');
if (freshAddr === null || typeof freshAddr === 'string') throw new Error('端口获取失败');
const staleUrl = `http://127.0.0.1:${staleAddr.port}`;
const freshUrl = `http://127.0.0.1:${freshAddr.port}`;
const lagCache = join(workDir, 'f');
const rmBinFor = (cache: string) =>
  join(cache, 'bin', process.platform === 'win32' ? 'lrc-sidecar.exe' : 'lrc-sidecar');

// 源表与线上同构：滞后镜像排第一（下载快），真源第二（版本准）
const lagging = new LrcRuntime({
  cacheDir: lagCache,
  probeLocal: false,
  healthTimeoutMs: 800,
  builtinSources: [
    { url: staleUrl, authoritative: false },
    { url: freshUrl, authoritative: true },
  ],
});
await lagging.ensure();
lagging.stop();
check(
  '落后镜像不会把插件钉在旧版（缓存为真源版本）',
  readFileSync(rmBinFor(lagCache)).toString() === freshBin.toString(),
  '内容应为真源版本',
);
check('确实先试过落后镜像', staleHits >= 1, `stale=${staleHits}`);
check('跳过落后镜像后仍从真源下载成功', freshHits >= 1, `fresh=${freshHits}`);

// 极简延迟复用：本地完好且刚查过远端 ⇒ 不再打扰真源（国内用户启动不必等境外超时）
const reuseCache = join(workDir, 'g');
let reuseQueries = 0;
const reuseServer = createServer((req, res) => {
  if (req.url?.endsWith('.sha256')) {
    reuseQueries += 1;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`${createHash('sha256').update(freshBin).digest('hex')}  lrc-sidecar.exe`);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  res.end(freshBin);
});
await new Promise<void>((r) => reuseServer.listen(0, '127.0.0.1', r));
const reuseAddr = reuseServer.address();
if (reuseAddr === null || typeof reuseAddr === 'string') throw new Error('端口获取失败');
const reuseUrl = `http://127.0.0.1:${reuseAddr.port}`;

for (let i = 0; i < 2; i += 1) {
  const rt = new LrcRuntime({
    cacheDir: reuseCache,
    mirrors: [reuseUrl],
    probeLocal: false,
    healthTimeoutMs: 500,
  });
  await rt.ensure();
  rt.stop();
}
check('复用期内不重复询问版本', reuseQueries === 1, `queries=${reuseQueries}`);

// 窗口必须**续期**：否则只省一次，之后每次启动都还去连境外，等于没做
const { utimesSync } = await import('node:fs');
const stampFile = join(reuseCache, 'bin', `${process.platform === 'win32' ? 'lrc-sidecar.exe' : 'lrc-sidecar'}.version`);
const old = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 小时前 ⇒ 已过默认窗口
utimesSync(stampFile, old, old);
{
  const rt = new LrcRuntime({
    cacheDir: reuseCache,
    mirrors: [reuseUrl],
    probeLocal: false,
    healthTimeoutMs: 500,
  });
  await rt.ensure();
  rt.stop();
}
check('过期后重新确认版本', reuseQueries === 2, `queries=${reuseQueries}`);
{
  const rt = new LrcRuntime({
    cacheDir: reuseCache,
    mirrors: [reuseUrl],
    probeLocal: false,
    healthTimeoutMs: 500,
  });
  await rt.ensure();
  rt.stop();
}
check('确认后窗口已续期（下次不再查询）', reuseQueries === 2, `queries=${reuseQueries}`);

// 关掉复用后必须重新查询
const recheckRt = new LrcRuntime({
  cacheDir: reuseCache,
  mirrors: [reuseUrl],
  probeLocal: false,
  healthTimeoutMs: 500,
  recheckAfterMs: 0,
});
await recheckRt.ensure();
recheckRt.stop();
check('recheckAfterMs=0 时每次都查', reuseQueries === 3, `queries=${reuseQueries}`);
await new Promise<void>((resolve) => reuseServer.close(() => resolve()));

await new Promise<void>((resolve) => staleServer.close(() => resolve()));
await new Promise<void>((resolve) => freshServer.close(() => resolve()));

await new Promise<void>((resolve) => fileServer.close(() => resolve()));
rmSync(workDir, { recursive: true, force: true });

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
