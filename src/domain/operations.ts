import Decimal from 'decimal.js';
import { z } from 'zod';
import { type Snapshot, type InventoryEvent, type Expense, type Seed } from './model';
import { aggregate, cumulativeUsage, inPeriod, isRealDate, todayKorea } from './sales';

const numberInput = z.string().regex(/^\d+(\.\d{1,2})?$/, '0 이상의 숫자를 소수 둘째 자리까지 입력하세요.').refine(v => /^\d+(\.\d{1,2})?$/.test(v) && new Decimal(v).lte('1000000000000'), '입력 금액·수량을 확인하세요.');
const dateInput = z.string().refine(isRealDate, '실제 날짜를 선택하세요.');
export const inventoryFormSchema = z.object({ date: dateInput, material_id: z.string().min(1), event_type: z.enum(['입고', '폐기', '실사조정']), quantity: numberInput, reason: z.string().trim().min(1, '입고·폐기·실사 사유를 입력하세요.').max(500, '사유는 500자 이하로 입력하세요.'), unit_cost: z.string(), });
export type InventoryForm = z.infer<typeof inventoryFormSchema>;
export const expenseFormSchema = z.object({ date: dateInput, category: z.string().min(1, '비용항목을 선택하세요.'), amount: numberInput });
export type ExpenseForm = z.infer<typeof expenseFormSchema>;
export function checkOperatingDate(seed: Seed, date: string, today = todayKorea()) { if (date < seed.meta.start_date || date > today) throw new Error(`날짜는 ${seed.meta.start_date}부터 오늘(${today})까지 입력하세요.`); }
export function periodEnd(mode: 'day' | 'month', date: string) { if (mode === 'day') return date; const d = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0, 12)); return d.toISOString().slice(0, 10); }
export function stockBasis(snapshot: Snapshot, through: string) {
  const dates = [snapshot.seed.meta.as_of, ...snapshot.sales.map(x => x.date), ...snapshot.inventoryEvents.map(x => x.date)].filter(x => x <= through).sort();
  return through < snapshot.seed.meta.as_of ? through : dates.at(-1) ?? through;
}
export interface StockRow { material_id: string; name: string; unit: string; opening: string | null; inbound: string; waste: string; consumed: string; adjustment: string; balance: string | null; counted: string | null; countedDate: string | null; reason: string }
export function stocks(snapshot: Snapshot, through: string): StockRow[] {
  const consumed = cumulativeUsage(snapshot.seed, snapshot.sales, through);
  const byStart = new Map<string, Record<string, string>>();
  byStart.set(snapshot.seed.meta.start_date, consumed);
  return snapshot.seed.materials.map(m => {
    const opens = snapshot.seed.opening_inventory.filter(x => x.material_id === m.material_id && x.date <= through);
    if (opens.length !== 1) return { material_id: m.material_id, name: m.name, unit: m.unit, opening: null, inbound: '0', waste: '0', consumed: consumed[m.material_id] ?? '0', adjustment: '0', balance: null, counted: null, countedDate: null, reason: '유효한 초기재고가 없거나 여러 개입니다.' };
    const events = snapshot.inventoryEvents.filter(x => x.material_id === m.material_id && x.date >= opens[0].date && x.date <= through);
    const sum = (type: InventoryEvent['event_type']) => events.filter(x => x.event_type === type).reduce((n, x) => n.add(x.quantity), new Decimal(0));
    const inbound = sum('입고'), waste = sum('폐기'), adjustment = sum('실사조정');
    const latestCount = events.filter(x => x.event_type === '실사조정').sort((a, b) => b.date.localeCompare(a.date))[0];
    if (!byStart.has(opens[0].date)) byStart.set(opens[0].date, cumulativeUsage(snapshot.seed, snapshot.sales.filter(s => s.date >= opens[0].date), through));
    const used = byStart.get(opens[0].date)![m.material_id] ?? '0';
    return { material_id: m.material_id, name: m.name, unit: m.unit, opening: String(opens[0].quantity), inbound: inbound.toString(), waste: waste.toString(), consumed: used, adjustment: adjustment.toString(), balance: new Decimal(opens[0].quantity).add(inbound).add(waste).add(adjustment).sub(used).toString(), counted: latestCount?.counted_quantity ?? null, countedDate: latestCount?.date ?? null, reason: '' };
  });
}
export function buildInventory(snapshot: Snapshot, form: InventoryForm, id: string, today = todayKorea()): InventoryEvent {
  const f = inventoryFormSchema.parse(form); checkOperatingDate(snapshot.seed, f.date, today);
  const material = snapshot.seed.materials.find(x => x.material_id === f.material_id);
  if (!material) throw new Error('등록된 재료를 선택하세요.');
  const q = new Decimal(f.quantity);
  if (material.unit === '개' && !q.isInteger()) throw new Error('개 단위 수량은 정수로 입력하세요.');
  if (f.event_type !== '실사조정' && q.lte(0)) throw new Error('입고·폐기 수량은 0보다 커야 합니다.');
  const row: InventoryEvent = { event_id: id, date: f.date, material_id: f.material_id, event_type: f.event_type, quantity: q.toString(), unit: material.unit, reason: f.reason };
  if (f.event_type === '폐기') row.quantity = q.neg().toString();
  if (f.event_type === '입고') {
    if (!/^\d+(\.\d{1,6})?$/.test(f.unit_cost) || new Decimal(f.unit_cost).gt('1000000000000')) throw new Error('입고 단위원가를 0 이상, 소수 여섯째 자리까지 입력하세요.');
    row.unit_cost = new Decimal(f.unit_cost).toString();
    const supplier = material.supplier_id;
    if (typeof supplier === 'string') row.supplier_id = supplier;
  }
  if (f.event_type === '실사조정') {
    if (snapshot.inventoryEvents.some(x => x.event_type === '실사조정' && x.material_id === f.material_id && x.date === f.date)) throw new Error('같은 재료·날짜의 실사 기록이 있습니다. 하루 한 번의 마감 실사만 기록합니다.');
    const stock = stocks(snapshot, f.date).find(x => x.material_id === f.material_id)!;
    if (stock.balance === null) throw new Error('기록 잔량을 구할 수 없어 실사 차이를 계산하지 못했습니다.');
    row.counted_quantity = q.toString(); row.quantity = q.sub(stock.balance).toString();
  }
  return row;
}
export function categories(seed: Seed) { return [...new Set(seed.monthly_expense_plan.map(x => x.category))]; }
export function buildExpense(seed: Seed, form: ExpenseForm, id: string, previous?: Expense, today = todayKorea()): Expense {
  const f = expenseFormSchema.parse(form); checkOperatingDate(seed, f.date, today);
  if (!categories(seed).includes(f.category)) throw new Error('제공 자료의 비용항목을 선택하세요.');
  return { expense_id: id, date: f.date, category: f.category, amount: new Decimal(f.amount).toString(), recognition: previous?.recognition ?? '추가 직접 비용' };
}
export function periodProfit(snapshot: Snapshot, mode: 'day' | 'month', date: string) {
  const a = aggregate(snapshot.sales.filter(x => inPeriod(x, mode, date)));
  const expenses = snapshot.expenses.filter(x => inPeriod({ date: x.date } as any, mode, date));
  const operating = expenses.reduce((n, x) => n.add(x.amount), new Decimal(0));
  return { ...a, operating: operating.toString(), expenseCount: expenses.length, totalCost: a.cost === null || a.fee === null ? null : new Decimal(a.cost).add(a.fee).add(operating).toString(), profit: a.contribution === null ? null : new Decimal(a.contribution).sub(operating).toString() };
}
