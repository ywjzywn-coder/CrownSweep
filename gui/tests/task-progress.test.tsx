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
});
it('parses current ANSI prompts but ignores historical prompt text', () => {
  expect(jobPrompt('\x1b[32mPassword:\x1b[0m ')?.kind).toBe('password');
  expect(jobPrompt('Password:\r\nWorking')).toBeNull();
  expect(jobPrompt('Remove 2 apps, 22MB [Running]  Enter confirm, ESC cancel:')?.choices[0].label).toBe('确认卸载');
  expect(plainOutput('\x1b]0;title\x07hello')).toBe('hello');
});
