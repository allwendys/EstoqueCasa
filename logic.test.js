// Rodar: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { periodStart, addDays, totals, series, purchasesByCategory, level, restockList, findExcess, settle, settlementText } from './logic.js';

test('settle: mesmo cenário validado no SQL (A +70, B -20, C -50)', () => {
  const rows = [
    { mate_name: 'A', avatar_icon: '🅰️', balance: '70.00', paid: 90, direct_cost: 0, collective_share: 20, pix_key: 'a@pix' },
    { mate_name: 'B', avatar_icon: '🅱️', balance: '-20.00', paid: 20, direct_cost: 20, collective_share: 20 },
    { mate_name: 'C', avatar_icon: '©️', balance: '-50.00', paid: 0, direct_cost: 30, collective_share: 20 },
  ];
  const t = settle(rows);
  assert.deepEqual(t.map(x => [x.from.mate_name, x.to.mate_name, x.value]), [['C', 'A', 50], ['B', 'A', 20]]);
  assert.match(settlementText('2026-10', rows, t), /C → A: R\$\s50,00 \(Pix: a@pix\)/);
  // dois credores, um devedor; arredondamento de centavos não gera transferência fantasma
  assert.deepEqual(settle([{ mate_name: 'X', balance: -10 }, { mate_name: 'Y', balance: 6.67 }, { mate_name: 'Z', balance: 3.33 }])
    .map(x => [x.to.mate_name, x.value]), [['Y', 6.67], ['Z', 3.33]]);
  assert.deepEqual(settle([{ balance: 0 }, { balance: 0.001 }]), []);
});

test('periodStart', () => {
  assert.equal(periodStart('day', '2026-10-22'), '2026-10-22');
  assert.equal(periodStart('week', '2026-10-22'), '2026-10-19'); // quinta -> segunda
  assert.equal(periodStart('week', '2026-10-25'), '2026-10-19'); // domingo -> segunda anterior
  assert.equal(periodStart('month', '2026-10-22'), '2026-10-01');
  assert.equal(periodStart('year', '2026-10-22'), '2026-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

const txs = [
  { product_id: 'a', type: 'PURCHASE', quantity: 10, total_price: 50, transaction_date: '2026-10-01', products: { categories: { name: 'Grãos' } } },
  { product_id: 'a', type: 'CONSUMPTION', quantity: 2, total_price: 10, transaction_date: '2026-10-02' },
  { product_id: 'b', type: 'PURCHASE', quantity: 4, total_price: 20, transaction_date: '2026-11-01', products: { categories: { name: 'Limpeza' } } },
  { product_id: 'b', type: 'CONSUMPTION', quantity: 3, total_price: 15, transaction_date: '2026-11-03' },
];

test('totals, series, categorias', () => {
  assert.deepEqual(totals(txs), { purchase: 70, consumption: 25 });
  assert.deepEqual(series(txs, 'year'), { labels: ['2026-10', '2026-11'], purchase: [50, 20], consumption: [10, 15] });
  assert.equal(series(txs, 'month').labels.length, 4);
  assert.deepEqual(purchasesByCategory(txs), { 'Grãos': 50, 'Limpeza': 20 });
});

test('níveis e reposição', () => {
  assert.equal(level({ current_stock: 0, min_stock: 1 }), 'out');
  assert.equal(level({ current_stock: 1, min_stock: 1 }), 'low');
  assert.equal(level({ current_stock: 2, min_stock: 1 }), 'ok');
  const r = restockList([{ current_stock: 1, min_stock: 2, target_stock: 5 }, { current_stock: 9, min_stock: 2, target_stock: 5 }]);
  assert.equal(r.length, 1);
  assert.equal(r[0].buy, 4);
});

test('findExcess', () => {
  const products = [
    { id: 'a', name: 'Arroz', current_stock: 8, target_stock: 10 }, // comprou 10, usou 2: baixo giro
    { id: 'b', name: 'Sabão', current_stock: 1, target_stock: 5 },  // girou bem
    { id: 'c', name: 'Óleo', current_stock: 9, target_stock: 4 },   // acima do alvo, sem movimento
  ];
  const ex = findExcess(products, txs);
  assert.deepEqual(ex.map(x => [x.product.id, x.units, x.reason]), [
    ['a', 8, 'baixo giro'],
    ['c', 5, 'acima do estoque alvo'],
  ]);
});
