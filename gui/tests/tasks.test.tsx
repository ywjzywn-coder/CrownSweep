// @vitest-environment jsdom
import React, { act, useEffect } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App, { useApp } from '../src/App';
import { isPasswordPrompt } from '../src/lib/terminalPrompt';

const sessions = vi.hoisted(() => ({ starts: vi.fn(), stops: vi.fn(), props: {} as Record<string, any> }));
vi.mock('../src/lib/api', () => ({ api: { engineDetect: async () => null, statusStop: async () => {} }, onEvent: async () => () => {} }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setFocus: async () => {} }) }));
vi.mock('../src/components/TaskProgress', () => ({ default: (props: any) => {
  sessions.props[props.program] = props;
  useEffect(() => { sessions.starts(props.program); return () => { sessions.stops(props.program); }; }, []);
  return <div>Session {props.program}</div>;
} }));
vi.mock('../src/views/Dashboard', () => ({ default: () => {
  const { openTask } = useApp();
  return <><button onClick={() => openTask({title:'任务 A', program:'A', args:[], tag:'A', mode:'background'})}>启动 A</button><button onClick={() => openTask({title:'任务 B', program:'B', args:[], tag:'B'})}>启动 B</button></>;
} }));
vi.mock('../src/views/Clean', () => ({default: () => <div>清理页</div>}));
vi.mock('../src/views/Uninstall', () => ({default: () => null}));
vi.mock('../src/views/Analyze', () => ({default: () => null}));
vi.mock('../src/views/Optimize', () => ({default: () => null}));
vi.mock('../src/views/History', () => ({default: () => null}));
vi.mock('../src/views/Settings', () => ({default: () => null}));
let root: Root, host: HTMLDivElement;
async function click(text: string) {
  const target = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text || b.getAttribute('aria-label') === text);
  expect(target, text).toBeTruthy();
  await act(async () => { target!.click(); });
}
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollTo = vi.fn();
  sessions.starts.mockClear(); sessions.stops.mockClear(); sessions.props = {};
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<App/>); });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
describe('persistent task drawer', () => {
  it('starts background tasks while hidden and never respawns on collapse/navigation/tab switch', async () => {
    await click('启动 A');
    expect(host.querySelector<HTMLElement>('.task-drawer-body')!.hidden).toBe(true);
    expect(sessions.starts.mock.calls).toEqual([['A']]);
    await click('展开任务面板'); await click('收起任务面板'); await click('展开任务面板');
    await click('启动 B'); await click('任务 A'); await click('任务 B');
    await click('空间清理'); await click('仪表盘');
    expect(sessions.starts.mock.calls).toEqual([['A'], ['B']]);
    expect(sessions.stops).not.toHaveBeenCalled();
    await act(async () => sessions.props.B.onExit(0));
    await click('收起任务面板'); await click('展开任务面板');
    expect(sessions.starts).toHaveBeenCalledTimes(2);
  });
  it('removes only the confirmed task and dismisses its dialog', async () => {
    await click('启动 A'); await click('启动 B'); await click('关闭');
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    await click('结束并关闭');
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(sessions.stops.mock.calls).toEqual([['B']]);
    expect(host.textContent).toContain('任务 A');
  });
  it('clears submitted password prompts and allows a later retry', async () => {
    await click('启动 A');
    await act(async () => sessions.props.A.onOutput('Password:'));
    expect(host.querySelector('.task-pill.warn')).not.toBeNull();
    await act(async () => sessions.props.A.onInputSubmit());
    expect(host.querySelector('.task-pill.warn')).toBeNull();
    await click('收起任务面板');
    await act(async () => sessions.props.A.onOutput('Sorry, try again.\r\nPassword:'));
    expect(host.querySelector<HTMLElement>('.task-drawer-body')!.hidden).toBe(false);
    await act(async () => sessions.props.A.onExit(1));
    expect(host.querySelector('.task-pill.warn')).toBeNull();
  });
});
it('detects current prompts, not past log messages', () => {
  expect(isPasswordPrompt('\x1b[31mPassword:\x1b[0m ')).toBe(true);
  expect(isPasswordPrompt('[sudo] password for user:')).toBe(true);
  expect(isPasswordPrompt('请输入密码：')).toBe(true);
  expect(isPasswordPrompt('Password:\r\nCleaning caches')).toBe(false);
  expect(isPasswordPrompt('No password required')).toBe(false);
});
