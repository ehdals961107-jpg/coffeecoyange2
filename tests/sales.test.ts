import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { deleteDB, type IDBPDatabase } from 'idb';
import { validateSeed, type Seed, type SaleForm } from '../src/domain/model';
import { aggregate, buildSale, cumulativeUsage, deriveCost, formatMoney, formSchema, inPeriod, isRealDate, metrics, usage } from '../src/domain/sales';
import { connect, initialize, mutate, readSnapshot } from '../src/storage/repository';

const raw = JSON.parse(readFileSync('public/sample/store-operations.json', 'utf8'));
const seed = validateSeed(raw);
const form: SaleForm = { date: '2026-09-19', menu_id: 'M01', channel: '포장', quantity: '10', unit_price: '4000', discount_amount: '1000', payment_fee: '500' };
const make = (changes: Partial<SaleForm> = {}) => buildSale(seed, { ...form, ...changes }, 'new', undefined, '2026-10-12');

describe('자료와 판매 계산', () => {
  it('실제 제공 자료 개수와 과거 금액을 보존한다', () => { expect(seed.sales).toHaveLength(6112); expect(seed.menus).toHaveLength(8); expect(seed.materials).toHaveLength(11); expect(seed.sales[0].unit_food_cost_snapshot).toBe('460'); expect(seed.sales[0].net_sales).toBe('80000'); });
  it('중복 판매 식별번호를 거절한다', () => { expect(() => validateSeed({ ...raw, sales: [...raw.sales, raw.sales[0]] })).toThrow('중복'); });
  it('재료 단위 연결 오류를 거절한다', () => { const r = structuredClone(raw); r.recipes[0].unit = 'ml'; expect(() => validateSeed(r)).toThrow('단위'); });
  it('구매 묶음 가격을 단위당 가격으로 바꾸고 적용일 가격을 찾는다', () => { expect(deriveCost(seed, '2025-07-01', 'M01', '포장', 'R1')).toEqual({ food: '460', pack: '160' }); expect(deriveCost(seed, '2026-09-19', 'M01', '포장', 'R1')).toEqual({ food: '496.8', pack: '166.4' }); });
  it('할인과 결제수수료까지 빼서 남는 금액을 구한다', () => { const s = make(); expect(s.net_sales).toBe('39000'); const m = metrics(s); expect(m.cost).toBe('6632'); expect(m.contribution).toBe('31868'); expect(Number(m.ratio)).toBeCloseTo(81.71282051, 7); });
  it('큰 금액도 표시 과정에서 소수를 잃지 않는다', () => { expect(formatMoney('1000000000000000.01')).toBe('1,000,000,000,000,000.01'); expect(formatMoney('-0.01')).toBe('-0.01'); });
  it('빈 입력은 숫자 계산 오류 대신 항목별 검사 결과를 반환한다', () => { const result = formSchema.safeParse({ ...form, quantity: '', payment_fee: '' }); expect(result.success).toBe(false); if (!result.success) expect(result.error.issues.map(i => i.path[0])).toEqual(expect.arrayContaining(['quantity', 'payment_fee'])); });
  it('매장에는 포장 원가와 포장재 소진을 넣지 않는다', () => { const s = make({ channel: '매장' }); expect(s.unit_packaging_cost_snapshot).toBe('0'); expect(usage(seed, s)).toEqual([{ material_id: 'I01', name: '원두', unit: 'g', quantity: '200' }]); });
  it('포장에는 컵 사용량을 반영한다', () => { expect(usage(seed, make()).find(x => x.material_id === 'I10')?.quantity).toBe('10'); });
  it('0원 판매는 비용과 손실을 표시하고 비율은 계산하지 않는다', () => { const s = make({ unit_price: '0', discount_amount: '0', payment_fee: '0' }); expect(metrics(s).contribution).toBe('-6632'); expect(metrics(s).ratio).toBeNull(); });
  it.each([{ quantity: '0' }, { quantity: '1.5' }, { quantity: '' }, { payment_fee: '' }, { payment_fee: '-1' }, { unit_price: '-1' }, { discount_amount: '40001' }, { discount_amount: '-1' }])('잘못된 입력 %j를 저장 가능한 기록으로 만들지 않는다', invalid => { expect(() => make(invalid)).toThrow(); });
  it('실제 날짜와 미래 날짜를 검사한다', () => { expect(isRealDate('2026-02-30')).toBe(false); expect(() => make({ date: '2026-02-30' })).toThrow('실제'); expect(() => make({ date: '2026-10-13' })).toThrow('오늘'); });
  it('없는 가격을 0이나 최신 가격으로 대신하지 않는다', () => { const missing = { ...seed, price_history: seed.price_history.filter(x => x.material_id !== 'I01') }; expect(() => buildSale(missing, form, 'x', undefined, '2026-10-12')).toThrow('가격'); });
  it('수량 변경은 과거 원가를 유지한다', () => { const old = make(); const previous = { ...old, unit_food_cost_snapshot: '999' }; expect(buildSale(seed, { ...form, quantity: '11' }, 'new', previous, '2026-10-12').unit_food_cost_snapshot).toBe('999'); });
  it('판매일과 채널 변경은 해당 날짜·채널 원가를 재적용한다', () => { const previous = { ...make(), unit_food_cost_snapshot: '999' }; const s = buildSale(seed, { ...form, date: '2025-07-01', channel: '매장' }, 'new', previous, '2026-10-12'); expect(s.unit_food_cost_snapshot).toBe('460'); expect(s.unit_packaging_cost_snapshot).toBe('0'); });
  it('기간 비율은 행별 비율 평균이 아니라 전체 금액 비율이다', () => { const a = { ...make(), net_sales: '100', quantity: 1, unit_food_cost_snapshot: '10', unit_packaging_cost_snapshot: '0', payment_fee: '0' }; const b = { ...a, sale_id: 'b', net_sales: '900', unit_food_cost_snapshot: '450' }; const result = aggregate([a, b]); expect(result.net).toBe('1000'); expect(result.contribution).toBe('540'); expect(result.ratio).toBe('54'); });
  it('누락 원가는 합계를 불완전으로 만들고 실제 0과 구분한다', () => { const r = aggregate([make(), { ...make(), unit_food_cost_snapshot: null }]); expect(r.missing).toBe(1); expect(r.cost).toBeNull(); expect(r.contribution).toBeNull(); expect(r.net).toBe('78000'); });
  it('일·월 조회는 기록의 날짜를 기준으로 한다', () => { const s = make(); expect(inPeriod(s, 'day', '2026-09-18')).toBe(false); expect(inPeriod(s, 'month', '2026-09-01')).toBe(true); expect(inPeriod(s, 'month', '2026-10-01')).toBe(false); });
  it('판매 수정·삭제가 재료 사용량에서 이중 반영되지 않는다', () => { const s = make(); expect(cumulativeUsage(seed, [s], s.date)).toEqual({ I01: '200', I10: '10' }); expect(cumulativeUsage(seed, [{ ...s, quantity: 11 }], s.date)).toEqual({ I01: '220', I10: '11' }); expect(cumulativeUsage(seed, [], s.date)).toEqual({}); });
});

describe('실제 저장 논리', () => {
  let db: IDBPDatabase; let name: string;
  const fixture: Seed = { ...seed, sales: [], inventory_events: [], expenses: [], monthly_expense_plan: [] };
  beforeEach(async () => { name = `test-${crypto.randomUUID()}`; db = await connect(name); await initialize(db, async () => fixture); });
  afterEach(async () => { vi.restoreAllMocks(); db.close(); await deleteDB(name); });
  it('재실행해도 샘플을 두 번 가져오지 않는다', async () => { await mutate(db, { kind: 'add', form, id: 'a', revision: 0, today: '2026-10-12' }); const loader = vi.fn(); const snap = await initialize(db, loader); expect(loader).not.toHaveBeenCalled(); expect(snap.sales).toHaveLength(1); });
  it('닫고 다시 연결해도 실제 보관된 판매를 읽는다', async () => { await mutate(db, { kind: 'add', form, id: 'a', revision: 0, today: '2026-10-12' }); db.close(); db = await connect(name); expect((await readSnapshot(db)).sales[0].net_sales).toBe('39000'); });
  it('수정은 같은 ID의 기록을 바꾼다', async () => { await mutate(db, { kind: 'add', form, id: 'a', revision: 0, today: '2026-10-12' }); await mutate(db, { kind: 'edit', form: { ...form, quantity: '11' }, id: 'a', revision: 1, today: '2026-10-12' }); const s = await readSnapshot(db); expect(s.sales).toHaveLength(1); expect(s.sales[0].quantity).toBe(11); expect(s.revision).toBe(2); });
  it('삭제 후에는 기록과 재료 사용량에서 제외된다', async () => { await mutate(db, { kind: 'add', form, id: 'a', revision: 0, today: '2026-10-12' }); await mutate(db, { kind: 'delete', id: 'a', revision: 1 }); expect((await readSnapshot(db)).sales).toHaveLength(0); });
  it('날짜·메뉴·채널 중복을 차단하고 원본을 보존한다', async () => { await mutate(db, { kind: 'add', form, id: 'a', revision: 0, today: '2026-10-12' }); await expect(mutate(db, { kind: 'add', form, id: 'b', revision: 1, today: '2026-10-12' })).rejects.toThrow('같은 날짜'); const s = await readSnapshot(db); expect(s.sales).toHaveLength(1); expect(s.revision).toBe(1); });
  it('오래된 탭과 반복 요청을 차단한다', async () => { await mutate(db, { kind: 'add', form, id: 'a', revision: 0, today: '2026-10-12' }); await expect(mutate(db, { kind: 'add', form, id: 'a', revision: 0, today: '2026-10-12' })).rejects.toThrow('다른 탭'); expect((await readSnapshot(db)).sales).toHaveLength(1); });
  it('없는 수정·삭제 대상은 변경하지 않는다', async () => { await expect(mutate(db, { kind: 'delete', id: 'missing', revision: 0 })).rejects.toThrow('대상'); expect((await readSnapshot(db)).revision).toBe(0); });
  it('검사 실패는 기록과 변경번호를 모두 보존한다', async () => { await expect(mutate(db, { kind: 'add', form: { ...form, quantity: '0' }, id: 'a', revision: 0, today: '2026-10-12' })).rejects.toThrow(); const s = await readSnapshot(db); expect(s.sales).toHaveLength(0); expect(s.revision).toBe(0); });
  it('쓰기 실패는 부분 저장을 남기지 않는다', async () => { const original = IDBObjectStore.prototype.put; vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) { if (this.name === 'appMeta') throw new DOMException('full', 'QuotaExceededError'); return original.apply(this, args); }); await expect(mutate(db, { kind: 'add', form, id: 'a', revision: 0, today: '2026-10-12' })).rejects.toThrow('full'); vi.restoreAllMocks(); const s = await readSnapshot(db); expect(s.sales).toHaveLength(0); expect(s.revision).toBe(0); });
  it('메뉴·날짜 이동은 이전 조합에서 빠지고 새 조합에만 남는다', async () => { await mutate(db, { kind: 'add', form, id: 'a', revision: 0, today: '2026-10-12' }); await mutate(db, { kind: 'edit', form: { ...form, date: '2026-09-20', menu_id: 'M02' }, id: 'a', revision: 1, today: '2026-10-12' }); const s = await readSnapshot(db); expect(s.sales.filter(x => inPeriod(x, 'day', '2026-09-19'))).toHaveLength(0); expect(s.sales[0].menu_id).toBe('M02'); });
});

