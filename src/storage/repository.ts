import { openDB, type IDBPDatabase } from 'idb';
import { POLICIES, OPERATING_POLICIES, inventorySchema, expenseSchema, validateSeed, type InventoryEvent, type Expense, type Seed, type Sale, type Snapshot } from '../domain/model';
import { buildSale, type todayKorea } from '../domain/sales';
import type { SaleForm } from '../domain/model';

export const STORES = ['appMeta', 'suppliers', 'materials', 'menus', 'recipes', 'priceHistory', 'calendar', 'openingInventory', 'sales', 'inventoryEvents', 'expenses', 'monthlyExpensePlan', 'policies'];
export interface Meta { revision: number; initialized: boolean; seed: Seed; policyVersion: string }
export async function connect(name = 'prep-cafe-operations'): Promise<IDBPDatabase> {
  return openDB(name, 1, {
    upgrade(db) {
      for (const store of STORES) {
        const os = db.createObjectStore(store);
        if (store === 'sales') { os.createIndex('date', 'date'); os.createIndex('menu', 'menu_id'); os.createIndex('combination', ['date', 'menu_id', 'channel'], { unique: true }); }
      }
    },
    blocking(_a, _b, event) { (event.target as IDBDatabase).close(); },
    blocked() { window.dispatchEvent(new CustomEvent('storage-error', { detail: '다른 탭을 닫고 다시 열어 주세요. 저장소 업데이트가 대기 중입니다.' })); },
    terminated() { window.dispatchEvent(new CustomEvent('storage-error', { detail: '저장소 연결이 끊겼습니다. 새로고침해 주세요.' })); },
  });
}
export async function readSnapshot(db: IDBPDatabase): Promise<Snapshot> {
  const tx = db.transaction(['appMeta', 'sales', 'inventoryEvents', 'expenses', 'policies'], 'readonly');
  const meta = await tx.objectStore('appMeta').get('state') as Meta | undefined;
  if (!meta?.initialized || meta.policyVersion !== POLICIES.version) throw new Error('지원되는 저장 자료가 아닙니다. 기존 기록을 변경하지 않았습니다.');
  const operationsPolicy = await tx.objectStore('policies').get('operations');
  if (operationsPolicy && operationsPolicy.version !== OPERATING_POLICIES.version) throw new Error('지원하지 않는 재고·비용 정책 버전입니다. 기존 자료를 변경하지 않았습니다.');
  const sales = await tx.objectStore('sales').getAll() as Sale[];
  const inventoryEvents = (await tx.objectStore('inventoryEvents').getAll()).map(x => inventorySchema.parse(x));
  const expenses = (await tx.objectStore('expenses').getAll()).map(x => expenseSchema.parse(x));
  const seed = validateSeed({ ...meta.seed, sales, inventory_events: inventoryEvents, expenses });
  await tx.done; return { seed, sales, inventoryEvents, expenses, revision: meta.revision };
}
export async function initialize(db: IDBPDatabase, loader: () => Promise<unknown>): Promise<Snapshot> {
  if ((await db.get('appMeta', 'state'))?.initialized) return readSnapshot(db);
  const seed = validateSeed(await loader());
  const tx = db.transaction(STORES, 'readwrite');
  if (!(await tx.objectStore('appMeta').get('state'))?.initialized) {
    const groups: [string, unknown[], (x: any, i: number) => IDBValidKey][] = [
      ['suppliers', seed.suppliers, x => x.supplier_id], ['materials', seed.materials, x => x.material_id], ['menus', seed.menus, x => x.menu_id],
      ['recipes', seed.recipes, x => [x.recipe_version, x.menu_id, x.material_id, x.channel_only ?? '*']], ['priceHistory', seed.price_history, x => [x.material_id, x.effective_date]],
      ['calendar', seed.calendar, x => x.date], ['openingInventory', seed.opening_inventory, x => [x.material_id, x.date]], ['sales', seed.sales, x => x.sale_id],
      ['inventoryEvents', seed.inventory_events, x => String(x.event_id)], ['expenses', seed.expenses, x => String(x.expense_id)], ['monthlyExpensePlan', seed.monthly_expense_plan, x => [String(x.month), String(x.category)]],
    ];
    for (const [store, rows, key] of groups) for (let i = 0; i < rows.length; i++) tx.objectStore(store).put(rows[i], key(rows[i], i));
    tx.objectStore('policies').put(POLICIES, 'epic1');
    tx.objectStore('policies').put(OPERATING_POLICIES, 'operations');
    // Seed keeps immutable source context; operational sales are always read from their store.
    tx.objectStore('appMeta').put({ initialized: true, revision: 0, seed, policyVersion: POLICIES.version } satisfies Meta, 'state');
  }
  await tx.done; return readSnapshot(db);
}
export interface Mutation { revision: number; form?: SaleForm; id: string; kind: 'add' | 'edit' | 'delete'; today?: ReturnType<typeof todayKorea> }
export async function mutate(db: IDBPDatabase, req: Mutation): Promise<Sale | null> {
  const tx = db.transaction(['appMeta', 'sales'], 'readwrite');
  // Observe rejections even when aborting on a domain validation error.
  const done = tx.done; done.catch(() => undefined);
  try {
    const meta = await tx.objectStore('appMeta').get('state') as Meta;
    if (!meta || meta.policyVersion !== POLICIES.version) throw new Error('저장 자료 버전을 확인하세요. 기록을 변경하지 않았습니다.');
    if (meta.revision !== req.revision) throw new Error('다른 탭에서 기록이 바뀌었습니다. 취소 후 새로고침하여 최신 기록을 확인하세요.');
    const os = tx.objectStore('sales');
    const previous = await os.get(req.id) as Sale | undefined;
    if (req.kind === 'add' && previous) throw new Error('이미 저장된 요청입니다. 새로고침해 확인하세요.');
    if (req.kind !== 'add' && !previous) throw new Error('대상 판매가 없습니다. 기록을 다시 확인하세요.');
    let sale: Sale | null = null;
    if (req.kind === 'delete') await os.delete(req.id);
    else {
      if (!req.form) throw new Error('판매 입력이 없습니다.');
      sale = buildSale(meta.seed, req.form, req.id, previous, req.today);
      const duplicate = await os.index('combination').get([sale.date, sale.menu_id, sale.channel]) as Sale | undefined;
      if (duplicate && duplicate.sale_id !== sale.sale_id) throw new Error('같은 날짜·메뉴·채널의 기록이 있습니다. 기존 판매를 수정하세요.');
      await os.put(sale, sale.sale_id);
    }
    await tx.objectStore('appMeta').put({ ...meta, revision: meta.revision + 1 }, 'state');
    await done; return sale;
  } catch (err) { try { tx.abort(); } catch { /* transaction already ended */ } await done.catch(() => undefined); throw err; }
}
