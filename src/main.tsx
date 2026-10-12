import React, { createContext, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { type IDBPDatabase } from 'idb';
import { connect, initialize, mutate, readSnapshot } from './storage/repository';
import { aggregate, buildSale, formatMoney, formatRatio, inPeriod, metrics, todayKorea, usage } from './domain/sales';
import type { Sale, SaleForm, Snapshot } from './domain/model';
import './styles.css';

import { Store, useStore, Icon, Modal, Metric, errorText } from "./shared";
import { Operations, type Page } from "./operations-ui";
function SaleEditor({ initial, date, onClose, onSaved }: { initial?: Sale; date: string; onClose: () => void; onSaved: (sale: Sale) => void }) {
  const { snapshot, db, refresh } = useStore();
  const [form, setForm] = useState<SaleForm>(() => initial ? { date: initial.date, menu_id: initial.menu_id, channel: initial.channel, quantity: String(initial.quantity), unit_price: initial.unit_price, discount_amount: initial.discount_amount, payment_fee: initial.payment_fee ?? '' } : { date, menu_id: snapshot.seed.menus[0].menu_id, channel: '매장', quantity: '', unit_price: String(snapshot.seed.menus[0].price), discount_amount: '0', payment_fee: '' });
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const saving = useRef(false);
  const id = useRef(initial?.sale_id ?? crypto.randomUUID()); const revision = useRef(snapshot.revision);
  const set = (key: keyof SaleForm, value: string) => { setError(''); setForm(s => ({ ...s, [key]: value })); };
  const preview = useMemo(() => { try { return { sale: buildSale(snapshot.seed, form, id.current, initial), error: '' }; } catch (e) { return { sale: null, error: errorText(e) }; } }, [form, snapshot.seed, initial]);
  const m = preview.sale ? metrics(preview.sale) : null;
  const isClosed = snapshot.seed.calendar.find(x => x.date === form.date)?.record_complete;
  const isHoliday = snapshot.seed.calendar.find(x => x.date === form.date)?.is_open === false;
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (saving.current) return; saving.current = true; setBusy(true); setError('');
    let committed: Sale | null = null;
    try {
      committed = await mutate(db, { kind: initial ? 'edit' : 'add', id: id.current, form, revision: revision.current });
      await refresh(); onSaved(committed!);
    } catch (e) { setError(committed ? '저장은 완료됐지만 화면을 다시 읽지 못했습니다. 새로고침해 확인하세요. 다시 등록하지 마세요.' : errorText(e)); }
    finally { saving.current = false; setBusy(false); }
  }
  return <Modal title={initial ? '판매 기록 수정' : '판매 기록 직접 입력'} onClose={onClose} busy={busy}><form onSubmit={submit} noValidate><div className="modal-body">
    <p className="muted">하루의 특정 메뉴·채널별 판매 합계를 기록합니다. 주문 한 건을 입력하는 방식이 아닙니다.</p>
    <fieldset disabled={busy} className="fields"><label>판매일자 <span className="required">*</span><input aria-label="판매일자" type="date" min={snapshot.seed.meta.start_date} max={todayKorea()} value={form.date} onInput={e => set('date', e.currentTarget.value)} onChange={e => set('date', e.target.value)}/></label>
    <label>메뉴 선택 <span className="required">*</span><select aria-label="메뉴 선택" value={form.menu_id} onChange={e => { const menu = snapshot.seed.menus.find(m => m.menu_id === e.target.value)!; setForm(s => ({ ...s, menu_id: menu.menu_id, unit_price: String(menu.price) })); setError(''); }}>{snapshot.seed.menus.map(m => <option key={m.menu_id} value={m.menu_id}>{m.name} (기준가 {formatMoney(String(m.price))}원)</option>)}</select></label>
    <div className="full"><span className="label">판매 채널 <span className="required">*</span></span><div className="channel-choices">{(['매장', '포장'] as const).map(c => <label className={`channel ${c === form.channel ? 'selected' : ''}`} key={c}><input type="radio" name="channel" checked={form.channel === c} onChange={() => set('channel', c)}/><b>{c}</b><span>{c === '매장' ? '매장 판매' : '포장재 사용량·원가 포함'}</span></label>)}</div></div>
    <label>판매 수량 <span className="required">*</span><div className="unit-input"><input aria-label="판매 수량" inputMode="numeric" type="number" min="1" step="1" value={form.quantity} onChange={e => set('quantity', e.target.value)}/><span>개</span></div></label>
    <label>판매 당시 단가 <span className="required">*</span><div className="unit-input"><input aria-label="판매 당시 단가" inputMode="decimal" type="number" min="0" step="0.01" value={form.unit_price} onChange={e => set('unit_price', e.target.value)}/><span>원</span></div></label>
    <label>총 할인 금액 <span className="required">*</span><div className="unit-input"><input aria-label="총 할인 금액" inputMode="decimal" type="number" min="0" step="0.01" value={form.discount_amount} onChange={e => set('discount_amount', e.target.value)}/><span>원</span></div><small>집계 전체 할인액을 양수로 입력</small></label>
    <label>결제수수료 금액 <span className="required">*</span><div className="unit-input"><input aria-label="결제수수료 금액" inputMode="decimal" type="number" min="0" step="0.01" placeholder="없으면 0 입력" value={form.payment_fee} onChange={e => set('payment_fee', e.target.value)}/><span>원</span></div><small>전체 수수료 직접 입력 · 자동 비율 없음</small></label></fieldset>
    {(isClosed || isHoliday) && <p className="notice">{isHoliday ? '휴무로 표시된 날짜입니다. ' : '마감된 날짜의 기록을 보정합니다. '}판매를 저장해도 영업달력의 상태는 자동 변경하지 않습니다.</p>}
    <section className="preview"><div className="section-title"><b>손익과 재료 사용량 미리보기</b><span>저장 전 계산</span></div>{preview.sale && m ? <><div className="preview-grid"><div><small>할인 후 순매출</small><strong>{formatMoney(preview.sale.net_sales)}<em>원</em></strong></div><div><small>식재료·포장 원가</small><strong>{formatMoney(m.cost)}<em>원</em></strong></div><div><small>메뉴에서 남는 금액</small><strong className="accent">{formatMoney(m.contribution)}<em>원</em></strong><small>{formatRatio(m.ratio)} · 수수료 {formatMoney(preview.sale.payment_fee)}원 포함</small></div></div><p className="consumption">재료 사용: {usage(snapshot.seed, preview.sale).map(x => `${x.name} ${formatMoney(x.quantity)}${x.unit}`).join(' · ')}</p></> : <p className="muted">{preview.error || '필수 입력을 채우면 결과를 확인할 수 있습니다.'}</p>}<small>임차료·인건비 등 운영비를 빼기 전 금액입니다. 저장하면 재고 화면의 기록 잔량에도 반영됩니다.</small></section>
    {error && <p className="error" role="alert">{error}</p>}
  </div><footer className="modal-foot"><button type="button" onClick={onClose} disabled={busy}>취소</button><button className="primary" type="submit" disabled={busy}>{busy ? '저장 중…' : initial ? '수정 저장' : '판매 기록 저장'}</button></footer></form></Modal>;
}
function SalesPage() {
  const [page, setPage] = useState<Page>("sales");
  const { snapshot, db, refresh } = useStore();
  const [period, dispatch] = useReducer((s: { mode: 'day' | 'month'; date: string }, a: Partial<{ mode: 'day' | 'month'; date: string }>) => ({ ...s, ...a }), { mode: 'day', date: snapshot.seed.meta.as_of });
  const [view, setView] = useState<'records' | 'profit'>('records'); const [editor, setEditor] = useState<Sale | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Sale | null>(null); const [deleteRevision, setDeleteRevision] = useState(0); const [busy, setBusy] = useState(false); const deleteBusy = useRef(false);
  const [message, setMessage] = useState(''); const [error, setError] = useState('');
  const rows = useMemo(() => snapshot.sales.filter(s => inPeriod(s, period.mode, period.date)).sort((a, b) => a.date.localeCompare(b.date) || a.menu_id.localeCompare(b.menu_id) || a.channel.localeCompare(b.channel)), [snapshot, period]);
  const totals = useMemo(() => aggregate(rows), [rows]);
  const menuMap = Object.fromEntries(snapshot.seed.menus.map(m => [m.menu_id, m]));
  const days = snapshot.seed.calendar.filter(d => period.mode === 'day' ? d.date === period.date : d.date.slice(0, 7) === period.date.slice(0, 7));
  const dayCount = period.mode === 'day' ? 1 : new Date(Number(period.date.slice(0, 4)), Number(period.date.slice(5, 7)), 0).getDate();
  const complete = days.length === dayCount && days.every(d => d.record_complete);
  const status = !rows.length ? '판매 기록 없음' : complete ? '마감 기록' : '일부 기록 · 미마감 포함';
  const periodLabel = period.mode === 'day' ? period.date : `${period.date.slice(0, 4)}년 ${Number(period.date.slice(5, 7))}월`;
  async function remove() {
    if (!deleting || deleteBusy.current) return; deleteBusy.current = true; setBusy(true); setError(''); let committed = false;
    try { await mutate(db, { kind: 'delete', id: deleting.sale_id, revision: deleteRevision }); committed = true; await refresh(); setDeleting(null); setMessage('판매 기록을 삭제했습니다. 수익성과 재료 사용량 계산에서 제외했습니다.'); }
    catch (e) { setError(committed ? '삭제는 완료됐지만 화면을 다시 읽지 못했습니다. 새로고침해 확인하세요.' : errorText(e)); }
    finally { deleteBusy.current = false; setBusy(false); }
  }
  return <><header className="topbar"><div className="brand"><span className="brand-icon"><Icon name="coffee"/></span><div><b>프렙 카페 운영관리</b><small>Prep Cafe Operations</small></div></div><div className="top-status"><span className="dot"/>{snapshot.seed.meta.as_of} 자료 마감</div><div className="top-right">기록 저장: 이 브라우저<span className="avatar">프</span></div></header>
    <aside className="sidebar"><span className="eyebrow">MANAGEMENT CONSOLE</span><nav>{([{id: "dashboard", name: "기간 실적 & 손익", icon: "calendar"}, {id: "sales", name: "판매 기록 & 수익성", icon: "sales"}, {id: "inventory", name: "재고 관리 & 재료 잔량", icon: "stock"}, {id: "expenses", name: "비용 기록 관리", icon: "cost"}, {id: "backup", name: "백업 & 복원", icon: "backup"}] as const).map(n => <button key={n.id} className={`nav ${page === n.id ? "active" : ""}`} aria-current={page === n.id ? "page" : undefined} onClick={() => {setPage(n.id); setError(""); setMessage("");}}><Icon name={n.icon}/>{n.name}</button>)}</nav><div className="sidebar-bottom"><b>EPIC 1~3 · 사용자 확인 대기</b><p>판매·비용·재고를 기록하고<br/>손익과 재료 잔량을 확인하세요.</p><small>가상 매장 샘플 · 부가세 제외</small></div></aside>
    <main>{page === "sales" && <div className="heading"><div><span className="eyebrow">OPERATIONS / SALES & PROFITABILITY</span><h1>판매 기록과 메뉴 수익성</h1><p className="muted">판매를 기록하고, 메뉴에서 실제로 남는 금액을 확인하세요.</p></div><button className="primary add-button" onClick={() => { setEditor('new'); setMessage(''); setError(''); }}><Icon name="plus"/>신규 판매 등록</button></div>}
    <section className="period-bar" aria-label="조회 기간"><div className="segments"><button className={period.mode === 'day' ? 'selected' : ''} onClick={() => dispatch({ mode: 'day' })}>일간 조회</button><button className={period.mode === 'month' ? 'selected' : ''} onClick={() => dispatch({ mode: 'month' })}>월간 조회</button></div><label className="period-picker"><Icon name="calendar"/><span className="sr-only">{period.mode === 'day' ? '조회 날짜' : '조회 월'}</span><input aria-label={period.mode === 'day' ? '조회 날짜' : '조회 월'} type={period.mode === 'day' ? 'date' : 'month'} value={period.mode === 'day' ? period.date : period.date.slice(0, 7)} onInput={e => { const value = e.currentTarget.value; if (value) dispatch({ date: period.mode === 'day' ? value : `${value}-01` }); }} onChange={e => { if (e.target.value) dispatch({ date: period.mode === 'day' ? e.target.value : `${e.target.value}-01` }); }}/></label><span className={`badge ${complete ? 'green' : ''}`}>{status}</span><span className="period-note">{rows.length ? `등록 ${rows.length}줄 · ${rows[0].date}~${rows.at(-1)!.date}` : '자료가 없는 날짜를 판매 0으로 확정하지 않습니다.'}</span></section>
    {!complete && <p className="notice">{periodLabel}에는 미마감 또는 달력 미등록 날짜가 있습니다. 입력된 판매만 표시하며, 없는 날짜를 실적 0으로 채우지 않습니다.</p>}
    {message && <div className="success" role="status">{message}</div>}{error && !deleting && <p className="error" role="alert">{error}</p>}
    {page === "sales" ? <>
    <div className="cards"><Metric label="할인 후 순매출" value={formatMoney(totals.net)} note={`${totals.quantity.toLocaleString()}개 판매 · ${rows.length}줄 집계`} icon="sales"/><Metric label="식재료·포장 원가" value={formatMoney(totals.cost)} note="판매 당시 개당 원가 × 판매 수량" icon="stock"/><Metric label="결제수수료" value={formatMoney(totals.fee)} note="각 판매의 기록된 수수료 합계" icon="cost"/><Metric label="메뉴에서 남는 금액" value={formatMoney(totals.contribution)} note={`남는 비율 ${formatRatio(totals.ratio)} · 운영비 제외`} icon="coffee" accent/></div>
    {totals.missing > 0 && <p className="error" role="alert">{totals.missing}줄에 원가 또는 수수료가 없어 전체 수익성 합계를 확정할 수 없습니다.</p>}
    <section className="table-card"><div className="table-heading"><div className="tabs"><button onClick={() => setView('records')} className={view === 'records' ? 'active' : ''}>판매 기록</button><button onClick={() => setView('profit')} className={view === 'profit' ? 'active' : ''}>메뉴별 수익성</button></div><span>{periodLabel} · 원</span></div>
    <p className="table-help">남는 금액 = 순매출 − 식재료·포장 원가 − 결제수수료. 임차료·인건비는 포함하지 않습니다.</p>
    <div className="table-scroll">{view === 'records' ? <table><thead><tr><th>판매일자</th><th>메뉴</th><th>채널</th><th className="num">수량</th><th className="num">당시 단가</th><th className="num">총 할인</th><th className="num">순매출</th><th className="num">판매 원가</th><th className="num">수수료</th><th className="num">남는 금액</th><th className="num">비율</th><th>관리</th></tr></thead><tbody>{rows.map(s => { const m = metrics(s); return <tr key={s.sale_id}><td className="date">{s.date}</td><td><b>{menuMap[s.menu_id]?.name ?? '메뉴 없음'}</b></td><td><span className={`channel-tag ${s.channel === '포장' ? 'takeout' : ''}`}>{s.channel}</span></td><td className="num">{s.quantity}</td><td className="num">{formatMoney(s.unit_price)}</td><td className="num">{formatMoney(s.discount_amount)}</td><td className="num">{formatMoney(s.net_sales)}</td><td className="num">{formatMoney(m.cost)}</td><td className="num">{formatMoney(s.payment_fee)}</td><td className="num strong">{formatMoney(m.contribution)}</td><td className="num">{formatRatio(m.ratio)}</td><td className="actions"><button aria-label={`${s.date} ${menuMap[s.menu_id]?.name} ${s.channel} 수정`} onClick={() => { setEditor(s); setError(''); setMessage(''); }}>수정</button><button className="danger-text" aria-label={`${s.date} ${menuMap[s.menu_id]?.name} ${s.channel} 삭제`} onClick={() => { setDeleting(s); setDeleteRevision(snapshot.revision); setError(''); }}>삭제</button></td></tr>; })}{!rows.length && <tr><td colSpan={12} className="empty">등록된 판매가 없습니다.<br/><span>다른 기간을 선택하거나 신규 판매를 등록하세요.</span></td></tr>}</tbody></table> : <table><thead><tr><th>메뉴</th><th>채널</th><th className="num">판매수량</th><th className="num">순매출</th><th className="num">식재료·포장 원가</th><th className="num">결제수수료</th><th className="num">남는 금액</th><th className="num">남는 비율</th></tr></thead><tbody>{snapshot.seed.menus.map(menu => { const group = rows.filter(s => s.menu_id === menu.menu_id); const a = aggregate(group); return <React.Fragment key={menu.menu_id}><tr className="menu-total"><td><b>{menu.name}</b><small>{menu.category}</small></td><td>전체</td><td className="num">{group.length ? a.quantity : '—'}</td><td className="num">{group.length ? formatMoney(a.net) : '기록 없음'}</td><td className="num">{group.length ? formatMoney(a.cost) : '—'}</td><td className="num">{group.length ? formatMoney(a.fee) : '—'}</td><td className="num strong">{group.length ? formatMoney(a.contribution) : '—'}</td><td className="num">{formatRatio(a.ratio)}</td></tr>{(['매장', '포장'] as const).map(c => { const g = group.filter(s => s.channel === c); if (!g.length) return null; const a = aggregate(g); return <tr className="channel-row" key={c}><td>↳ {menu.name}</td><td>{c}</td><td className="num">{a.quantity}</td><td className="num">{formatMoney(a.net)}</td><td className="num">{formatMoney(a.cost)}</td><td className="num">{formatMoney(a.fee)}</td><td className="num">{formatMoney(a.contribution)}</td><td className="num">{formatRatio(a.ratio)}</td></tr>; })}</React.Fragment>; })}</tbody></table>}</div><footer className="table-footer"><span>가상 샘플 시작일 {snapshot.seed.meta.start_date} · 자료 마감 {snapshot.seed.meta.as_of}</span><span>저장된 판매 총 {snapshot.sales.length.toLocaleString()}줄</span></footer></section>
    </> : <Operations page={page} period={period} setPeriod={dispatch} onNewSale={() => {setEditor("new"); setError("");}} onNavigate={setPage}/>}
    <footer className="page-footer"><span>프렙 카페 · 판매·손익·재고</span><span>기록은 이 주소·브라우저에 저장됩니다. 브라우저 데이터를 삭제하면 사라질 수 있습니다.</span></footer></main>
    {editor && <SaleEditor initial={editor === 'new' ? undefined : editor} date={period.date} onClose={() => setEditor(null)} onSaved={sale => { setEditor(null); dispatch({ date: sale.date }); setMessage('판매 기록을 저장했습니다. 메뉴 수익성과 재료 사용량 계산에 반영했습니다.'); }}/>} 
    {deleting && <Modal title="판매 기록 삭제" onClose={() => { setDeleting(null); setError(''); }} busy={busy}><div className="modal-body"><p>다음 판매를 삭제하시겠습니까?</p><div className="delete-summary"><b>{menuMap[deleting.menu_id]?.name} · {deleting.channel}</b><span>{deleting.date} · {deleting.quantity}개 · 순매출 {formatMoney(deleting.net_sales)}원</span></div><p className="muted">삭제하면 메뉴 수익성과 재료 사용량 계산에서 제외됩니다.</p>{error && <p role="alert" className="error">{error}</p>}</div><footer className="modal-foot"><button disabled={busy} onClick={() => { setDeleting(null); setError(''); }}>취소</button><button className="danger" disabled={busy} onClick={remove}>{busy ? '삭제 중…' : '삭제 확정'}</button></footer></Modal>}
  </>;
}
function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null); const [db, setDB] = useState<IDBPDatabase | null>(null); const [error, setError] = useState('');
  useEffect(() => {
    let mounted = true; let connection: IDBPDatabase | null = null;
    const onStorage = (e: Event) => setError((e as CustomEvent).detail);
    window.addEventListener('storage-error', onStorage);
    (async () => {
      try { connection = await connect(); const data = await initialize(connection, async () => { const response = await fetch('/sample/store-operations.json'); if (!response.ok) throw new Error('샘플 자료를 읽지 못했습니다. 다시 시도하세요.'); return response.json(); }); if (mounted) { setDB(connection); setSnapshot(data); } }
      catch (e) { if (mounted) setError(errorText(e)); }
    })();
    return () => { mounted = false; connection?.close(); window.removeEventListener('storage-error', onStorage); };
  }, []);
  if (error) return <div className="startup"><h1>기록을 안전하게 열지 못했습니다</h1><p className="error" role="alert">{error}</p><p>기존 기록을 자동 삭제하거나 샘플로 덮어쓰지 않았습니다.</p><button onClick={() => location.reload()}>다시 열기</button></div>;
  if (!snapshot || !db) return <div className="startup" role="status"><span className="brand-icon"><Icon name="coffee"/></span><h1>프렙 카페 기록을 준비하고 있습니다</h1><p>가상 샘플을 검사하고 이 브라우저의 저장 자료를 확인합니다.</p></div>;
  return <Store.Provider value={{ snapshot, db, refresh: async () => setSnapshot(await readSnapshot(db)) }}><SalesPage/></Store.Provider>;
}
class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> { state = { failed: false }; static getDerivedStateFromError() { return { failed: true }; } render() { return this.state.failed ? <div className="startup"><h1>화면을 다시 열어 주세요</h1><p>기존 저장 기록을 자동 초기화하지 않았습니다.</p><button onClick={() => location.reload()}>다시 열기</button></div> : this.props.children; } }
createRoot(document.getElementById('root')!).render(<Boundary><App/></Boundary>);
