import { useEffect, useRef, useState } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { api, b64ToBytes, onEvent } from '../lib/api';
import { jobPrompt, outputLines, type JobPrompt } from '../lib/taskProtocol';

interface Props {
  program: string; args: string[]; runToken: number;
  registerSession?: (id: string | null) => void;
  onOutput?: (tail: string) => void;
  onInputSubmit?: () => void;
  onAttention?: () => void;
  onExit?: (code: number) => void;
}
export default function TaskProgress(props: Props) {
  const callbacks = useRef(props); callbacks.current = props;
  const session = useRef<string | null>(null);
  const tail = useRef('');
  const transcript = useRef('');
  const busy = useRef(false);
  const ended = useRef(false);
  const cancelled = useRef(false);
  const [lines, setLines] = useState<string[]>([]);
  const [prompt, setPrompt] = useState<JobPrompt | null>(null);
  const [password, setPassword] = useState('');
  const [sending, setSending] = useState(false);
  const [code, setCode] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [stalled, setStalled] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const lastOutput = useRef(Date.now());
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (prompt?.kind === 'password') input.current?.focus(); }, [prompt?.kind]);
  useEffect(() => {
    let disposed = false;
    const listeners: UnlistenFn[] = [];
    const id = crypto.randomUUID();
    session.current = id; ended.current = false; tail.current = '';
    const decoder = new TextDecoder();
    const start = Date.now();
    const timer = window.setInterval(() => {
      if (ended.current) return;
      setElapsed(Math.floor((Date.now() - start) / 1000));
      setStalled(Date.now() - lastOutput.current > 30000);
    }, 1000);
    const finish = (exit: number) => {
      if (disposed || ended.current) return;
      ended.current = true; setCode(exit); setPrompt(null); setPassword('');
      callbacks.current.onInputSubmit?.(); callbacks.current.onExit?.(exit);
    };
    (async () => {
      try {
        const data = await onEvent<{id: string; data: string}>('pty-data', p => {
          if (disposed || ended.current || p.id !== id) return;
          lastOutput.current = Date.now(); setStalled(false);
          const chunk = decoder.decode(b64ToBytes(p.data), {stream: true});
          tail.current = (tail.current + chunk).slice(-120000);
          transcript.current = (transcript.current + chunk).slice(-240000);
          setLines(outputLines(transcript.current));
          const next = jobPrompt(tail.current);
          setPrompt(next);
          callbacks.current.onOutput?.(tail.current.slice(-600));
          if (next) callbacks.current.onAttention?.();
        });
        if (disposed) { data(); return; } listeners.push(data);
        const exit = await onEvent<{id: string; code: number}>('pty-exit', p => { if (p.id === id) finish(p.code); });
        if (disposed) { exit(); return; } listeners.push(exit);
        await api.ptyStart(id, props.program, props.args, 160, 40);
        if (disposed) { await api.ptyKill(id); return; }
        callbacks.current.registerSession?.(id);
      } catch (e) { if (!disposed) { setError(String(e)); finish(-1); } }
    })();
    return () => {
      disposed = true; window.clearInterval(timer); listeners.forEach(fn => fn());
      callbacks.current.registerSession?.(null); session.current = null;
      void api.ptyKill(id).catch(() => {});
    };
  }, [props.runToken]);
  const answer = async (value: string, cancel = false) => {
    if (!session.current || busy.current || ended.current || !prompt) return;
    busy.current = true; setSending(true); setError('');
    const previous = tail.current;
    tail.current = ''; // New prompts must be identified from new output only.
    setPrompt(null); setPassword(''); callbacks.current.onInputSubmit?.();
    try {
      if (prompt.kind === 'password') await api.ptyWriteSecret(session.current, value);
      else {
        const bytes = new TextEncoder().encode(value);
        await api.ptyWrite(session.current, btoa(Array.from(bytes, b => String.fromCharCode(b)).join('')));
      }
      if (cancel) cancelled.current = true;
    } catch (e) { tail.current = previous + tail.current; setPrompt(prompt); setError(String(e)); }
    finally { busy.current = false; setSending(false); }
  };
  const status = code !== null ? (cancelled.current ? '已取消' : code === 0 ? '任务已结束' : '任务未完成') : prompt ? '等待你的操作' : '正在处理';
  return <div className="job-progress">
    <div className="job-status" role="status"><span className={code === null && !prompt ? 'spin' : 'job-status-icon'}>{code !== null ? (code === 0 ? '✓' : '!') : prompt ? '○' : ''}</span><div><strong>{status}</strong><p>{code !== null ? (code === 0 ? '请查看下方执行结果；被保护或跳过的项目会由引擎保留。' : `退出码 ${code}。查看详情后可从原页面重新发起。`) : prompt ? prompt.title : '可切换页面，任务会持续在后台运行。'}</p></div><span className="badge dim">{Math.floor(elapsed / 60)} 分 {elapsed % 60} 秒</span></div>
    {error && <div className="error-box" role="alert">{error}</div>}
    {prompt && <section className="job-prompt" aria-label={prompt.title}><h3>{prompt.title}</h3><p>{prompt.detail}</p>
      {prompt.kind === 'password' ? <form className="job-actions" onSubmit={e => {e.preventDefault(); if (password) void answer(password);}}><input ref={input} className="text" type="password" aria-label="Mac 登录密码" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} /><button className="btn primary" disabled={!password || sending}>授权</button><button type="button" className="btn" onClick={() => {cancelled.current = true; setPassword(''); if(session.current) void api.ptyWrite(session.current, btoa('\x03'));}}>取消授权</button></form> : <div className="job-actions">{prompt.choices.map((choice, i) => <button key={choice.label} className={`btn ${i === 0 ? 'primary' : ''}`} disabled={sending} onClick={() => void answer(choice.value, choice.cancel)}>{choice.label}</button>)}</div>}
    </section>}
    {stalled && code === null && !prompt && <p className="note">引擎暂时没有新消息，可能仍在处理。若系统未弹出授权窗口且长时间无进展，可停止任务并查看日志；未知提示不会自动确认。</p>}
    <div className="job-activity" aria-label={prompt ? '本次操作范围与提示' : '执行动态'}>{(prompt ? lines : lines.slice(-5)).map((line, i) => <div key={i}>{line}</div>)}</div>
    <details className="job-log"><summary>查看执行详情（{lines.length} 行）</summary><pre>{lines.join('\n') || '正在启动引擎…'}</pre></details>
  </div>;
}
