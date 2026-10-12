import React, { createContext, useContext, useEffect, useRef } from "react";
import { z } from "zod";
import type { IDBPDatabase } from "idb";
import type { Snapshot } from "./domain/model";
export function errorText(e: unknown) {
  if (e instanceof z.ZodError) {
    const labels: Record<string, string> = { date: '판매일자', menu_id: '메뉴', quantity: '판매 수량', unit_price: '판매 당시 단가', discount_amount: '총 할인 금액', payment_fee: '결제수수료' };
    return e.issues.map(i => `${labels[String(i.path[0])] ?? '입력'}: ${i.message}`).join(' / ');
  }
  if (e instanceof DOMException && e.name === 'QuotaExceededError') return '저장 공간이 부족합니다. 기존 기록은 유지했습니다. 입력을 보관한 뒤 공간을 확인하세요.';
  return e instanceof Error ? e.message : '처리하지 못했습니다. 기존 기록을 확인해 주세요.';
}
interface AppState { snapshot: Snapshot; db: IDBPDatabase; refresh: () => Promise<void> }
export const Store = createContext<AppState | null>(null);
export function useStore() { const s = useContext(Store); if (!s) throw new Error('저장소가 준비되지 않았습니다.'); return s; }
export function Icon({ name }: { name: 'coffee' | 'sales' | 'calendar' | 'stock' | 'cost' | 'backup' | 'plus' }) {
  const paths = { coffee: 'M5 8h12v7a5 5 0 0 1-10 0V8m10 0h2a3 3 0 0 1 0 6h-2M4 21h16M8 2v3m4-3v3', sales: 'M4 5h16v14H4zM7 9h4m-4 4h4m4-4h2m-2 4h2', calendar: 'M4 5h16v15H4zM4 10h16M8 3v4m8-4v4', stock: 'M3 6h18v4H3zM5 10v11h14V10M9 14h6', cost: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 7h6m-6 4h6', backup: 'M6 17H5a4 4 0 0 1-1-8 7 7 0 0 1 13-2 5 5 0 0 1 2 10h-1M12 12v9m-3-3 3 3 3-3', plus: 'M12 4v16M4 12h16' };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]}/></svg>;
}
export function Modal({ title, children, onClose, busy = false }: { title: string; children: React.ReactNode; onClose: () => void; busy?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current!; node.focus();
    const original = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = original; previous?.focus(); };
  }, []);
  return <div className="overlay"><div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1} onKeyDown={e => {
    if (e.key === 'Escape' && !busy) onClose();
    if (e.key === 'Tab') {
      const nodes = [...ref.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')];
      if (!nodes.length) { e.preventDefault(); return; }
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); }
      if (!e.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { e.preventDefault(); first.focus(); }
    }
  }}><header className="modal-head"><div><span className="eyebrow">프렙 카페 · 운영 기록</span><h2>{title}</h2></div><button className="icon-button" aria-label="닫기" onClick={onClose} disabled={busy}>×</button></header>{children}</div></div>;
}
export function Metric({ label, value, note, icon, accent }: { label: string; value: string; note: string; icon: React.ComponentProps<typeof Icon>['name']; accent?: boolean }) { return <section className={`metric ${accent ? 'featured' : ''}`}><div><span>{label}</span><Icon name={icon}/></div><strong>{value}<em>원</em></strong><small>{note}</small></section>; }
