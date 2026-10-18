'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Activity, ArrowDownLeft, ArrowUpRight, Check, CheckCircle2, ChevronRight, CircleAlert, Clock3, Database, ExternalLink, Layers3, LoaderCircle, RefreshCw, Search, ShieldCheck, Workflow, X } from 'lucide-react';
import type { Attempt, DashboardData } from '@/lib/types';

function Badge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    succeeded: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
    synced: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
    failed: 'bg-rose-50 text-rose-700 ring-rose-200',
    pending: 'bg-amber-50 text-amber-800 ring-amber-200',
    processing: 'bg-blue-50 text-blue-700 ring-blue-200',
  };
  return <span className={'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-semibold capitalize ring-1 ring-inset ' + (styles[status] ?? 'bg-slate-50 text-slate-600 ring-slate-200')}>
    <span className="h-1.5 w-1.5 rounded-full bg-current" />{status}
  </span>;
}

function RecordLink({ id, type, portal }: { id: string | null; type: '0-1' | '0-3'; portal: string | null }) {
  if (!id) return <span className="text-slate-400">—</span>;
  if (!portal || !/^\d+$/.test(portal) || !/^\d+$/.test(id)) return <span className="font-mono text-xs">{id}</span>;
  return <a className="inline-flex items-center gap-1 font-mono text-xs text-teal-800 hover:underline" href={'https://app.hubspot.com/contacts/' + portal + '/record/' + type + '/' + id} target="_blank" rel="noopener noreferrer">
    {id}<ExternalLink size={11} /><span className="sr-only">Open {type === '0-1' ? 'Contact' : 'Deal'} in HubSpot</span>
  </a>;
}

function timestamp(value: string) {
  return new Intl.DateTimeFormat('en-SG', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
}

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [modal, setModal] = useState<{ kind: 'retry' | 'error'; attempt: Attempt } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/dashboard', { cache: 'no-store' });
      const body = await response.json();
      setConnected(body.connected === true);
      if (!response.ok) throw new Error(body.error ?? 'Unable to load history.');
      setData(body);
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The dashboard is unavailable.');
      if (failure instanceof TypeError) setConnected(false);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);
  useEffect(() => {
    if (modal) dialog.current?.showModal();
    else dialog.current?.close();
  }, [modal]);

  async function retry(orderId: string) {
    setModal(null);
    setBusy(orderId);
    setNotice(null);
    try {
      const response = await fetch('/api/orders/' + encodeURIComponent(orderId) + '/retry', { method: 'POST' });
      const body = await response.json();
      setNotice({ ok: response.ok, text: body.message ?? (response.ok ? 'Order synchronized successfully.' : 'Retry failed.') });
    } catch { setNotice({ ok: false, text: 'Connection interrupted. Processing may still be running; refresh before retrying.' }); }
    finally { await refresh(); setBusy(null); }
  }

  const attempts = data?.attempts ?? [];
  const visible = attempts.filter(a => a.orderId.toLowerCase().includes(search.toLowerCase()) && (filter === 'all' || a.attemptStatus === filter));
  const retryable = new Set(attempts.filter(a => a.retryEligible).map(a => a.orderId)).size;
  const cards = [
    { label: 'Total attempts', value: data?.summary.total, caption: 'Latest 50 attempts', icon: Layers3, color: 'bg-slate-100 text-slate-600' },
    { label: 'Successful', value: data?.summary.succeeded, caption: 'Latest 50 attempts', icon: CheckCircle2, color: 'bg-emerald-50 text-emerald-700' },
    { label: 'Failed', value: data?.summary.failed, caption: 'Latest 50 attempts · includes history', icon: CircleAlert, color: 'bg-rose-50 text-rose-600' },
    { label: 'In progress', value: data?.summary.inFlightOrders, caption: 'Pending + processing · all orders', icon: Clock3, color: 'bg-blue-50 text-blue-600' },
  ];

  return <div className="min-h-screen">
    <header className="border-b border-[#dce4e0] bg-white">
      <div className="mx-auto flex max-w-[1480px] items-center justify-between gap-4 px-5 py-5 sm:px-10">
        <Link href="/" className="flex items-center gap-3" aria-label="Optima Solutions dashboard home">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#174e43] text-white"><Workflow size={22} /></span>
          <span className="text-[17px] font-bold tracking-tight">optima<span className="font-normal text-slate-500"> solutions</span></span>
        </Link>
        <div className="flex items-center gap-3 text-xs"><span className="hidden text-slate-500 sm:inline">Integration workspace</span><span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 font-medium text-slate-600">Local assessment</span></div>
      </div>
    </header>
    <main className="mx-auto max-w-[1480px] px-5 pt-7 pb-12 sm:px-10">
      <nav aria-label="Breadcrumb" className="mb-8 flex items-center gap-2 text-xs text-slate-500"><Workflow size={13} /><span>Integrations</span><ChevronRight size={12} /><span className="text-slate-800">HubSpot</span></nav>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-5">
        <div><div className="mb-2 text-[10px] font-bold tracking-[.18em] text-teal-700">ORDER OPERATIONS</div>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-[36px]" aria-label="Optima Solutions — HubSpot Order Sync">HubSpot Order Sync</h1>
          <p className="mt-3 text-sm leading-6 text-slate-500">A clear view of every handoff, from incoming order to connected CRM record.</p>
        </div>
        <div className="flex items-center gap-3">
          <span role="status" data-testid="connection" className={'flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-medium ' + (connected ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-white text-slate-600')}>
            <span className={'h-1.5 w-1.5 rounded-full ' + (connected ? 'bg-emerald-600' : 'bg-slate-400')} />
            {loading && !data ? 'Checking API…' : connected ? 'Backend connected' : 'Backend unavailable'}
          </span>
          <button onClick={() => { setLoading(true); void refresh(); }} disabled={loading} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-xs font-semibold shadow-sm transition hover:bg-slate-50 disabled:opacity-50"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} />Refresh</button>
        </div>
      </div>
      {error && <div role="alert" className="mb-5 flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"><CircleAlert size={18} className="shrink-0" /><div>{error}{data && <p className="mt-1 text-xs">Showing the last loaded history. Retry actions are disabled until the connection recovers.</p>}</div></div>}
      {notice && <div role={notice.ok ? 'status' : 'alert'} className={'mb-5 flex items-center justify-between gap-3 rounded-xl border p-4 text-sm ' + (notice.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-800')}>
        <span>{notice.text}</span><button aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={16} /></button>
      </div>}
      <section aria-label="Synchronization summary" className="mb-7 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(({ label, value, caption, icon: Icon, color }) => <article key={label} className="rounded-xl border border-[#dfe6e2] bg-white p-5 shadow-[0_2px_4px_#18382b03]">
          <div className="flex items-center justify-between"><h2 className="text-xs font-medium text-slate-500">{label}</h2><span className={'rounded-lg p-2 ' + color}><Icon size={17} /></span></div>
          <div className="mt-3 text-[32px] leading-none font-semibold tracking-tight">{value ?? <span className={loading ? 'skeleton inline-block h-8 w-12 rounded bg-slate-100' : ''}>{loading ? '' : '—'}</span>}</div>
          <p className="mt-4 text-[10px] text-slate-500">{caption}</p>
        </article>)}
      </section>
      <section className="overflow-hidden rounded-xl border border-[#dfe6e2] bg-white shadow-[0_3px_10px_#18382b03]" aria-labelledby="history-heading">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 px-5 py-5 sm:px-6">
          <div><h2 id="history-heading" className="flex items-center gap-2 text-base font-semibold">Synchronization history<span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">{attempts.length}</span></h2><p className="mt-1.5 text-xs text-slate-500">Latest 50 attempts, newest first. Each attempt keeps its own history.</p></div>
          <div className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2"><Search size={14} className="text-slate-400" /><input aria-label="Search order ID" placeholder="Search order ID…" value={search} onChange={e => setSearch(e.target.value)} className="w-40 bg-transparent text-xs outline-none" /></div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-3 sm:px-6">
          <div className="flex gap-1" role="group" aria-label="Filter attempts">
            {['all', 'succeeded', 'failed', 'processing'].map(status => <button key={status} aria-pressed={filter === status} onClick={() => setFilter(status)} className={'rounded-md px-3 py-1.5 text-[11px] font-medium capitalize ' + (filter === status ? 'bg-[#e7f1ed] text-[#1a5948]' : 'text-slate-500 hover:bg-slate-50')}>{status === 'all' ? 'All attempts' : status}</button>)}
          </div>
          <span className="flex items-center gap-1.5 text-[10px] text-slate-500"><ShieldCheck size={13} />Retries follow current order status</span>
        </div>
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[1150px] border-collapse text-left">
            <thead><tr className="border-b border-slate-100 bg-[#fafbfaff] text-[10px] font-semibold tracking-wide text-slate-500">
              {['ORDER / ATTEMPT', 'ATTEMPT STATUS', 'ORDER STATUS', 'CONTACT', 'DEAL', 'ERROR', 'TIMESTAMPS', 'ACTION'].map(name => <th key={name} scope="col" className="px-4 py-3.5 first:pl-6 last:pr-6">{name}</th>)}
            </tr></thead>
            <tbody>{loading && !data ? Array.from({ length: 3 }, (_, i) => <tr key={i}><td colSpan={8} className="p-6"><div className="skeleton h-5 rounded bg-slate-100" /></td></tr>) :
              visible.map(attempt => <tr key={attempt.id} className="border-b border-slate-100 transition last:border-0 hover:bg-slate-50/70">
                <td className="py-5 pr-4 pl-6"><div className="max-w-60 break-all text-xs font-semibold">{attempt.orderId}</div><div className="mt-1.5 font-mono text-[10px] text-slate-400">Attempt #{attempt.id}{attempt.trigger && <span className="font-sans"> · {attempt.trigger}</span>}</div></td>
                <td className="px-4 py-5"><Badge status={attempt.attemptStatus} /></td>
                <td className="px-4 py-5"><Badge status={attempt.orderStatus} /></td>
                <td className="px-4 py-5"><RecordLink id={attempt.contactId} portal={data?.portalId ?? null} type="0-1" /></td>
                <td className="px-4 py-5"><RecordLink id={attempt.dealId} portal={data?.portalId ?? null} type="0-3" /></td>
                <td className="px-4 py-5">{attempt.error ? <button onClick={() => setModal({ kind: 'error', attempt })} className="flex items-center gap-1.5 text-xs text-rose-700 hover:underline"><CircleAlert size={13} />View error</button> : <span className="text-slate-300">—</span>}</td>
                <td className="px-4 py-5 text-[11px] whitespace-nowrap text-slate-600"><div>{timestamp(attempt.startedAt)}</div><div className="mt-1 text-[10px] text-slate-400">{attempt.finishedAt ? 'Finished ' + timestamp(attempt.finishedAt) : 'Not completed'}</div></td>
                <td className="px-4 py-5">{attempt.retryEligible ? <><button disabled={!!busy || !!error || !connected} onClick={() => setModal({ kind: 'retry', attempt })} className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold text-teal-800 hover:bg-teal-50 disabled:opacity-40">{busy === attempt.orderId ? <LoaderCircle size={12} className="animate-spin" /> : <RefreshCw size={12} />}{busy === attempt.orderId ? 'Retrying…' : 'Retry'}</button>{attempt.nextRetryAt && <div data-testid="next-retry" className="mt-1.5 text-[10px] whitespace-nowrap text-slate-500">Auto retry {timestamp(attempt.nextRetryAt)}</div>}</> : <span title="Only currently failed orders can be retried" className="flex items-center gap-1 text-[10px] whitespace-nowrap text-slate-400">{attempt.orderStatus === 'synced' && <Check size={12} />}{attempt.orderStatus === 'synced' ? 'Up to date' : 'Not eligible'}</span>}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
        {!loading && visible.length === 0 && <div className="px-6 py-16 text-center"><Database size={30} className="mx-auto mb-3 text-slate-300" /><p className="text-sm font-semibold">{error ? 'History unavailable' : attempts.length ? 'No matching attempts' : 'No synchronization attempts yet'}</p><p className="mt-2 text-xs text-slate-500">{attempts.length ? 'Try a different order ID or status filter.' : 'Accepted orders will appear here once synchronization begins.'}</p></div>}
        <div className="flex flex-wrap justify-between gap-2 border-t border-slate-100 bg-[#fcfdfc] px-6 py-3.5 text-[10px] text-slate-500">
          <span>{visible.length} of {attempts.length} loaded attempts · {retryable ? retryable + ' retryable order' + (retryable > 1 ? 's' : '') : 'No retryable orders'}</span>
          <span>{data ? 'Updated ' + timestamp(data.checkedAt) + ' · Browser local time' : 'Waiting for API response'}</span>
        </div>
      </section>
      <section className="mt-6 grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        <div className="rounded-xl border border-[#dfe6e2] bg-white px-6 py-5">
          <h2 className="mb-4 text-[11px] font-semibold text-slate-500">THE SYNCHRONIZATION PATH</h2>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3 text-xs"><span className="flex items-center gap-2"><ArrowDownLeft size={15} className="text-teal-700" />Signed order</span><ChevronRight size={14} className="text-slate-300" /><span className="flex items-center gap-2"><Database size={15} className="text-teal-700" />PostgreSQL</span><ChevronRight size={14} className="text-slate-300" /><span className="flex items-center gap-2"><Workflow size={15} className="text-[#c16a39]" />HubSpot Contact + Deal</span><ChevronRight size={14} className="text-slate-300" /><span className="flex items-center gap-2"><CheckCircle2 size={15} className="text-teal-700" />Association verified</span></div>
        </div>
        <div className="flex gap-3 rounded-xl border border-[#dae8e1] bg-[#edf4ef] px-5 py-5"><ShieldCheck size={19} className="shrink-0 text-teal-700" /><div><h2 className="text-xs font-semibold text-teal-900">History stays. Duplicates don’t.</h2><p className="mt-1.5 text-[11px] leading-5 text-teal-900/65">Retries reuse existing CRM records. A failed attempt remains visible even after its order is synchronized.</p></div></div>
      </section>
      <footer className="mt-8 flex items-center justify-between gap-3 text-[10px] text-slate-400"><span className="flex items-center gap-1.5"><Activity size={12} />Optima Solutions · Integration monitor</span><span className="flex items-center gap-1">HubSpot Order Sync<ArrowUpRight size={12} /></span></footer>
    </main>
    <dialog ref={dialog} onCancel={() => setModal(null)} onClose={() => setModal(null)} className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border-0 bg-white p-6 shadow-xl" aria-labelledby="dialog-title">
      {modal && <><div className="mb-4 flex items-start justify-between gap-4"><div className={'rounded-xl p-2.5 ' + (modal.kind === 'retry' ? 'bg-teal-50 text-teal-700' : 'bg-rose-50 text-rose-600')}>{modal.kind === 'retry' ? <RefreshCw size={22} /> : <CircleAlert size={22} />}</div><button aria-label="Close dialog" onClick={() => setModal(null)} className="p-1 text-slate-500"><X size={18} /></button></div>
        <h2 id="dialog-title" className="text-lg font-semibold">{modal.kind === 'retry' ? 'Retry this order?' : 'Attempt error details'}</h2>
        <p className="mt-2 break-all font-mono text-xs text-slate-500">{modal.attempt.orderId}</p>
        {modal.kind === 'retry' ? <><p className="mt-4 text-sm leading-6 text-slate-600">This starts a new synchronization attempt. Existing Contact and Deal records will be reused. The server will check eligibility again before processing.</p><div className="mt-6 flex justify-end gap-2"><button onClick={() => setModal(null)} className="rounded-lg border border-slate-200 px-4 py-2 text-sm">Cancel</button><button onClick={() => void retry(modal.attempt.orderId)} className="rounded-lg bg-[#195c4c] px-4 py-2 text-sm font-semibold text-white hover:bg-[#124737]">Confirm retry</button></div></> :
          <><p className="mt-4 max-h-72 overflow-auto rounded-lg bg-rose-50 p-4 font-mono text-xs leading-6 whitespace-pre-wrap break-all text-rose-900">{modal.attempt.error}</p><p className="mt-3 text-xs text-slate-500">Attempt #{modal.attempt.id} · Current order: {modal.attempt.orderStatus}</p><button onClick={() => setModal(null)} className="mt-5 rounded-lg border border-slate-200 px-4 py-2 text-sm">Close</button></>}
      </>}
    </dialog>
  </div>;
}
