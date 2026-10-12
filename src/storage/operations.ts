import type { IDBPDatabase } from 'idb';
import { type Meta, STORES, readSnapshot } from './repository';
import { POLICIES, OPERATING_POLICIES, validateSeed, type Expense, type InventoryEvent } from '../domain/model';
import { buildExpense, buildInventory, type ExpenseForm, type InventoryForm } from '../domain/operations';

export async function addInventory(db: IDBPDatabase, form: InventoryForm, id: string, revision: number, today?: string) {
  const snapshot = await readSnapshot(db);
  if (snapshot.revision !== revision) throw new Error('기록이 다른 탭에서 바뀌었습니다. 새로고침해 확인하세요.');
  const row = buildInventory(snapshot, form, id, today);
  await writeRecord(db, 'inventoryEvents', row, id, revision, 'add'); return row;
}
export async function saveExpense(db: IDBPDatabase, form: ExpenseForm | undefined, id: string, revision: number, kind: 'add' | 'edit' | 'delete', today?: string) {
  const snapshot = await readSnapshot(db);
  if (snapshot.revision !== revision) throw new Error('다른 탭에서 기록이 바뀌었습니다. 새로고침해 확인하세요.');
  const previous = snapshot.expenses.find(x => x.expense_id === id);
  if (kind !== 'add' && !previous) throw new Error('수정·삭제할 비용이 없습니다.');
  const row = kind === 'delete' ? null : buildExpense(snapshot.seed, form!, id, previous, today);
  await writeRecord(db, 'expenses', row, id, revision, kind); return row;
}
async function writeRecord(db: IDBPDatabase, store: 'inventoryEvents' | 'expenses', row: InventoryEvent | Expense | null, id: string, revision: number, kind: 'add' | 'edit' | 'delete') {
  const tx = db.transaction(['appMeta', store, 'policies'], 'readwrite'); const done = tx.done; done.catch(() => undefined);
  try {
    const meta = await tx.objectStore('appMeta').get('state') as Meta;
    if (!meta || meta.policyVersion !== POLICIES.version || meta.revision !== revision) throw new Error('다른 탭에서 기록이 바뀌었거나 지원하지 않는 자료입니다. 새로고침해 확인하세요.');
    const os = tx.objectStore(store); const old = await os.get(id);
    if ((kind === 'add' && old) || (kind !== 'add' && !old)) throw new Error('이미 처리된 요청이거나 대상 기록이 없습니다.');
    if (kind === 'delete') await os.delete(id); else await os.put(row, id);
    await tx.objectStore('policies').put(OPERATING_POLICIES, 'operations');
    await tx.objectStore('appMeta').put({ ...meta, revision: meta.revision + 1 }, 'state'); await done;
  } catch (e) { try { tx.abort(); } catch { /* ended */ } await done.catch(() => undefined); throw e; }
}

export async function replaceDataset(db: IDBPDatabase, seed: Meta['seed'], revision: number) {
  const started = performance.now();
  seed = validateSeed(seed);
  const tx = db.transaction(STORES, 'readwrite'); const done = tx.done; done.catch(() => undefined);
  try {
    const old = await tx.objectStore('appMeta').get('state') as Meta;
    if (!old || old.revision !== revision || old.policyVersion !== POLICIES.version) throw new Error('파일을 확인하는 동안 기록이 변경되었습니다. 다시 파일을 확인하세요.');
    const groups: [string, unknown[], (x: any) => IDBValidKey][] = [
      ['suppliers', seed.suppliers, x => x.supplier_id], ['materials', seed.materials, x => x.material_id], ['menus', seed.menus, x => x.menu_id], ['recipes', seed.recipes, x => [x.recipe_version, x.menu_id, x.material_id, x.channel_only ?? '*']], ['priceHistory', seed.price_history, x => [x.material_id, x.effective_date]], ['calendar', seed.calendar, x => x.date], ['openingInventory', seed.opening_inventory, x => [x.material_id, x.date]], ['sales', seed.sales, x => x.sale_id], ['inventoryEvents', seed.inventory_events, x => x.event_id], ['expenses', seed.expenses, x => x.expense_id], ['monthlyExpensePlan', seed.monthly_expense_plan, x => [x.month, x.category]],
    ];
    for (const [store, rows, key] of groups) { await tx.objectStore(store).clear(); for (const row of rows) tx.objectStore(store).put(row, key(row)); }
    await tx.objectStore('policies').clear(); await tx.objectStore('policies').put(POLICIES, 'epic1'); await tx.objectStore('policies').put(OPERATING_POLICIES, 'operations');
    await tx.objectStore('appMeta').put({ ...old, seed, revision: old.revision + 1 }, 'state'); await done;
    console.info(`[perf] restore-write ${Math.round(performance.now() - started)}ms`);
  } catch (e) { try { tx.abort(); } catch { /* ended */ } await done.catch(() => undefined); throw e; }
}
