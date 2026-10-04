// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TaskProgress from '../src/components/TaskProgress';
import { jobPrompt, plainOutput } from '../src/lib/taskProtocol';
const bridge = vi.hoisted(() => ({ handlers: {} as Record<string, (p: any) => void>, start: vi.fn(async () => {}), write: vi.fn(async () => {}), secret: vi.fn(async () => {}), kill: vi.fn(async () => {}) }));
vi.mock('../src/lib/api', () => ({
  api: {ptyStart: bridge.start, ptyWrite: bridge.write, ptyWriteSecret: bridge.secret, ptyKill: bridge.kill},
  b64ToBytes: (data: string) => Uint8Array.from(atob(data), c => c.charCodeAt(0)),
  onEvent: async (event: string, fn: (p: any) => void) => {bridge.handlers[event] = fn; return () => {delete bridge.handlers[event];};},
}));
let root: Root, host: HTMLDivElement;
const done = vi.fn(), attention = vi.fn();
let id = '';
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  bridge.handlers = {}; bridge.start.mockClear(); bridge.write.mockClear(); bridge.secret.mockClear(); bridge.kill.mockClear(); done.mockClear(); attention.mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<TaskProgress program="fixture" args={[]} runToken={1} onExit={done} onAttention={attention}/>));
  id = bridge.start.mock.calls[0][0] as string;
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function output(s: string) {
  await act(async () => bridge.handlers['pty-data']({id, data: btoa(s)}));
}
async function click(label: string) {
  const b = [...host.querySelectorAll('button')].find(b => b.textContent === label);
  expect(b, label).toBeTruthy(); await act(async () => b!.click());
}
it('requires both uninstall confirmations and never writes until clicked', async () => {
  await output('Matched 1 app(s):\r\n1. Fixture App\r\nProceed with uninstallation? [y/');
  expect(bridge.write).not.toHaveBeenCalled();
  await output('N] '); await click('扫描关联文件');
  expect(atob(bridge.write.mock.calls[0][1])).toBe('y\r');
  await output('\r\n/Applications/Fixture.app\r\nRemove 1 app, 12MB  Enter confirm, ESC cancel: ');
  expect(host.textContent).toContain('/Applications/Fixture.app');
  expect(bridge.write).toHaveBeenCalledTimes(1);
  await click('确认卸载'); expect(atob(bridge.write.mock.calls[1][1])).toBe('\r');
  await output('\r\nRemoved Fixture App');
  await act(async () => bridge.handlers['pty-exit']({id, code: 0}));
  expect(done).toHaveBeenCalledWith(0); expect(host.textContent).toContain('任务已结束');
  expect(host.textContent).toContain('Matched 1 app(s)');
});
it('offers system cache skip and sends a single space, not Enter', async () => {
  await output('System caches need sudo. Enter continue, Space skip: ');
  await click('跳过系统缓存'); expect(atob(bridge.write.mock.calls[0][1])).toBe(' ');
});
it('uses the protected password endpoint, clears input, and supports retries', async () => {
  await output('Password:');
  const field = host.querySelector<HTMLInputElement>('input[type=password]')!;
  expect(field).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'fixture-secret');
    field.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
  expect(bridge.secret).toHaveBeenCalledWith(id, 'fixture-secret');
  expect(bridge.write).not.toHaveBeenCalled(); expect(host.textContent).not.toContain('fixture-secret');
  await output('\r\nSorry, try again.\r\nPassword:');
  expect(host.querySelector<HTMLInputElement>('input')!.value).toBe('');
});
it('does not answer unknown prompts or events for another session', async () => {
  await output('Choose something new:');
  await act(async () => bridge.handlers['pty-data']({id: 'other', data: btoa('Password:')}));
  expect(host.querySelector('input')).toBeNull(); expect(bridge.write).not.toHaveBeenCalled();
});
it('cancellation remains cancelled even when the engine exits zero', async () => {
  await output('Proceed with uninstallation? [y/N] '); await click('取消卸载');
  await act(async () => bridge.handlers['pty-exit']({id, code: 0}));
  expect(host.textContent).toContain('已取消');
  expect(host.querySelector('.job-status-icon')?.textContent).toBe('—');
});
it('parses current ANSI prompts but ignores historical prompt text', () => {
  expect(jobPrompt('\x1b[32mPassword:\x1b[0m ')?.kind).toBe('password');
  expect(jobPrompt('Password:\r\nWorking')).toBeNull();
  expect(jobPrompt('Remove 2 apps, 22MB [Running]  Enter confirm, ESC cancel:')?.choices[0].label).toBe('确认卸载');
  expect(plainOutput('\x1b]0;title\x07hello')).toBe('hello');
});

it('stops a running process and keeps cancellation when exit is zero', async () => {
  const phase = vi.fn();
  await act(async () => root.render(<TaskProgress program="fixture" args={[]} runToken={1} stopToken={1} onPhaseChange={phase} onExit={done}/>));
  expect(atob(bridge.write.mock.calls[0][1])).toBe('\x03');
  await output('Stopped');
  await act(async () => bridge.handlers['pty-exit']({id, code: 0}));
  expect(phase).toHaveBeenLastCalledWith('cancelled');
  expect(host.querySelector('.job-status-icon')?.textContent).toBe('—');
});

it('does not resurrect a cancelled task when exit arrives before write resolves', async () => {
  let resolveWrite!: () => void;
  bridge.write.mockImplementationOnce(() => new Promise<void>(resolve => { resolveWrite = resolve; }));
  await output('Proceed with uninstallation? [y/N] ');
  await click('取消卸载');
  await act(async () => bridge.handlers['pty-exit']({id, code: 0}));
  await act(async () => resolveWrite());
  expect(host.textContent).toContain('已取消');
  expect(host.textContent).not.toContain('正在停止');
});
it('preserves a completed task when an acknowledgement arrives after exit', async () => {
  let resolveWrite!: () => void;
  bridge.write.mockImplementationOnce(() => new Promise<void>(resolve => { resolveWrite = resolve; }));
  await output('Press Enter to continue:'); await click('继续');
  await act(async () => bridge.handlers['pty-exit']({id, code: 0}));
  await act(async () => resolveWrite());
  expect(host.textContent).toContain('任务已结束');
  expect(host.textContent).not.toContain('正在处理');
});
it('keeps the next confirmation waiting when it arrives before input resolves', async () => {
  let resolveWrite!: () => void;
  bridge.write.mockImplementationOnce(() => new Promise<void>(resolve => { resolveWrite = resolve; }));
  await output('Proceed with uninstallation? [y/N] ');
  await click('扫描关联文件');
  await output('Remove 1 app, 12MB Enter confirm, ESC cancel: ');
  await act(async () => resolveWrite());
  expect(host.textContent).toContain('确认卸载');
  expect(host.querySelector('.job-status')?.classList.contains('phase-waiting')).toBe(true);
});
it('keeps the terminal outcome when a stop request rejects after exit', async () => {
  let rejectWrite!: (error: Error) => void;
  bridge.write.mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectWrite = reject; }));
  await act(async () => root.render(<TaskProgress program="fixture" args={[]} runToken={1} stopToken={1} onExit={done}/>));
  await act(async () => bridge.handlers['pty-exit']({id, code: 0}));
  await act(async () => rejectWrite(new Error('session closed')));
  expect(host.textContent).toContain('已取消');
  expect(host.textContent).not.toContain('停止失败');
});
it('ignores a late password prompt after stopping', async () => {
  const onOutput = vi.fn();
  await act(async () => root.render(<TaskProgress program="fixture" args={[]} runToken={1} stopToken={1} onOutput={onOutput} onAttention={attention}/>));
  await output('Password:');
  expect(onOutput).not.toHaveBeenCalled(); expect(attention).not.toHaveBeenCalled();
  expect(host.querySelector('input[type=password]')).toBeNull();
  expect(host.textContent).toContain('正在停止');
});

it('keeps a live session active when deferred stop input fails after spawn', async () => {
  let resolveStart!: () => void;
  bridge.start.mockImplementationOnce(() => new Promise<void>(resolve => { resolveStart = resolve; }));
  bridge.write.mockRejectedValueOnce(new Error('write refused'));
  await act(async () => root.render(<TaskProgress program="fixture" args={[]} runToken={2} stopToken={0} onExit={done}/>));
  id = bridge.start.mock.calls[1][0] as string;
  await act(async () => root.render(<TaskProgress program="fixture" args={[]} runToken={2} stopToken={1} onExit={done}/>));
  await act(async () => resolveStart());
  expect(done).not.toHaveBeenCalled();
  expect(host.textContent).toContain('停止失败');
  expect(host.querySelector('.job-status')?.classList.contains('phase-running')).toBe(true);
  await output('Still running');
  expect(done).not.toHaveBeenCalled();
});
it('does not restore an old confirmation when its write rejects after a newer stop', async () => {
  let rejectWrite!: (error: Error) => void;
  bridge.write.mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectWrite = reject; }));
  await output('Proceed with uninstallation? [y/N] ');
  await click('扫描关联文件');
  await act(async () => root.render(<TaskProgress program="fixture" args={[]} runToken={1} stopToken={1} onExit={done}/>));
  await act(async () => rejectWrite(new Error('old write failed')));
  expect(host.textContent).toContain('正在停止');
  expect(host.querySelector('.job-prompt')).toBeNull();
  await act(async () => bridge.handlers['pty-exit']({id, code: 0}));
  expect(host.textContent).toContain('已取消');
});
it('does not restore the previous prompt when input rejects after newer output', async () => {
  let rejectWrite!: (error: Error) => void;
  bridge.write.mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectWrite = reject; }));
  await output('Proceed with uninstallation? [y/N] ');
  await click('扫描关联文件');
  await output('Remove 1 app, 12MB Enter confirm, ESC cancel: ');
  await act(async () => rejectWrite(new Error('old write failed')));
  expect(host.textContent).toContain('确认卸载');
  expect(host.querySelector('.job-prompt')?.textContent).not.toContain('扫描关联文件');
});
