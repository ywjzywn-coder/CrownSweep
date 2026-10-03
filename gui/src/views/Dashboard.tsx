import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useApp } from "../App";
import Sparkline from "../components/Sparkline";
import Ring from "../components/Ring";
import { PageHeader, EngineNotice } from "../components/Page";
import { IconSparkles, IconPie, IconCpu, IconGlobe } from "../components/icons";
import { api, fmtBytes, fmtDuration } from "../lib/api";

interface SmcData {
  temps: { key: string; label: string; value: number }[];
  fans: { index: number; current: number; target: number; mode: string }[];
}
function Kv({ k, v }: { k: string; v: ReactNode }) {
  return <div className="kv"><span className="k">{k}</span><span className="v">{v ?? "—"}</span></div>;
}
const percent = (n: number | undefined) => n == null ? "—" : `${n.toFixed(1)}%`;
const rate = (n: number | undefined) => n == null ? "—" : `${fmtBytes(n * 1024 * 1024, 1)}/s`;
const barWidth = (n: number | undefined) => `${Math.max(0, Math.min(n ?? 0, 100))}%`;
const pressure = (n: number) => n >= 90 ? "crit" : n >= 75 ? "warn" : "";

export default function Dashboard() {
  const { snapshot: s, watchState, cpuHistory, memHistory, navigate } = useApp();
  const [smc, setSmc] = useState<SmcData | null>(null);
  const history = useRef({ temps: [] as number[], fan: [] as number[] });
  const [curves, setCurves] = useState(history.current);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const data = await api.smcRead();
        if (!alive) return;
        setSmc(data);
        const values = data.temps.map(t => t.value).filter(Number.isFinite);
        if (values.length) history.current.temps = [...history.current.temps, Math.max(...values)].slice(-80);
        const fan = data.fans[0]?.current;
        // Zero RPM is a real sample: keep it so a stopped fan is visible in the curve.
        if (fan != null && Number.isFinite(fan)) history.current.fan = [...history.current.fan, fan].slice(-80);
        setCurves({ ...history.current });
      } catch {
        if (alive) { setSmc(null); history.current = { temps: [], fan: [] }; setCurves(history.current); }
      } finally {
        // Schedule after completion so slow native reads never overlap.
        if (alive) timer = setTimeout(tick, 3000);
      }
    };
    void tick();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  const disks = Array.isArray(s?.disks) ? s.disks : [];
  const procs = Array.isArray(s?.top_processes) ? s.top_processes : [];
  const networks = Array.isArray(s?.network) ? s.network : [];
  const rx = s ? networks.reduce((sum: number, n: any) => sum + (n.rx_rate_mbs ?? 0), 0) : undefined;
  const tx = s ? networks.reduce((sum: number, n: any) => sum + (n.tx_rate_mbs ?? 0), 0) : undefined;
  const rxHistory = s?.network_history?.rx_history ?? [];
  const txHistory = s?.network_history?.tx_history ?? [];
  const battery = s?.batteries?.[0];
  const temps = smc?.temps ?? [];
  const fans = smc?.fans ?? [];
  const bt = (Array.isArray(s?.bluetooth) ? s.bluetooth : []).filter((d: any) => d.connected || String(d.battery ?? "").trim());
  const alerts = (Array.isArray(s?.process_alerts) ? s.process_alerts : []).filter((a: any) => a.status !== "resolved");
  const healthMessage = ({ excellent: "状态很好，继续轻装运行", good: "状态良好", fair: "可以安排一次日常维护", poor: "有一些项目需要关注", critical: "建议检查资源占用" } as Record<string, string>)[String(s?.health_score_msg ?? "").toLowerCase()] || s?.health_score_msg;
  const batteryStatus = ({ charged: "已充满", charging: "正在充电", discharging: "使用电池", "not charging": "未充电", "ac power": "已连接电源" } as Record<string, string>)[String(battery?.status ?? "").toLowerCase()] || battery?.status;
  const live = watchState === "live";
  const statusText = live ? "实时更新" : watchState === "reconnecting" ? "正在重新连接" : watchState === "connecting" ? "正在连接" : "等待连接";

  return <div className="dashboard">
    <div className="dashboard-heading">
      <PageHeader eyebrow="OVERVIEW" title="我的 Mac" description="状态一目了然，维护从容开始。" />
      <span className={`live-status ${live ? "is-live" : ""}`}><i />{statusText}</span>
    </div>
    <EngineNotice />
    <section className="overview-hero" aria-label="系统健康概览">
      <div className="hero-ring"><Ring value={s?.health_score} label="健康评分" /></div>
      <div className="hero-copy">
        <span className="hero-kicker">{s?.hardware?.model || "你的日常维护工作台"}</span>
        <h2>{healthMessage || (s ? "准备好，轻装运行" : "正在了解你的 Mac")}</h2>
        <p>{s ? `${s.hardware?.cpu_model || "本机系统"} · 已运行 ${fmtDuration(s.uptime_seconds) || s.uptime || "—"}` : "连接本机引擎后，在这里查看资源使用与设备状态。"}</p>
      </div>
      <div className="hero-actions">
        <button className="btn primary" onClick={() => navigate("clean")}><IconSparkles size={15} />清理空间</button>
        <button className="btn quiet" onClick={() => navigate("analyze")}><IconPie size={15} />查看磁盘</button>
      </div>
    </section>

    {alerts.map((a: any, i: number) => <div className="alert-strip warn" key={i}><IconCpu size={15}/><span>{a.name} 持续占用 CPU · {percent(a.cpu)}</span></div>)}
    <div className="section-heading"><h2>资源概览</h2><span>每 2 秒采样</span></div>
    <div className="grid resource-grid">
      <section className="card resource-card">
        <div className="resource-label"><IconCpu size={16}/><span>处理器</span><span className="resource-meta">{s?.cpu?.cores ? `${s.cpu.cores} 核` : "CPU"}</span></div>
        <div className="resource-value">{percent(s?.cpu?.usage)}</div>
        <Sparkline values={cpuHistory} color="#dda66a" height={48}/>
        <div className="resource-foot">负载 {s?.cpu?.load1?.toFixed(2) ?? "—"}<span>{s?.cpu?.p_core_count != null ? `${s.cpu.p_core_count} 性能核 · ${s.cpu.e_core_count ?? 0} 能效核` : "实时使用率"}</span></div>
      </section>
      <section className="card resource-card">
        <div className="resource-label"><span className="metric-glyph">▤</span><span>内存</span><span className="resource-meta">{s?.memory ? fmtBytes(s.memory.total, 0) : "—"}</span></div>
        <div className="resource-value">{percent(s?.memory?.used_percent)}</div>
        <Sparkline values={memHistory} color="#91bfa8" height={48}/>
        <div className="resource-foot">已用 {s?.memory ? fmtBytes(s.memory.used, 1) : "—"}<span>{({ normal: "压力正常", warn: "压力偏高", critical: "压力较高" } as Record<string, string>)[String(s?.memory?.pressure ?? "").toLowerCase()] ?? (s?.memory ? "压力数据未提供" : "等待采样")}</span></div>
      </section>
      <section className="card resource-card">
        <div className="resource-label"><IconGlobe size={16}/><span>网络</span><span className="resource-meta">{s?.proxy?.enabled ? "代理连接" : "本机网络"}</span></div>
        <div className="resource-value network-value"><small>↓</small> {rate(rx)}</div>
        <Sparkline values={rxHistory.slice(-80)} values2={txHistory.slice(-80)} color="#91bfa8" color2="#8aaace" height={48} scaleMax={Math.max(1, ...rxHistory, ...txHistory)}/>
        <div className="resource-foot">↑ {rate(tx)}<span>上传 / 下载</span></div>
      </section>
    </div>

    <div className="grid overview-detail-grid">
      <section className="card storage-card">
        <div className="card-heading"><h2>存储空间</h2><button className="text-action" onClick={() => navigate("analyze")}>查看详情 ↗</button></div>
        {disks.length === 0 && <div className="empty">等待磁盘数据</div>}
        {disks.map((d: any, i: number) => <div className="disk-entry" key={d.mount || i}>
          <div className="row"><strong>{d.mount === "/" ? "Macintosh HD" : d.mount}</strong><span className="disk-percent">{percent(d.used_percent)}</span></div>
          <div className="bar"><div className={pressure(d.used_percent)} style={{width: barWidth(d.used_percent)}} /></div>
          <div className="resource-foot">已用 {fmtBytes(d.used, 1)}<span>共 {fmtBytes(d.total, 1)}</span></div>
          {d.smart_status && !/verified|unknown|support/i.test(d.smart_status) && <span className="badge red">SMART {d.smart_status}</span>}
        </div>)}
        <div className="storage-footer"><span>废纸篓</span><strong>{s?.trash_size == null ? "—" : fmtBytes(s.trash_size, 1)}</strong></div>
      </section>
      <section className="card processes-card">
        <div className="card-heading"><h2>活跃进程</h2><span className="note">资源占用排行</span></div>
        {procs.length === 0 ? <div className="empty">等待进程数据</div> : <table className="list"><thead><tr><th>应用 / 进程</th><th className="num">CPU</th><th className="num">内存</th></tr></thead><tbody>{procs.slice(0, 5).map((p: any, i: number) => <tr key={p.pid ?? i}><td title={p.command}>{p.name}</td><td className="num">{percent(p.cpu)}</td><td className="num">{fmtBytes(p.memory_bytes, 0)}</td></tr>)}</tbody></table>}
        {s?.zombie_count > 0 && <p className="note">检测到 {s.zombie_count} 个僵尸进程</p>}
      </section>
    </div>

    <div className="section-heading"><h2>设备状态</h2><span>电源与温度</span></div>
    <div className="grid cols-2 device-grid">
      <section className="card">
        <div className="card-heading"><h2>电源</h2><span className="badge dim">{batteryStatus || "暂无电池读数"}</span></div>
        <div className="device-value">{battery?.percent != null ? `${battery.percent.toFixed(0)}%` : "—"}<span>当前电量</span></div>
        <div className="device-chart">{battery && <div className="bar"><div style={{width: barWidth(battery.percent)}} /></div>}</div>
        <Kv k="电池健康" v={battery?.capacity > 0 ? `${battery.capacity}%` : "—"}/>
        <Kv k="循环次数" v={battery?.cycle_count}/>
        <Kv k="系统功耗" v={s?.thermal?.system_power > 0 ? `${s.thermal.system_power.toFixed(1)} W` : "—"}/>
      </section>
      <section className="card">
        <div className="card-heading"><h2>温度与散热</h2><span className="note">只读监测</span></div>
        <div className="device-value">{temps.length ? `${Math.max(...temps.map(t => t.value)).toFixed(1)}°` : s?.thermal?.cpu_temp > 0 ? `${s.thermal.cpu_temp}°` : "—"}<span>{temps.length ? "最高传感器温度" : "CPU 温度"}</span></div>
        <div className="device-chart"><Sparkline values={curves.temps} color="#dda66a" height={46} scaleMax={Math.max(100, ...curves.temps)}/></div>
        {fans.map(f => <Kv key={f.index} k={`风扇 ${f.index + 1}`} v={`${f.current.toFixed(0)} RPM · ${f.mode === "auto" ? "自动" : f.mode === "forced" ? "手动" : f.mode}`}/>)}
        {!temps.length && !fans.length && <p className="note">当前未取得传感器读数。</p>}
        {temps.length > 0 && <details className="sensor-details"><summary>查看 {temps.length} 个传感器</summary><div className="sensor-list">{temps.map(t => <Kv key={t.key} k={t.label} v={`${t.value.toFixed(1)}°C`}/>)}</div>{fans.length > 0 && <><p className="note">风扇转速 · 最近 {curves.fan.length} 次采样</p><Sparkline values={curves.fan} color="#8aaace" height={40} scaleMax={Math.max(6800, ...curves.fan)}/></>}</details>}
      </section>
    </div>
    <details className="card system-details"><summary>设备信息与连接 <span>{s?.hardware?.os_version || "系统详情"}</span></summary><div className="grid cols-2">
      <div><Kv k="机型" v={s?.hardware?.model}/><Kv k="芯片" v={s?.hardware?.cpu_model}/><Kv k="内存" v={s?.hardware?.total_ram}/><Kv k="进程总数" v={s?.procs}/>{(Array.isArray(s?.gpu) ? s.gpu : []).map((g: any, i: number) => <Kv key={i} k={g.name || "GPU"} v={g.usage != null && g.usage >= 0 ? percent(g.usage) : g.core_count ? `${g.core_count} 核 · 使用率未提供` : "使用率未提供"}/>)}</div>
      <div><Kv k="磁盘读取" v={rate(s?.disk_io?.read_rate)}/><Kv k="磁盘写入" v={rate(s?.disk_io?.write_rate)}/>{bt.map((d: any, i: number) => <Kv key={i} k={d.name} v={d.battery || "已连接"}/>)}</div>
    </div>{Array.isArray(s?.cpu?.per_core) && <div className="core-readings">{s.cpu.per_core.map((v: number, i: number) => <span key={i}>核心 {i + 1}<b>{percent(v)}</b></span>)}</div>}
    {procs.length > 5 && <details className="sensor-details"><summary>全部 {procs.length} 个进程读数</summary><table className="list"><thead><tr><th>进程</th><th className="num">PID</th><th className="num">CPU</th><th className="num">内存</th></tr></thead><tbody>{procs.map((p: any, i: number) => <tr key={p.pid ?? i}><td>{p.name}</td><td className="num">{p.pid}</td><td className="num">{percent(p.cpu)}</td><td className="num">{fmtBytes(p.memory_bytes, 0)}</td></tr>)}</tbody></table></details>}
    </details>
  </div>;
}
