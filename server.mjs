// スタンドアロン起動用のCLI。DSHのプラグイン（bundle/index.js）から自動起動するので、
// 通常はこのファイルを手で実行する必要はない。
//
//   node server.mjs            # http://127.0.0.1:50071/api/usage
//   PORT=... node server.mjs

import { startUsageServer } from "./src/usage-server.mjs";

const port = Number(process.env.PORT ?? 50071);
const server = await startUsageServer(port);
if (!server) {
  console.error(`usage server: port ${port} is already in use (an instance may already be running)`);
  process.exit(0); // 既存インスタンスがあるなら正常とみなす
}
console.log(`usage server: http://127.0.0.1:${port}/api/usage`);
