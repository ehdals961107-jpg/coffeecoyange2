import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { deleteDB, type IDBPDatabase } from 'idb';
import { validateSeed, type Seed, type Snapshot } from '../src/domain/model';
import { buildInventory, buildExpense, stocks, periodProfit, stockBasis } from '../src/domain/operations';
import { createBackup, parseBackup, validateBackup } from '../src/domain/backup';
import { connect, initialize, readSnapshot, mutate } from '../src/storage/repository';
import { addInventory, saveExpense, replaceDataset } from '../src/storage/operations';
import { buildSale } from '../src/domain/sales';

const seed = validateSeed(JSON.parse(readFileSync('public/sample/store-operations.json', 'utf8')));
const fixture: Seed = { ...seed, sales: [], inventory_events: [], expenses: [], opening_inventory: seed.opening_inventory.map(x => ({ ...x, quantity: 1000 })) };
const snapshot: Snapshot = { seed: fixture, sales: [], inventoryEvents: [], expenses: [], revision: 0 };
const today = '2026-10-12';
const inbound = { date: '2026-09-19', material_id: 'I01', event_type: '입고' as const, quantity: '500', reason: '검사 입고', unit_cost: '24.84' };
const costForm = { date: '2026-09-19', category: '광고비', amount: '1000' };
const saleForm = { date: '2026-09-19', menu_id: 'M01', channel: '매장' as const, quantity: '2', unit_price: '4000', discount_amount: '0', payment_fee: '0' };
const stock = (s: Snapshot, through = '2026-09-20') => stocks(s, through).find(x => x.material_id === 'I01')!;

describe('재고·비용·기간 손익 계산', () => {
  it('입고는 기준단위 수량만큼 증가시킨다', () => { const e = buildInventory(snapshot, inbound, 'in', today); expect(e.quantity).toBe('500'); expect(stock({ ...snapshot, inventoryEvents: [e] }).balance).toBe('1500'); });
  it('폐기 양수 입력을 음수 기록으로 한 번만 변환한다', () => { const e = buildInventory(snapshot, { ...inbound, event_type: '폐기', quantity: '200' }, 'w', today); expect(e.quantity).toBe('-200'); expect(stock({ ...snapshot, inventoryEvents: [e] }).balance).toBe('800'); });
  it('0 실측은 빈칸이 아니라 실제 재고로 기록한다', () => { const e = buildInventory(snapshot, { ...inbound, event_type: '실사조정', quantity: '0' }, 'c', today); expect(e.counted_quantity).toBe('0'); expect(e.quantity).toBe('-1000'); expect(stock({ ...snapshot, inventoryEvents: [e] }).balance).toBe('0'); });
  it('실사 차이가 0이어도 실측 사실을 보전한다', () => { const e = buildInventory(snapshot, { ...inbound, event_type: '실사조정', quantity: '1000' }, 'c', today); expect(e.quantity).toBe('0'); expect(e.counted_quantity).toBe('1000'); });
  it('같은 재료·날짜 실사를 두 번 등록하지 않는다', () => { const e = buildInventory(snapshot, { ...inbound, event_type: '실사조정', quantity: '900' }, 'c', today); expect(() => buildInventory({ ...snapshot, inventoryEvents: [e] }, { ...inbound, event_type: '실사조정', quantity: '800' }, 'c2', today)).toThrow('같은 재료'); });
  it('실사 이후 과거 판매를 수정해도 당시 조정량을 바꾸지 않는다', () => { const count = buildInventory(snapshot, { ...inbound, date: '2026-09-20', event_type: '실사조정', quantity: '900' }, 'c', today); const sale = buildSale(seed, saleForm, 's', undefined, today); const state = { ...snapshot, sales: [sale], inventoryEvents: [count] }; const result = stock(state); expect(count.quantity).toBe('-100'); expect(result.balance).toBe('860'); expect(result.counted).toBe('900'); });
  it('음수 잔량을 0으로 숨기지 않는다', () => { const e = buildInventory(snapshot, { ...inbound, event_type: '폐기', quantity: '1200' }, 'w', today); expect(stock({ ...snapshot, inventoryEvents: [e] }).balance).toBe('-200'); });
  it('개 단위의 소수와 음수 실측·빈 입력을 거절한다', () => { expect(() => buildInventory(snapshot, { ...inbound, material_id: 'I10', quantity: '1.2' }, 'i', today)).toThrow('정수'); expect(() => buildInventory(snapshot, { ...inbound, event_type: '실사조정', quantity: '-1' }, 'i', today)).toThrow(); expect(() => buildInventory(snapshot, { ...inbound, quantity: '' }, 'i', today)).toThrow(); });
  it('입고 단위원가가 없거나 미래 날짜이면 거절한다', () => { expect(() => buildInventory(snapshot, { ...inbound, unit_cost: '' }, 'i', today)).toThrow('단위원가'); expect(() => buildInventory(snapshot, { ...inbound, date: '2026-10-13' }, 'i', today)).toThrow('오늘'); });
  it('초기재고가 없는 결과는 계산 불가다', () => { const s = { ...snapshot, seed: { ...fixture, opening_inventory: [] } }; expect(stock(s).balance).toBeNull(); });
  it('미래 월말을 자료가 없는 기간의 재고 예측으로 바꾸지 않는다', () => { expect(stockBasis({ seed, sales: seed.sales, inventoryEvents: seed.inventory_events, expenses: seed.expenses, revision: 0 }, '2026-09-30')).toBe('2026-09-18'); });
  it('비용 신규 기록은 추가, 수정은 기존 기록 기준을 보전한다', () => { const x = buildExpense(seed, costForm, 'x', undefined, today); expect(x.recognition).toBe('추가 직접 비용'); expect(buildExpense(seed, { ...costForm, amount: '2000' }, 'x', { ...x, recognition: '월비용 일할 배분' }, today).recognition).toBe('월비용 일할 배분'); });
  it('미등록 비용항목·음수 비용은 거절하고 0원은 기록한다', () => { expect(() => buildExpense(seed, { ...costForm, category: '새항목' }, 'x', undefined, today)).toThrow('비용항목'); expect(() => buildExpense(seed, { ...costForm, amount: '-1' }, 'x', undefined, today)).toThrow(); expect(buildExpense(seed, { ...costForm, amount: '0' }, 'x', undefined, today).amount).toBe('0'); });
  it('손익에서 원가·수수료·운영비를 한 번씩 빼고 월 계획을 더하지 않는다', () => { const sale = buildSale(seed, saleForm, 's', undefined, today); const expense = buildExpense(seed, costForm, 'x', undefined, today); const p = periodProfit({ ...snapshot, sales: [sale], expenses: [expense] }, 'day', '2026-09-19'); expect(p.net).toBe('8000'); expect(p.cost).toBe('993.6'); expect(p.operating).toBe('1000'); expect(p.profit).toBe('6006.4'); });
  it('전체 원본 9월 손익은 독립 집계 기대값과 일치한다', () => { const p = periodProfit({ seed, sales: seed.sales, inventoryEvents: seed.inventory_events, expenses: seed.expenses, revision: 0 }, 'month', '2026-09-01'); expect(p.net).toBe('13968930'); expect(p.cost).toBe('3546642.28'); expect(p.fee).toBe('209565'); expect(p.operating).toBe('3798010'); expect(p.profit).toBe('6414712.72'); });
  it('원본 11개 재료 잔량은 독립 계산과 일치한다', () => { const results = stocks({ seed, sales: seed.sales, inventoryEvents: seed.inventory_events, expenses: seed.expenses, revision: 0 }, '2026-09-18'); expect(results.map(x => x.balance)).toEqual(['4280', '23180', '2220', '1480', '484', '2860', '4200', '16', '13', '214', '112']); });
});

describe('저장·전체 백업·원자적 복원', () => {
  let db: IDBPDatabase, name: string;
  beforeEach(async () => { name = `ops-${crypto.randomUUID()}`; db = await connect(name); await initialize(db, async () => fixture); });
  afterEach(async () => { vi.restoreAllMocks(); db.close(); await deleteDB(name); });
  it('입고와 비용을 실제 보관하고 재연결에서 읽는다', async () => { await addInventory(db, inbound, 'i', 0, today); await saveExpense(db, costForm, 'x', 1, 'add', today); db.close(); db = await connect(name); const s = await readSnapshot(db); expect(s.inventoryEvents[0].quantity).toBe('500'); expect(s.expenses[0].amount).toBe('1000'); expect(s.revision).toBe(2); });
  it('비용 수정·삭제는 같은 ID의 기록에만 적용한다', async () => { await saveExpense(db, costForm, 'x', 0, 'add', today); await saveExpense(db, { ...costForm, amount: '2000' }, 'x', 1, 'edit', today); expect((await readSnapshot(db)).expenses[0].amount).toBe('2000'); await saveExpense(db, undefined, 'x', 2, 'delete'); expect((await readSnapshot(db)).expenses).toHaveLength(0); expect((await readSnapshot(db)).seed.monthly_expense_plan).toHaveLength(120); });
  it('오래된 탭과 재고 중복 요청을 거절한다', async () => { await addInventory(db, inbound, 'i', 0, today); await expect(addInventory(db, inbound, 'i', 0, today)).rejects.toThrow('다른 탭'); expect((await readSnapshot(db)).inventoryEvents).toHaveLength(1); });
  it('전체 백업에는 현재 기록과 11개 기준·운영 배열이 있다', async () => { await mutate(db, { kind: 'add', form: saleForm, id: 's', revision: 0, today }); await addInventory(db, inbound, 'i', 1, today); await saveExpense(db, costForm, 'x', 2, 'add', today); const b = await createBackup(db); expect(Object.keys(b.data)).toHaveLength(11); expect(b.counts.sales).toBe(1); expect(b.counts.inventoryEvents).toBe(1); expect(b.counts.expenses).toBe(1); expect(validateBackup(b).seed.sales[0].sale_id).toBe('s'); });
  it('백업 후 바뀐 모든 운영 기록을 전체 대체한다', async () => { const backup = await createBackup(db); await mutate(db, { kind: 'add', form: saleForm, id: 's', revision: 0, today }); await addInventory(db, inbound, 'i', 1, today); await saveExpense(db, costForm, 'x', 2, 'add', today); await replaceDataset(db, validateBackup(backup).seed, 3); const after = await readSnapshot(db); expect(after.sales).toHaveLength(0); expect(after.inventoryEvents).toHaveLength(0); expect(after.expenses).toHaveLength(0); expect(after.seed.recipes).toHaveLength(fixture.recipes.length); expect(after.seed.recipes).toEqual(expect.arrayContaining(fixture.recipes)); expect(after.revision).toBe(4); });
  it('깨진 JSON·원본 JSON·요약 파일은 거절한다', () => { expect(() => parseBackup('{broken')).toThrow('JSON'); expect(() => validateBackup(seed)).toThrow('전체 백업'); expect(() => validateBackup({ salesCount: 6112 })).toThrow('전체 백업'); });
  it('파일 형식 버전·정책·다른 매장은 거절한다', async () => { const b = await createBackup(db); expect(() => validateBackup({ ...b, backupVersion: 2 })).toThrow(); expect(() => validateBackup({ ...b, sourceMeta: { ...b.sourceMeta, dataset_id: 'other' } })).toThrow('다른 매장'); expect(() => validateBackup({ ...b, policies: { ...b.policies, operations: { ...b.policies.operations, version: 'future' } } })).toThrow('정책'); });
  it('기록 수 불일치와 누락 구역은 거절한다', async () => { const b = await createBackup(db); expect(() => validateBackup({ ...b, counts: { ...b.counts, sales: 99 } })).toThrow('기록 수'); const bad = structuredClone(b); delete (bad.data as any).recipes; expect(() => validateBackup(bad)).toThrow('구역'); });
  it('중복ID·없는 재료·단위 불일치는 복원 전 차단한다', async () => { await addInventory(db, inbound, 'i', 0, today); const b = await createBackup(db); const dup = structuredClone(b); dup.data.inventoryEvents.push(dup.data.inventoryEvents[0]); dup.counts.inventoryEvents++; expect(() => validateBackup(dup)).toThrow('중복'); const bad = structuredClone(b); (bad.data.inventoryEvents[0] as any).material_id = 'none'; expect(() => validateBackup(bad)).toThrow('재료'); const unit = structuredClone(b); (unit.data.inventoryEvents[0] as any).unit = 'ml'; expect(() => validateBackup(unit)).toThrow('단위'); });
  it('검증 후 기록 변경이 있으면 복원하지 않는다', async () => { const b = await createBackup(db); await saveExpense(db, costForm, 'x', 0, 'add', today); await expect(replaceDataset(db, validateBackup(b).seed, 0)).rejects.toThrow('변경'); expect((await readSnapshot(db)).expenses).toHaveLength(1); });
  it('복원 중 쓰기 실패면 삭제·삽입을 포함해 전체 취소한다', async () => { const b = await createBackup(db); await addInventory(db, inbound, 'i', 0, today); await saveExpense(db, costForm, 'x', 1, 'add', today); const original = IDBObjectStore.prototype.put; vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) { if (this.name === 'appMeta') throw new DOMException('full', 'QuotaExceededError'); return original.apply(this, args); }); await expect(replaceDataset(db, validateBackup(b).seed, 2)).rejects.toThrow('full'); vi.restoreAllMocks(); const s = await readSnapshot(db); expect(s.inventoryEvents).toHaveLength(1); expect(s.expenses).toHaveLength(1); expect(s.revision).toBe(2); });
  it('입고 저장 실패도 원본을 유지한다', async () => { const original = IDBObjectStore.prototype.put; vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) { if (this.name === 'appMeta') throw new DOMException('full', 'QuotaExceededError'); return original.apply(this, args); }); await expect(addInventory(db, inbound, 'i', 0, today)).rejects.toThrow('full'); vi.restoreAllMocks(); expect((await readSnapshot(db)).inventoryEvents).toHaveLength(0); });
  it('11,187개 실제 샘플 전체의 백업·복원도 검사한다', async () => {
    await replaceDataset(db, seed, 0); const b = await createBackup(db); const validated = validateBackup(b);
    expect(b.counts.sales).toBe(6112); expect(b.counts.inventoryEvents).toBe(1515); expect(b.counts.expenses).toBe(3560);
    const x = seed.expenses[0]; await saveExpense(db, { date: x.date, category: x.category, amount: '99999' }, x.expense_id, 1, 'edit', today);
    await replaceDataset(db, validated.seed, 2); const result = await readSnapshot(db);
    expect(result.expenses.find(r => r.expense_id === x.expense_id)?.amount).toBe(x.amount);
    expect(result.sales).toHaveLength(6112); expect(result.inventoryEvents).toHaveLength(1515);
    const started = performance.now(); const balance = stocks(result, '2026-09-18'); console.info(`[perf] full-sample-stock ${Math.round(performance.now() - started)}ms`); expect(balance.find(m => m.material_id === 'I01')?.balance).toBe('4280');
  }, 30000);
});

