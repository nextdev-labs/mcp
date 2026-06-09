(async()=>{
  const target = 'http://localhost:3000/api/mcp';
  const fetch = global.fetch;
  if (!fetch) {
    console.error('Node fetch not available');
    process.exit(1);
  }

  console.log('Running oversized payload test...');
  try {
    const big = 'x'.repeat(6 * 1024 * 1024);
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 'big', method: 'tools/list', big });
    const r = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
    console.log('oversized status', r.status);
    console.log('oversized text', await r.text());
  } catch (e) {
    console.log('oversized error', e.message || e);
  }

  console.log('\nRunning rate limit flood (60 concurrent requests)...');
  const N = 60;
  const promises = [];
  for (let i = 0; i < N; i++) {
    promises.push(
      fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/list' }) })
        .then(async (r) => ({ status: r.status, body: await r.text() }))
        .catch((e) => ({ error: e.message }))
    );
  }
  const results = await Promise.all(promises);
  const summary = results.reduce((acc, r) => {
    const key = r.status ? String(r.status) : `err:${r.error}`;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  console.log('summary', summary);
  console.log('sample', results.slice(0, 6));
})();
