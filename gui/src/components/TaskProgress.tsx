import { useEffect, useRef, useState } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { api, b64ToBytes, onEvent } from '../lib/api';
import { jobPrompt, outputLines, type JobPrompt } from '../lib/taskProtocol';
import { exitPhase, taskResults, taskPhaseLabel, type TaskPhase } from '../lib/taskResults';

interface Props {
  program: string;
  args: string[];
  runToken: number;
  stopToken?: number;
  registerSession?: (id: string | null) => void;
  onOutput?: (tail: string) => void;
  onInputSubmit?: () => void;
  onAttention?: () => void;
  onPhaseChange?: (phase: TaskPhase) => void;
  onExit?: (code: number) => void;
}

export default function TaskProgress(props: Props) {
  const callbacks = useRef(props);
  callbacks.current = props;
  const session = useRef<string | null>(null);
  const tail = useRef('');
  const transcript = useRef('');
  const truncated = useRef(false);
  const busy = useRef(false);
  const ended = useRef(false);
  const cancelled = useRef(false);
  const ready = useRef(false);
  const lastStop = useRef(0);
  const stopGeneration = useRef(0);
  const outputGeneration = useRef(0);
  const [lines, setLines] = useState<string[]>([]);
  const [prompt, setPrompt] = useState<JobPrompt | null>(null);
  const [password, setPassword] = useState('');
  const [sending, setSending] = useState(false);
  const [code, setCode] = useState<number | null>(null);
  const [phase, setPhase] = useState<TaskPhase>('running');
  const [error, setError] = useState('');
  const [outputIncomplete, setOutputIncomplete] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const lastOutput = useRef(Date.now());
  const input = useRef<HTMLInputElement>(null);
  const results = taskResults(transcript.current);

  const publishPhase = (next: TaskPhase) => {
    setPhase(next);
    callbacks.current.onPhaseChange?.(next);
  };
  const sendStop = async (requestedSession: string, generation: number) => {
    try { await api.ptyWrite(requestedSession, btoa('\x03')); }
    catch (e) {
      if (ended.current || session.current !== requestedSession || stopGeneration.current !== generation) return;
      cancelled.current = false;
      setError(`停止失败：${String(e)}。可重试停止，或关闭任务以结束会话。`);
      publishPhase('running');
    }
  };
  const stop = async () => {
    if (!session.current || ended.current || cancelled.current) return;
    cancelled.current = true;
    const generation = ++stopGeneration.current;
    setPassword(''); setPrompt(null);
    callbacks.current.onInputSubmit?.();
    publishPhase('stopping');
    if (!ready.current) return; // Send as soon as the asynchronous spawn finishes.
    await sendStop(session.current, generation);
  };

  useEffect(() => { if (prompt?.kind === 'password') input.current?.focus(); }, [prompt?.kind]);
  useEffect(() => {
    const requested = props.stopToken ?? 0;
    if (requested <= lastStop.current) return;
    lastStop.current = requested;
    void stop();
  }, [props.stopToken]);

  useEffect(() => {
    let disposed = false;
    const listeners: UnlistenFn[] = [];
    const id = crypto.randomUUID();
    session.current = id;
    ended.current = false; cancelled.current = false; ready.current = false;
    stopGeneration.current = 0; outputGeneration.current = 0;
    tail.current = ''; transcript.current = ''; truncated.current = false;
    lastOutput.current = Date.now();
    const decoder = new TextDecoder();
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (ended.current) return;
      setElapsed(Math.floor((Date.now() - started) / 1000));
      setStalled(Date.now() - lastOutput.current > 30000);
    }, 1000);
    const finish = (exit: number) => {
      if (disposed || ended.current) return;
      ended.current = true;
      setCode(exit); setPrompt(null); setPassword('');
      publishPhase(exitPhase(exit, cancelled.current, taskResults(transcript.current)));
      callbacks.current.onInputSubmit?.();
      callbacks.current.onExit?.(exit);
    };
    void (async () => {
      try {
        const data = await onEvent<{ id: string; data: string }>('pty-data', event => {
          if (disposed || ended.current || event.id !== id) return;
          outputGeneration.current++;
          lastOutput.current = Date.now(); setStalled(false);
          const chunk = decoder.decode(b64ToBytes(event.data), { stream: true });
          tail.current = (tail.current + chunk).slice(-120000);
          const nextTranscript = transcript.current + chunk;
          if (nextTranscript.length > 240000) truncated.current = true;
          transcript.current = nextTranscript.slice(-240000);
          setLines(outputLines(transcript.current));
          const next = cancelled.current ? null : jobPrompt(tail.current);
          setPrompt(next);
          if (!cancelled.current) publishPhase(next ? 'waiting' : 'running');
          if (!cancelled.current) callbacks.current.onOutput?.(tail.current.slice(-600));
          if (next) callbacks.current.onAttention?.();
        });
        if (disposed) { data(); return; }
        listeners.push(data);
        const exit = await onEvent<{ id: string; code: number; outputComplete?: boolean }>('pty-exit', event => {
          if (event.id === id) { if (event.outputComplete === false) setOutputIncomplete(true); finish(event.code); }
        });
        if (disposed) { exit(); return; }
        listeners.push(exit);
        const errorListener = await onEvent<{ id: string; error: string }>('pty-error', event => {
          if (!disposed && event.id === id) setError(event.error);
        });
        if (disposed) { errorListener(); return; }
        listeners.push(errorListener);
        await api.ptyStart(id, props.program, props.args, 160, 40);
        if (disposed) { await api.ptyKill(id); return; }
        ready.current = true;
        callbacks.current.registerSession?.(id);
        if (cancelled.current && !ended.current) await sendStop(id, stopGeneration.current);
      } catch (e) {
        if (!disposed && !ended.current) { setError(String(e)); finish(-1); }
      }
    })();
    return () => {
      disposed = true;
      window.clearInterval(timer);
      listeners.forEach(fn => fn());
      callbacks.current.registerSession?.(null);
      session.current = null;
      void api.ptyKill(id).catch(() => {});
    };
  }, [props.runToken]);

  const answer = async (value: string, cancel = false) => {
    if (!session.current || busy.current || ended.current || !prompt) return;
    busy.current = true; setSending(true); setError('');
    const requestedSession = session.current;
    const previousCancelled = cancelled.current;
    if (cancel) { cancelled.current = true; stopGeneration.current++; publishPhase('stopping'); }
    const generation = stopGeneration.current;
    const outputBeforeWrite = outputGeneration.current;
    const previous = tail.current;
    tail.current = ''; // Recognize the next prompt only from new output.
    setPrompt(null); setPassword('');
    callbacks.current.onInputSubmit?.();
    try {
      if (prompt.kind === 'password') await api.ptyWriteSecret(requestedSession, value);
      else {
        const bytes = new TextEncoder().encode(value);
        await api.ptyWrite(requestedSession, btoa(Array.from(bytes, b => String.fromCharCode(b)).join('')));
      }
      if (ended.current || session.current !== requestedSession) return;
      // The engine can emit its next prompt before the input call resolves.
      publishPhase(cancelled.current ? 'stopping' : jobPrompt(tail.current) ? 'waiting' : 'running');
    } catch (e) {
      if (ended.current || session.current !== requestedSession || stopGeneration.current !== generation) return;
      cancelled.current = previousCancelled;
      const next = outputGeneration.current === outputBeforeWrite ? prompt : jobPrompt(tail.current);
      if (outputGeneration.current === outputBeforeWrite) tail.current = previous;
      setPrompt(next); setError(String(e));
      publishPhase(cancelled.current ? 'stopping' : next ? 'waiting' : 'running');
    } finally { if (session.current === requestedSession) { busy.current = false; setSending(false); } }
  };

  const icon = phase === 'cancelled' ? '—' : phase === 'failed' || phase === 'review' ? '!' : phase === 'completed' ? '✓' : phase === 'waiting' ? '○' : '';
  return <div className="job-progress">
    <div className={`job-status phase-${phase}`} role="status">
      <span className={phase === 'running' || phase === 'stopping' ? 'spin' : 'job-status-icon'} aria-hidden="true">{icon}</span>
      <div><strong>{taskPhaseLabel[phase]}</strong><p>{code !== null
        ? phase === 'cancelled' ? '已停止后续步骤；取消前完成的操作仍然保留。'
          : code === 0 ? '以下为引擎明确报告的结果。未提供结果的项目不会自动计为成功。'
            : `退出码 ${code}。查看详情后可从原页面重新发起。`
        : phase === 'stopping' ? '已请求停止，正在等待引擎退出。'
          : prompt ? prompt.title : '可切换页面，任务会持续在后台运行。'}</p></div>
      <span className="badge dim">{Math.floor(elapsed / 60)} 分 {elapsed % 60} 秒</span>
    </div>
    {error && <div className="error-box" role="alert">{error}</div>}
    {prompt && <section className="job-prompt" aria-label={prompt.title}>
      <h3>{prompt.title}</h3><p>{prompt.detail}</p>
      {prompt.kind === 'password' ? <form className="job-actions" onSubmit={event => {
        event.preventDefault(); if (password) void answer(password);
      }}>
        <input ref={input} className="text" type="password" aria-label="Mac 登录密码" autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} />
        <button className="btn primary" disabled={!password || sending}>授权</button>
        <button type="button" className="btn" disabled={sending} onClick={() => void stop()}>取消授权</button>
      </form> : <div className="job-actions">{prompt.choices.map((choice, index) => <button
        key={choice.label} className={`btn ${index === 0 ? 'primary' : ''}`} disabled={sending}
        onClick={() => void answer(choice.value, choice.cancel)}>{choice.label}</button>)}</div>}
    </section>}
    {stalled && code === null && !prompt && <p className="note">引擎暂时没有新消息，可能仍在处理。长时间无进展时可停止任务；未知提示不会自动确认。</p>}
    {code !== null && <section className="task-results" aria-label="执行结果摘要">
      {results.metrics.length > 0 && <div className="result-metrics">{results.metrics.map(metric => <div key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong></div>)}</div>}
      <div className="result-groups">{([
        ['completed', '完成记录'], ['skipped', '已跳过或保留'], ['failed', '失败提示'], ['review', '需要查看'],
      ] as const).map(([key, label]) => results[key].length > 0 && <details key={key} className={`result-group ${key}`} open={key === 'failed' || key === 'review'}>
        <summary>{label}<span>{results[key].length} 条</span></summary>
        <ul>{results[key].map(line => <li key={line}>{line}</li>)}</ul>
      </details>)}</div>
      {results.metrics.length === 0 && !results.completed.length && !results.skipped.length && !results.failed.length && !results.review.length
        && <p className="note">引擎未提供可识别的结果摘要，请查看执行详情。</p>}
      {outputIncomplete && <p className="note">引擎输出未完整接收，以上摘要可能不完整；请核对实际结果。</p>}
      {truncated.current && <p className="note">日志较长，当前保留最近输出；摘要仅覆盖这些记录。</p>}
    </section>}
    {code === null && <div className="job-activity" aria-label={prompt ? '本次操作范围与提示' : '执行动态'}>{(prompt ? lines : lines.slice(-5)).map((line, index) => <div key={index}>{line}</div>)}</div>}
    <details className="job-log"><summary>查看执行详情（{lines.length} 行）</summary><pre>{lines.join('\n') || '正在启动引擎…'}</pre></details>
  </div>;
}
