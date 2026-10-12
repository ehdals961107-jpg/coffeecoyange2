import Decimal from 'decimal.js';
import { z } from 'zod';
import type { Sale, SaleForm, Seed } from './model';
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });
const numeric = z.string().regex(/^\d+(\.\d{1,2})?$/, '0 이상의 숫자를 입력하세요. 소수는 둘째 자리까지 가능합니다.');
const integer = z.string().regex(/^\d+$/, '1 이상의 정수 수량을 입력하세요.').refine(v => Number.isSafeInteger(Number(v)) && Number(v) > 0 && Number(v) <= 1000000, '수량은 1~1,000,000의 정수로 입력하세요.');
export const formSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '날짜를 선택하세요.'), menu_id: z.string().min(1, '메뉴를 선택하세요.'), channel: z.enum(['매장', '포장']), quantity: integer, unit_price: numeric, discount_amount: numeric, payment_fee: numeric }).superRefine((v, ctx) => {
  if (!/^\d+$/.test(v.quantity) || ![v.unit_price, v.discount_amount, v.payment_fee].every(x => /^\d+(\.\d{1,2})?$/.test(x))) return;
  const base = new Decimal(v.quantity).mul(v.unit_price);
  if (new Decimal(v.discount_amount).gt(base)) ctx.addIssue({ code: 'custom', path: ['discount_amount'], message: '총 할인은 할인 전 매출을 초과할 수 없습니다.' });
  for (const key of ['unit_price', 'discount_amount', 'payment_fee'] as const) if (new Decimal(v[key]).gt('1000000000000')) ctx.addIssue({ code: 'custom', path: [key], message: '금액은 1조 원 이하로 입력하세요.' });
});

export function todayKorea(): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (k: string) => parts.find(x => x.type === k)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
export function usage(seed: Seed, sale: Pick<Sale, 'menu_id' | 'recipe_version' | 'channel' | 'quantity'>) {
  const rows = seed.recipes.filter(r => r.menu_id === sale.menu_id && r.recipe_version === sale.recipe_version && (!r.channel_only || r.channel_only === sale.channel));
  if (!rows.length) throw new Error('적용할 레시피가 없습니다.');
  return rows.map(r => {
    const material = seed.materials.find(m => m.material_id === r.material_id);
    if (!material || material.unit !== r.unit) throw new Error('재료와 레시피 단위가 일치하지 않습니다.');
    return { material_id: r.material_id, name: material.name, unit: r.unit, quantity: new Decimal(r.quantity).mul(sale.quantity).toString() };
  });
}
export function cumulativeUsage(seed: Seed, sales: Sale[], through: string) {
  const totals: Record<string, Decimal> = {};
  const recipes = new Map<string, { material_id: string; quantity: Decimal }[]>();
  for (const s of sales) {
    if (s.date > through) continue;
    const key = `${s.menu_id}|${s.recipe_version}|${s.channel}`;
    let rows = recipes.get(key);
    if (!rows) { rows = usage(seed, { ...s, quantity: 1 }).map(x => ({ material_id: x.material_id, quantity: new Decimal(x.quantity) })); recipes.set(key, rows); }
    for (const x of rows) totals[x.material_id] = (totals[x.material_id] ?? new Decimal(0)).add(x.quantity.mul(s.quantity));
  }
  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value.toString()]));
}
export function deriveCost(seed: Seed, date: string, menu_id: string, channel: '매장' | '포장', recipe_version: string) {
  let food = new Decimal(0), pack = new Decimal(0);
  const rows = usage(seed, { menu_id, channel, recipe_version, quantity: 1 });
  for (const r of rows) {
    const p = seed.price_history.filter(x => x.material_id === r.material_id && x.effective_date <= date).sort((a, b) => b.effective_date.localeCompare(a.effective_date))[0];
    if (!p) throw new Error(`${r.name}의 판매일 가격이 없습니다. 저장하지 않았습니다.`);
    const cost = new Decimal(p.pack_price).div(p.pack_quantity).mul(r.quantity);
    if (['I10', 'I11'].includes(r.material_id)) pack = pack.add(cost); else food = food.add(cost);
  }
  return { food: food.toString(), pack: pack.toString() };
}
export function buildSale(seed: Seed, form: SaleForm, id: string, previous?: Sale, today = todayKorea()): Sale {
  const v = formSchema.parse(form);
  if (!isRealDate(v.date)) throw new Error('실제 존재하는 날짜를 선택하세요.');
  if (v.date < seed.meta.start_date || v.date > today) throw new Error(`날짜는 ${seed.meta.start_date}부터 오늘(${today})까지 입력하세요.`);
  const menu = seed.menus.find(x => x.menu_id === v.menu_id);
  if (!menu) throw new Error('제공 자료에 없는 메뉴입니다.');
  const preserve = previous && previous.date === v.date && previous.menu_id === v.menu_id && previous.channel === v.channel;
  const recipe_version = preserve ? previous.recipe_version : menu.recipe_version;
  const cost = preserve ? { food: previous.unit_food_cost_snapshot, pack: previous.unit_packaging_cost_snapshot } : deriveCost(seed, v.date, v.menu_id, v.channel, recipe_version);
  if (cost.food === null || cost.pack === null) throw new Error('기존 판매의 원가가 누락되었습니다. 원가 기준을 확인해야 합니다.');
  usage(seed, { menu_id: v.menu_id, recipe_version, channel: v.channel, quantity: Number(v.quantity) });
  return { sale_id: id, date: v.date, menu_id: v.menu_id, channel: v.channel, quantity: Number(v.quantity), unit_price: new Decimal(v.unit_price).toString(), discount_amount: new Decimal(v.discount_amount).toString(), net_sales: new Decimal(v.quantity).mul(v.unit_price).sub(v.discount_amount).toString(), payment_fee: new Decimal(v.payment_fee).toString(), recipe_version, unit_food_cost_snapshot: cost.food, unit_packaging_cost_snapshot: cost.pack };
}
export function metrics(s: Sale) {
  if (s.unit_food_cost_snapshot === null || s.unit_packaging_cost_snapshot === null || s.payment_fee === null) return { cost: null, contribution: null, ratio: null, reason: '원가 또는 결제수수료 누락' };
  const cost = new Decimal(s.unit_food_cost_snapshot).add(s.unit_packaging_cost_snapshot).mul(s.quantity);
  const contribution = new Decimal(s.net_sales).sub(cost).sub(s.payment_fee);
  return { cost: cost.toString(), contribution: contribution.toString(), ratio: new Decimal(s.net_sales).isZero() ? null : contribution.div(s.net_sales).mul(100).toString(), reason: '' };
}
export function aggregate(sales: Sale[]) {
  let net = new Decimal(0), cost = new Decimal(0), fee = new Decimal(0), contribution = new Decimal(0), quantity = 0, missing = 0;
  for (const s of sales) {
    const m = metrics(s); net = net.add(s.net_sales); quantity += s.quantity;
    if (m.cost === null || m.contribution === null || s.payment_fee === null) missing++; else { cost = cost.add(m.cost); fee = fee.add(s.payment_fee); contribution = contribution.add(m.contribution); }
  }
  return { quantity, net: net.toString(), cost: missing ? null : cost.toString(), fee: missing ? null : fee.toString(), contribution: missing ? null : contribution.toString(), ratio: missing || net.isZero() ? null : contribution.div(net).mul(100).toString(), missing, count: sales.length };
}
export function inPeriod(s: Sale, mode: 'day' | 'month', date: string): boolean { return mode === 'day' ? s.date === date : s.date.slice(0, 7) === date.slice(0, 7); }
export function formatMoney(value: string | null): string {
  if (value === null) return '계산 불가';
  const [whole, fraction] = new Decimal(value).toFixed(2).split('.');
  const grouped = new Intl.NumberFormat('ko-KR').format(BigInt(whole));
  const trimmed = fraction.replace(/0+$/, '');
  const sign = whole === '-0' ? '-' : '';
  return `${sign}${grouped}${trimmed ? `.${trimmed}` : ''}`;
}
export function formatRatio(value: string | null): string { return value === null ? '—' : `${new Decimal(value).toFixed(1)}%`; }
