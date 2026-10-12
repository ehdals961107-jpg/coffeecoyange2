import { z } from 'zod';

const amount = z.union([z.number().finite().nonnegative(), z.string().regex(/^\d+(\.\d+)?$/)]).transform(String);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const d = new Date(`${v}T12:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v; }, '실제 존재하는 날짜가 아닙니다.');
const signedAmount = z.union([z.number().finite(), z.string().regex(/^-?\d+(\.\d+)?$/)]).transform(String);
export const inventorySchema = z.object({ event_id: z.string().min(1), date: day, material_id: z.string().min(1), event_type: z.enum(['입고', '폐기', '실사조정']), quantity: signedAmount, unit: z.enum(['g', 'ml', '개']), reason: z.string(), unit_cost: amount.optional(), supplier_id: z.string().optional(), counted_quantity: amount.optional() });
export const expenseSchema = z.object({ expense_id: z.string().min(1), date: day, category: z.string().min(1), amount, recognition: z.string().min(1) });
export const monthlyPlanSchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), category: z.string().min(1), amount });
export type InventoryEvent = z.output<typeof inventorySchema>;
export type Expense = z.output<typeof expenseSchema>;
export const saleSchema = z.object({
  sale_id: z.string().min(1), date: day, menu_id: z.string().min(1), channel: z.enum(['매장', '포장']), quantity: z.number().int().positive(),
  unit_price: amount, discount_amount: amount, net_sales: amount, payment_fee: amount.nullable(), recipe_version: z.string().min(1),
  unit_food_cost_snapshot: amount.nullable(), unit_packaging_cost_snapshot: amount.nullable(),
});
export type Sale = z.output<typeof saleSchema>;
export const seedSchema = z.object({
  meta: z.object({ dataset_id: z.string(), version: z.string(), store_name: z.string(), start_date: day, as_of: day, currency: z.literal('KRW'), amount_basis: z.string() }).passthrough(),
  settings: z.record(z.string(), z.unknown()),
  suppliers: z.array(z.object({ supplier_id: z.string(), name: z.string() }).passthrough()),
  materials: z.array(z.object({ material_id: z.string(), name: z.string(), unit: z.enum(['g', 'ml', '개']), pack_quantity: z.number().positive(), base_pack_price: z.number().nonnegative() }).passthrough()),
  menus: z.array(z.object({ menu_id: z.string(), name: z.string(), price: z.number().nonnegative(), category: z.string(), recipe_version: z.string() })),
  recipes: z.array(z.object({ recipe_version: z.string(), menu_id: z.string(), material_id: z.string(), quantity: z.number().positive(), unit: z.enum(['g', 'ml', '개']), channel_only: z.enum(['매장', '포장']).optional() })),
  price_history: z.array(z.object({ material_id: z.string(), effective_date: day, pack_price: z.number().nonnegative(), pack_quantity: z.number().positive() })),
  calendar: z.array(z.object({ date: day, is_open: z.boolean(), record_complete: z.boolean(), weather: z.string(), note: z.string() })),
  opening_inventory: z.array(z.object({ material_id: z.string(), date: day, quantity: z.number().nonnegative(), unit: z.enum(['g', 'ml', '개']) })),
  sales: z.array(saleSchema),
  inventory_events: z.array(inventorySchema), expenses: z.array(expenseSchema), monthly_expense_plan: z.array(monthlyPlanSchema),
});
export type Seed = z.output<typeof seedSchema>;
export interface Snapshot { seed: Seed; sales: Sale[]; inventoryEvents: InventoryEvent[]; expenses: Expense[]; revision: number }
export interface SaleForm { date: string; menu_id: string; channel: '매장' | '포장'; quantity: string; unit_price: string; discount_amount: string; payment_fee: string }
export const POLICIES = {
  version: 'epic1-v1', fee: 'explicit-total-amount', duplicate: 'reject-date-menu-channel',
  newCost: 'effective-price-history', editCost: 'preserve-unless-date-menu-channel-changes',
  zeroPrice: 'allowed', futureDate: 'reject', closedDate: 'allow-correction-without-calendar-change',
  displayAmountDecimals: 2, displayRatioDecimals: 1, arithmeticPrecision: 28,
};
export const OPERATING_POLICIES = {
  version: 'operations-v1', countAdjustment: 'preserve-fixed-delta', countTiming: 'end-of-day-after-sales-receipts-waste',
  countPerMaterialDay: 'one', zeroCount: 'record', negativeStock: 'display-do-not-clamp', waste: 'positive-input-negative-record',
  expense: 'new-is-additional-edit-existing-to-correct', expensePlan: 'reference-only', wasteProfit: 'excluded-disclosed',
  backup: 'full-json-v1', restore: 'validate-then-replace-all', maxBackupBytes: 50 * 1024 * 1024,
};

export function validateSeed(raw: unknown): Seed {
  const s = seedSchema.parse(raw);
  const unique = (values: string[], label: string) => { if (new Set(values).size !== values.length) throw new Error(`${label}에 중복 식별번호가 있습니다.`); };
  unique(s.menus.map(x => x.menu_id), '메뉴'); unique(s.materials.map(x => x.material_id), '재료'); unique(s.suppliers.map(x => x.supplier_id), '공급사');
  unique(s.sales.map(x => x.sale_id), '판매'); unique(s.sales.map(x => `${x.date}|${x.menu_id}|${x.channel}`), '날짜·메뉴·채널');
  unique(s.calendar.map(x => x.date), '영업달력');
  unique(s.price_history.map(x => `${x.material_id}|${x.effective_date}`), '재료가격');
  unique(s.recipes.map(x => `${x.recipe_version}|${x.menu_id}|${x.material_id}|${x.channel_only ?? '*'}`), '레시피');
  for (const x of s.recipes) {
    const material = s.materials.find(m => m.material_id === x.material_id);
    if (!s.menus.some(m => m.menu_id === x.menu_id) || !material || material.unit !== x.unit) throw new Error('레시피의 메뉴·재료·단위 연결이 올바르지 않습니다.');
  }
  for (const x of s.sales) if (!s.menus.some(m => m.menu_id === x.menu_id) || !s.recipes.some(r => r.menu_id === x.menu_id && r.recipe_version === x.recipe_version)) throw new Error('판매의 메뉴·레시피 연결이 없습니다.');
  for (const x of [...s.price_history, ...s.opening_inventory]) if (!s.materials.some(m => m.material_id === x.material_id)) throw new Error('기준 자료의 재료 연결이 없습니다.');
  unique(s.inventory_events.map(x => x.event_id), '재고');
  unique(s.expenses.map(x => x.expense_id), '비용');
  unique(s.monthly_expense_plan.map(x => `${x.month}|${x.category}`), '월 비용계획');
  unique(s.opening_inventory.map(x => `${x.material_id}|${x.date}`), '초기재고');
  unique(s.inventory_events.filter(x => x.event_type === '실사조정').map(x => `${x.date}|${x.material_id}`), '실사');
  for (const row of s.inventory_events) {
    const material = s.materials.find(x => x.material_id === row.material_id);
    if (!material || material.unit !== row.unit) throw new Error('재고기록의 재료·단위 연결이 올바르지 않습니다.');
    if (row.supplier_id && !s.suppliers.some(x => x.supplier_id === row.supplier_id)) throw new Error('입고 공급사 연결이 없습니다.');
    if ((row.event_type === '입고' && Number(row.quantity) <= 0) || (row.event_type === '폐기' && Number(row.quantity) >= 0)) throw new Error('입고·폐기 수량의 부호가 올바르지 않습니다.');
    if (row.event_type === '실사조정' && row.counted_quantity === undefined) throw new Error('실사에 실제 센 수량이 없습니다.');
    if (row.unit === '개' && (!Number.isInteger(Number(row.quantity)) || (row.counted_quantity !== undefined && !Number.isInteger(Number(row.counted_quantity))))) throw new Error('개 단위는 정수 수량이어야 합니다.');
  }
  for (const x of s.opening_inventory) if (s.materials.find(m => m.material_id === x.material_id)?.unit !== x.unit) throw new Error('초기재고 단위가 올바르지 않습니다.');
  return s;
}
