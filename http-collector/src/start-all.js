// 同时启动源站与采集站（两个独立 HTTP 服务，便于观察真实上游请求）
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function start(name, file) {
  const child = spawn(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
  child.on('exit', (code) => {
    console.log(`[start-all] ${name} 退出，code=${code}`);
    process.exit(code ?? 0);
  });
  return child;
}

const origin = start('origin', 'origin.js');
const collector = start('collector', 'collector.js');

process.on('SIGINT', () => {
  origin.kill('SIGINT');
  collector.kill('SIGINT');
  setTimeout(() => process.exit(0), 200);
});
