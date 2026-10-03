import { isPasswordPrompt } from './terminalPrompt';

export type JobPrompt = { kind: 'password' | 'choice'; title: string; detail: string; choices: { label: string; value: string; cancel?: boolean }[] };
export function plainOutput(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[()][A-Z0-9]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}
// Match only the current, unterminated prompt. Never answer from old log text.
// Every choice requires a click; no generic automatic y/Enter responses.
export function jobPrompt(output: string): JobPrompt | null {
  const line = plainOutput(output).trimEnd().split(/[\r\n]/).pop() ?? '';
  if (isPasswordPrompt(line)) return { kind: 'password', title: '需要管理员授权', detail: '输入 Mac 登录密码，或完成系统弹出的 Touch ID 验证。密码不会保存。', choices: [] };
  if (/System caches need sudo\.\s*Enter continue,\s*Space skip:\s*$/.test(line)) return {
    kind: 'choice', title: '是否包含系统缓存？', detail: '包含系统缓存需要管理员授权；跳过后仍会清理用户范围内的内容。', choices: [{ label: '授权并继续', value: '\r' }, { label: '跳过系统缓存', value: ' ' }],
  };
  if (/Proceed with uninstallation\? \[y\/N\]\s*$/.test(line)) return {
    kind: 'choice', title: '核对匹配的应用', detail: '请核对下方引擎匹配结果，继续后将扫描关联文件。', choices: [{ label: '扫描关联文件', value: 'y\r' }, { label: '取消卸载', value: 'n\r', cancel: true }],
  };
  if (/Remove \d+ apps?.*Enter confirm,\s*ESC cancel:\s*$/.test(line)) return {
    kind: 'choice', title: '确认卸载范围', detail: '请核对应用及关联文件。标记 Review only 的项目不会自动删除；正在运行的所选应用可能被退出。', choices: [{ label: '确认卸载', value: '\r' }, { label: '取消卸载', value: '\x1b', cancel: true }],
  };
  if (/\[(?:y\/n|n\/y)\]\s*[:?]?\s*$/i.test(line)) return { kind: 'choice', title: '需要你的确认', detail: line, choices: [{ label: '确认', value: 'y\r' }, { label: '拒绝', value: 'n\r' }] };
  if (/Press Enter to continue:\s*$/.test(line)) return { kind: 'choice', title: '继续下一步', detail: '请先阅读下方提示，再继续。', choices: [{ label: '继续', value: '\r' }] };
  return null;
}
export function outputLines(output: string): string[] {
  return plainOutput(output).split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
}
