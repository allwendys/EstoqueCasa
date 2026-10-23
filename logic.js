// Regras de negócio puras (sem DOM/Supabase) — testadas em logic.test.js

export const iso = d =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const today = () => iso(new Date());

const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

export const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };

// Períodos de calendário: semana começa na segunda.
export function periodStart(period, ref = today()) {
  if (period === 'day') return ref;
  if (period === 'week') return addDays(ref, -((parse(ref).getDay() + 6) % 7));
  if (period === 'month') return ref.slice(0, 8) + '01';
  return ref.slice(0, 5) + '01-01';
}

export function totals(txs) {
  const t = { purchase: 0, consumption: 0 };
  for (const x of txs) t[x.type === 'PURCHASE' ? 'purchase' : 'consumption'] += Number(x.total_price);
  return t;
}

// Barras: por dia (dia/semana/mês) ou por mês (ano).
export function series(txs, period) {
  const map = new Map();
  for (const x of txs) {
    const k = period === 'year' ? x.transaction_date.slice(0, 7) : x.transaction_date;
    const v = map.get(k) ?? { purchase: 0, consumption: 0 };
    v[x.type === 'PURCHASE' ? 'purchase' : 'consumption'] += Number(x.total_price);
    map.set(k, v);
  }
  const labels = [...map.keys()].sort();
  return { labels, purchase: labels.map(k => map.get(k).purchase), consumption: labels.map(k => map.get(k).consumption) };
}

export function purchasesByCategory(txs) {
  const map = {};
  for (const x of txs) if (x.type === 'PURCHASE') {
    const c = x.products?.categories?.name ?? 'Sem categoria';
    map[c] = (map[c] ?? 0) + Number(x.total_price);
  }
  return map;
}

export const level = p =>
  Number(p.current_stock) <= 0 ? 'out' : Number(p.current_stock) <= Number(p.min_stock) ? 'low' : 'ok';

export const restockList = products =>
  products.filter(p => level(p) !== 'ok')
    .map(p => ({ ...p, buy: Math.max(Number(p.target_stock) - Number(p.current_stock), 1) }));

// Sobra = acima do alvo, ou comprou e consumiu menos da metade na janela analisada.
export function findExcess(products, txs) {
  const moved = {};
  for (const x of txs) {
    const m = (moved[x.product_id] ??= { in: 0, out: 0 });
    m[x.type === 'PURCHASE' ? 'in' : 'out'] += Number(x.quantity);
  }
  const out = [];
  for (const p of products) {
    const overTarget = Number(p.current_stock) - Number(p.target_stock);
    const m = moved[p.id];
    const idle = m && m.in > 0 && m.out < m.in * 0.5 ? Math.min(m.in - m.out, Number(p.current_stock)) : 0;
    const units = Math.max(overTarget, idle);
    if (units > 0) out.push({ product: p, units, reason: overTarget >= idle ? 'acima do estoque alvo' : 'baixo giro' });
  }
  return out.sort((a, b) => b.units - a.units);
}

export const brl = n => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Liquidação mínima: o maior devedor paga o maior credor até zerar (n-1 transferências no máximo).
export function settle(rows) {
  const side = sign => rows.filter(r => sign * Number(r.balance) > 0.005)
    .map(r => ({ mate: r, left: Math.abs(Number(r.balance)) })).sort((a, b) => b.left - a.left);
  const debtors = side(-1), creditors = side(1), out = [];
  for (let i = 0, j = 0; i < debtors.length && j < creditors.length;) {
    const v = Math.min(debtors[i].left, creditors[j].left);
    out.push({ from: debtors[i].mate, to: creditors[j].mate, value: Math.round(v * 100) / 100 });
    if ((debtors[i].left -= v) < 0.005) i++;
    if ((creditors[j].left -= v) < 0.005) j++;
  }
  return out;
}

export const settlementText = (month, rows, transfers) =>
  `💰 *Acerto de contas ${month.split('-').reverse().join('/')}*\n\n` +
  rows.map(r => `${r.avatar_icon} ${r.mate_name}: gastou ${brl(r.paid)}, consumiu ${brl(Number(r.direct_cost) + Number(r.collective_share))} → ` +
    (Number(r.balance) > 0 ? `recebe ${brl(r.balance)}` : Number(r.balance) < 0 ? `paga ${brl(-r.balance)}` : 'quite')).join('\n') +
  (transfers.length ? '\n\n*Transferências:*\n' + transfers.map(t =>
    `• ${t.from.mate_name} → ${t.to.mate_name}: ${brl(t.value)}${t.to.pix_key ? ` (Pix: ${t.to.pix_key})` : ''}`).join('\n') : '\n\nNinguém deve nada 🎉');

export const whatsappText = list =>
  '🛒 *Lista de reposição*\n\n' + list.map(p => `• ${p.name}: ${p.buy} ${p.unit} (tem ${Number(p.current_stock)})`).join('\n');
