// Used only by provider_tests with an injected synthetic fixture.
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync(fixture.pidPath, String(process.pid));
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let sequence = 0;
const threads = new Map();
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  fs.appendFileSync(fixture.logPath, line + '\n');
  let result = {};
  const p = m.params || {};
  switch (m.method) {
    case 'account/read': result = { account: { type: 'chatgpt', email: 'synthetic@example.invalid', planType: 'pro' }, requiresOpenaiAuth: true }; break;
    case 'config/read': result = { config: { model_provider: 'openai' }, origins: {}, layers: null }; break;
    case 'configRequirements/read': result = { requirements: null }; break;
    case 'model/list': result = { data: [{ id: 'synthetic', model: 'synthetic-model', isDefault: true, inputModalities: ['text', 'image'] }], nextCursor: null }; break;
    case 'modelProvider/capabilities/read': result = { namespaceTools: true, imageGeneration: true, webSearch: false }; break;
    case 'thread/start': {
      const id = `thread-${++sequence}`;
      threads.set(id, p.cwd);
      const provider = fixture.threadProvider || 'openai';
      result = { thread: { id, modelProvider: provider }, modelProvider: provider, model: fixture.threadModel || 'synthetic-model' }; break;
    }
    case 'turn/start': {
      const id = `turn-${++sequence}`;
      emit({ id: m.id, result: { turn: { id } } });
      if (fixture.hold) return;
      for (const input of p.input.filter(i => i.type === 'localImage')) {
        if (!fs.readFileSync(input.path).subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw Error('bad actual image input');
      }
      if (p.input[0].text === fixture.textPrompt) {
        for (const asset of fixture.textAssets) {
          const bytes = fs.readFileSync(require('node:path').join(threads.get(p.threadId), asset.relativePath));
          if (require('node:crypto').createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw Error('actual text source differs from captured authority');
        }
      }
      const item = p.input[0].text === fixture.textPrompt
        ? { type: 'agentMessage', id: `text-${id}`, text: JSON.stringify(fixture.outline), phase: 'final_answer' }
        : { type: 'imageGeneration', id: `image-${id}`, status: 'completed', failure: null, result: fixture.png };
      emit({ method: 'item/completed', params: { threadId: p.threadId, turnId: id, item } });
      emit({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id, status: 'completed', items: [] } } });
      return;
    }
  }
  if (m.id !== undefined) emit({ id: m.id, result });
});
