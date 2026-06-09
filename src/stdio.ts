import readline from 'node:readline';
import { dispatch } from './server.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

rl.on('line', async (line) => {
  if (!line || !line.trim()) return;
  try {
    const msg = JSON.parse(line);
    if (Array.isArray(msg)) {
      const responses = await Promise.all(msg.map((r) => dispatch(r)));
      process.stdout.write(JSON.stringify(responses) + '\n');
    } else {
      const resp = await dispatch(msg);
      process.stdout.write(JSON.stringify(resp) + '\n');
    }
  } catch (e) {
    // Parse error — respond with JSON-RPC parse error
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'
    );
  }
});

process.on('SIGINT', () => {
  rl.close();
  process.exit(0);
});
