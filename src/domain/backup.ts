import { z } from 'zod';
import { type Seed, POLICIES, OPERATING_POLICIES, validateSeed } from './model';
import type { IDBPDatabase } from 'idb';
import { STORES, type Meta } from '../storage/repository';
const keys = ['suppliers', 'materials', 'menus', 'recipes', 'priceHistory', 'calendar', 'openingInventory', 'sales', 'inventoryEvents', 'expenses', 'monthlyExpensePlan'] as const;
export interface Backup { format: 'prep-cafe-backup'; backupVersion: 1; exportedAt: string; appVersion: string; sourceMeta: Seed['meta']; policyVersion: string; policies: { sales: typeof POLICIES; operations: typeof OPERATING_POLICIES }; data: Record<typeof keys[number], unknown[]>; counts: Record<typeof keys[number], number> }
export async function createBackup(db: IDBPDatabase): Promise<Backup> {
  const started = performance.now();
  const tx = db.transaction(STORES, 'readonly');
  const meta = await tx.objectStore('appMeta').get('state') as Meta;
  if (meta.policyVersion !== POLICIES.version) throw new Error('지원하지 않는 저장 자료입니다.');
  const data = {} as Backup['data'], counts = {} as Backup['counts'];
  for (const key of keys) { data[key] = await tx.objectStore(key).getAll(); counts[key] = data[key].length; }
  const salesPolicy = await tx.objectStore('policies').get('epic1'); const operationsPolicy = await tx.objectStore('policies').get('operations') ?? OPERATING_POLICIES;
  await tx.done;
  console.info(`[perf] backup-read ${Math.round(performance.now() - started)}ms`);
  return { format: 'prep-cafe-backup', backupVersion: 1, exportedAt: new Date().toISOString(), appVersion: '0.1.0', sourceMeta: meta.seed.meta, policyVersion: `${POLICIES.version}/${OPERATING_POLICIES.version}`, policies: { sales: salesPolicy, operations: operationsPolicy }, data, counts };
}
const schema = z.object({ format: z.literal('prep-cafe-backup'), backupVersion: z.literal(1), exportedAt: z.string().datetime(), appVersion: z.string(), sourceMeta: z.record(z.string(), z.unknown()), policyVersion: z.string(), policies: z.object({ sales: z.record(z.string(), z.unknown()), operations: z.record(z.string(), z.unknown()) }).strict(), data: z.record(z.string(), z.array(z.unknown())), counts: z.record(z.string(), z.number().int().nonnegative()) }).strict();
function samePolicy(value: Record<string, unknown>, reference: Record<string, unknown>) { return Object.keys(value).length === Object.keys(reference).length && Object.entries(reference).every(([key, expected]) => value[key] === expected); }
export function validateBackup(raw: unknown): { backup: Backup; seed: Seed } {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error('프로그램의 전체 백업 형식이 아닙니다. 원본 자료·요약 파일 또는 잘못된 파일은 복원할 수 없습니다.');
  const b = parsed.data;
  if (b.sourceMeta.dataset_id !== 'prep-cafe-operations') throw new Error('다른 매장의 백업입니다. 현재 기록을 변경하지 않았습니다.');
  if (b.policyVersion !== `${POLICIES.version}/${OPERATING_POLICIES.version}` || !samePolicy(b.policies.sales, POLICIES) || !samePolicy(b.policies.operations, OPERATING_POLICIES)) throw new Error('지원하지 않는 계산·운영 정책입니다. 현재 기록을 변경하지 않았습니다.');
  if (Object.keys(b.data).length !== keys.length || Object.keys(b.counts).length !== keys.length) throw new Error('백업의 기록 구역이 누락되거나 지원하지 않는 구역이 있습니다.');
  for (const key of keys) if (!b.data[key] || b.counts[key] !== b.data[key].length) throw new Error(`${key}의 내용과 기록 수가 일치하지 않습니다.`);
  const seed = validateSeed({ meta: b.sourceMeta, settings: {}, suppliers: b.data.suppliers, materials: b.data.materials, menus: b.data.menus, recipes: b.data.recipes, price_history: b.data.priceHistory, calendar: b.data.calendar, opening_inventory: b.data.openingInventory, sales: b.data.sales, inventory_events: b.data.inventoryEvents, expenses: b.data.expenses, monthly_expense_plan: b.data.monthlyExpensePlan });
  if (seed.meta.start_date > seed.meta.as_of) throw new Error('백업 자료의 시작일과 마감일이 올바르지 않습니다.');
  return { backup: b as unknown as Backup, seed };
}
export function parseBackup(text: string) { let raw: unknown; try { raw = JSON.parse(text); } catch { throw new Error('JSON 내용을 읽지 못했습니다. 파일이 비었거나 손상되었습니다.'); } return validateBackup(raw); }
