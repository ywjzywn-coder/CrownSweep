/** Only the current output line can request input; old logs must not reopen the panel. */
export function isPasswordPrompt(tail: string): boolean {
  const plain = tail.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trimEnd();
  const line = plain.split(/[\r\n]/).pop() ?? "";
  return /(?:password(?: for [^:：]*)?|密码|口令)\s*[:：]\s*$/i.test(line);
}
