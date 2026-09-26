/**
 * JavaScript prepended to the fake `pi --mode rpc` scripts that tests start in
 * place of Pi. It answers commands, hands the first prompt's task to
 * `onTask(handler)`, and exits when stdin closes, as Pi does. A handler that
 * returns false rejects the prompt. `settle()` emits `agent_settled`; set
 * `globalThis.ignoreStdinEnd` to model a child that will not shut down.
 * `globalThis.onCommand(command)` sees every later command before its reply.
 */
export const FAKE_RPC = `
const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
const settle = () => out({ type: 'agent_settled' });
const received = [];
function onTask(handler) {
  let buffer = '', started = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const command = JSON.parse(line);
      received.push(command);
      if (command.type === 'prompt' && !started) {
        started = true;
        const ok = handler(command.message.replace(/^Task: /, '')) !== false;
        out({ id: command.id, type: 'response', command: 'prompt', success: ok, ...(ok ? {} : { error: 'prompt rejected' }) });
      } else if (command.type !== 'extension_ui_response') {
        globalThis.onCommand?.(command);
        out({ id: command.id, type: 'response', command: command.type, success: true });
      }
    }
  });
  process.stdin.on('end', () => {
    if (!globalThis.ignoreStdinEnd) process.exit(0);
  });
}
`;
