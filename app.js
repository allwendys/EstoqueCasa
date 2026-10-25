import { iso, today, addDays, periodStart, totals, series, purchasesByCategory, level, restockList, findExcess, whatsappText, brl, settle, settlementText } from './logic.js';

// Chave publishable é pública por design; a proteção real é login + RLS com lista de e-mails (ver schema.sql).
const db = supabase.createClient('https://ezeypnhjhfafabfismlz.supabase.co', 'sb_publishable_VyEstiPInyzfRecRxnbjXA_v2PRqTu6');

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const LABEL = { out: 'Esgotado', low: 'Repor' };

// Lembra quem usa este aparelho; sem storage (aba anônima) só começa sem ninguém marcado.
const saved = k => { try { return localStorage.getItem(k); } catch { return null; } };
const save = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* ignora */ } };

const state = { categories: [], products: [], mates: [], editMate: null, editProduct: null, person: saved('person'), type: 'PURCHASE', cat: null, productId: null, period: 'month' };
let barChart, pieChart;

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.className = ''), 2500);
}

async function loadBase() {
  const [c, p, m] = await Promise.all([
    db.from('categories').select('*').order('name'),
    db.from('products').select('*').order('name'),
    db.from('housemates').select('*').order('name'),
  ]);
  if (c.error || p.error || m.error) return toast('Erro ao carregar: ' + (c.error ?? p.error ?? m.error).message, true);
  state.categories = c.data;
  state.products = p.data;
  state.mates = m.data;
  if (!state.mates.some(x => x.id === state.person && x.is_active)) state.person = null;
  renderPills(); renderPicker(); renderStock(); renderMates();
}

/* ---------- Moradores ---------- */

function renderMates() {
  const purchase = state.type === 'PURCHASE';
  const chips = state.mates.filter(m => m.is_active).map(m => ({ id: m.id, label: `${m.avatar_icon} ${m.name}` }));
  if (!purchase) chips.push({ id: null, label: '🏠 Consumo geral da casa' });
  $('#matePills').innerHTML = chips.map(c =>
    `<button type="button" data-mate="${c.id ?? ''}" class="${c.id === state.person ? 'active' : ''}">${esc(c.label)}</button>`
  ).join('') || '<span class="muted">Cadastre os moradores na aba Estoque.</span>';
  $('#whoLabel').textContent = purchase ? 'Quem pagou' : 'Quem consumiu';
  $('#collectiveRow').hidden = !purchase;

  $('#mateList').innerHTML = state.mates.map(m =>
    `<li class="${m.is_active ? '' : 'muted'}">
      <span class="actions-inline">
        <button type="button" class="link" data-edit="${m.id}">Editar</button>
        <button type="button" class="link" data-toggle="${m.id}">${m.is_active ? 'Desativar' : 'Reativar'}</button>
      </span>
      ${esc(m.avatar_icon)} <b>${esc(m.name)}</b> · ${Number(m.share_pct)}%${m.pix_key ? `<br><small class="muted">Pix: ${esc(m.pix_key)}</small>` : ''}</li>`
  ).join('') || '<li class="muted">Nenhum morador ainda.</li>';

  const active = state.mates.filter(m => m.is_active);
  const sum = active.reduce((s, m) => s + Number(m.share_pct), 0);
  const zero = active.filter(m => Number(m.share_pct) === 0).map(m => m.name);
  $('#mateSum').textContent = sum === 0 ? 'Nenhuma % definida: as despesas da casa são divididas igualmente.'
    : (Math.abs(sum - 100) < 0.01 ? '✓ As % dos moradores ativos somam 100%.'
      : `⚠️ As % somam ${+sum.toFixed(2)}%. O fechamento ajusta proporcionalmente para 100%.`)
      + (zero.length ? ` ${zero.join(', ')} com 0% não paga(m) nada das despesas da casa.` : '');
  if (!state.editMate) $('#mateForm').elements.share_pct.placeholder = `% (sobram ${+Math.max(0, 100 - sum).toFixed(2)}%)`;
}

function editMate(id) {
  const m = state.mates.find(x => x.id === id), f = $('#mateForm').elements;
  state.editMate = id;
  f.avatar_icon.value = m.avatar_icon; f.name.value = m.name; f.pix_key.value = m.pix_key ?? ''; f.share_pct.value = Number(m.share_pct);
  $('#mateSubmit').textContent = 'Salvar alterações';
  $('#mateCancel').hidden = false;
  $('#mateForm').closest('details').open = true;
  f.share_pct.focus();
}

function resetMateForm() {
  state.editMate = null;
  $('#mateForm').reset();
  $('#mateSubmit').textContent = 'Adicionar morador';
  $('#mateCancel').hidden = true;
  renderMates();
}

async function submitMate(e) {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const row = { name: f.name.trim(), avatar_icon: f.avatar_icon || '🙂', pix_key: f.pix_key.trim() || null, share_pct: +f.share_pct || 0 };
  const { error } = state.editMate
    ? await db.from('housemates').update(row).eq('id', state.editMate)
    : await db.from('housemates').insert(row);
  if (error) return toast('Erro: ' + error.message, true);
  toast(state.editMate ? 'Morador atualizado ✓' : 'Morador adicionado ✓');
  resetMateForm();
  await loadBase();
}

async function toggleMate(id) {
  const m = state.mates.find(x => x.id === id);
  const { error } = await db.from('housemates').update({ is_active: !m.is_active }).eq('id', id);
  if (error) return toast('Erro: ' + error.message, true);
  await loadBase();
}

/* ---------- Lançar ---------- */

function renderPills() {
  $('#catPills').innerHTML = [{ id: null, name: 'Todos', icon: '✨' }, ...state.categories]
    .map(c => `<button data-cat="${c.id ?? ''}" class="${c.id === state.cat ? 'active' : ''}">${esc(c.icon)} ${esc(c.name)}</button>`).join('');
  $('#productForm [name=category_id]').innerHTML = state.categories.map(c => `<option value="${c.id}">${esc(c.icon)} ${esc(c.name)}</option>`).join('');
}

function renderPicker() {
  const q = $('#search').value.trim().toLowerCase();
  const list = state.products.filter(p => (!state.cat || p.category_id === state.cat) && p.name.toLowerCase().includes(q));
  $('#picker').innerHTML = list.map(p =>
    `<button type="button" data-id="${p.id}" class="${level(p)} ${p.id === state.productId ? 'active' : ''}">${esc(p.name)}<small>${Number(p.current_stock)} ${esc(p.unit)}</small></button>`
  ).join('') || '<p class="muted">Nenhum produto. Cadastre na aba Estoque.</p>';
}

function selectProduct(id) {
  state.productId = id;
  const p = state.products.find(x => x.id === id);
  $('#selected').textContent = p ? `${p.name} — estoque: ${Number(p.current_stock)} ${p.unit}` : 'Selecione um produto acima';
  $('#selected').classList.toggle('muted', !p);
  if (p) $('#price').value = Number(p.default_price);
  $('#submitBtn').disabled = !p;
  renderPicker(); updateTotal();
}

const updateTotal = () => ($('#total').textContent = 'Total: ' + brl((+$('#qty').value || 0) * (+$('#price').value || 0)));

async function submitEntry(e) {
  e.preventDefault();
  const before = state.products.find(p => p.id === state.productId);
  const quantity = +$('#qty').value;
  if (!before || !(quantity > 0)) return toast('Informe produto e quantidade', true);

  const btn = $('#submitBtn');
  btn.disabled = true;
  const purchase = state.type === 'PURCHASE';
  const { error } = await db.from('stock_transactions').insert({
    product_id: before.id, type: state.type, quantity,
    unit_price: +$('#price').value || 0, transaction_date: $('#date').value, notes: $('#notes').value || null,
    buyer_id: purchase ? state.person : null,
    consumer_id: purchase ? null : state.person,
    // consumo sem pessoa = consumo geral da casa
    is_collective: purchase ? $('#collective').checked : !state.person,
  });
  btn.disabled = false;
  if (error) return toast(error.message.includes('current_stock') ? 'Estoque insuficiente para essa baixa' : 'Erro: ' + error.message, true);

  navigator.vibrate?.(60);
  btn.classList.add('ok'); btn.textContent = '✓ Lançado!';
  setTimeout(() => { btn.classList.remove('ok'); btn.textContent = 'Lançar'; }, 1200);
  toast(`${state.type === 'PURCHASE' ? '🛒' : '🍽️'} ${before.name}: ${state.type === 'PURCHASE' ? '+' : '−'}${quantity} ${before.unit}`);

  await loadBase();
  const after = state.products.find(p => p.id === before.id);
  if (after && level(before) === 'ok' && level(after) !== 'ok') alertLow(after);
  // Mantém tipo e categoria para lançar o próximo item em sequência.
  $('#qty').value = 1; $('#notes').value = '';
  selectProduct(null);
}

/* ---------- Estoque ---------- */

function renderStock() {
  const urgent = restockList(state.products);
  $('#urgentList').innerHTML = urgent.map(p =>
    `<li><b>${esc(p.name)}</b> — tem ${Number(p.current_stock)} ${esc(p.unit)}, comprar ${p.buy}</li>`
  ).join('') || '<li class="muted">Tudo em dia 🎉</li>';
  $('#waBtn').href = urgent.length ? 'https://wa.me/?text=' + encodeURIComponent(whatsappText(urgent)) : '#';
  $('#waBtn').setAttribute('aria-disabled', !urgent.length);
  $('#alertBadge').hidden = !urgent.length;
  $('#alertBadge').textContent = urgent.length;

  const cat = Object.fromEntries(state.categories.map(c => [c.id, c]));
  $('#productGrid').innerHTML = state.products.map(p => {
    const lv = level(p);
    const pct = Math.min(100, (Number(p.current_stock) / Math.max(Number(p.target_stock), 1)) * 100);
    return `<div class="prod ${lv}">
      <div class="prod-top"><b>${esc(cat[p.category_id]?.icon)} ${esc(p.name)}</b>${lv !== 'ok' ? `<span class="badge ${lv}">${LABEL[lv]}</span>` : ''}</div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <small class="muted">${Number(p.current_stock)} ${esc(p.unit)} · mín ${Number(p.min_stock)} · alvo ${Number(p.target_stock)} · ${brl(p.default_price)}</small>
      <button type="button" class="link" data-edit-product="${p.id}">Editar</button>
    </div>`;
  }).join('');
}

const PRODUCT_FIELDS = ['name', 'category_id', 'unit', 'current_stock', 'min_stock', 'target_stock', 'default_price'];

function editProduct(id) {
  const p = state.products.find(x => x.id === id), f = $('#productForm').elements;
  state.editProduct = id;
  for (const k of PRODUCT_FIELDS) f[k].value = p[k] ?? '';
  $('#productSummary').textContent = `✏️ Editando: ${p.name}`;
  $('#productSubmit').textContent = 'Salvar alterações';
  $('#productCancel').hidden = false;
  const details = $('#productForm').closest('details');
  details.open = true;
  details.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetProductForm() {
  state.editProduct = null;
  $('#productForm').reset();
  $('#productSummary').textContent = '➕ Novo produto';
  $('#productSubmit').textContent = 'Cadastrar';
  $('#productCancel').hidden = true;
}

async function submitProduct(e) {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  for (const k of ['current_stock', 'min_stock', 'target_stock', 'default_price']) f[k] = +f[k] || 0;
  const { error } = state.editProduct
    ? await db.from('products').update(f).eq('id', state.editProduct)
    : await db.from('products').insert(f);
  if (error) return toast('Erro: ' + error.message, true);
  toast(state.editProduct ? 'Produto atualizado ✓' : 'Produto cadastrado ✓');
  resetProductForm();
  await loadBase();
}

/* ---------- Alertas ---------- */

function beep() {
  try {
    const ctx = new AudioContext(), o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 880; g.gain.value = 0.15;
    o.connect(g).connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.25);
  } catch { /* sem áudio: segue só com o pop-up */ }
}

async function alertLow(p) {
  beep();
  toast(`⚠️ ${p.name} abaixo do mínimo!`, true);
  if (window.Notification?.permission !== 'granted') return;
  const title = `⚠️ ${p.name} acabando`;
  const opts = { body: `Restam ${Number(p.current_stock)} ${p.unit} (mínimo ${Number(p.min_stock)}). Adicione à lista de compras.`, tag: p.id };
  // Android Chrome não aceita new Notification() na página; precisa do service worker.
  const reg = await navigator.serviceWorker?.getRegistration();
  reg ? reg.showNotification(title, opts) : new Notification(title, opts);
}

async function enableNotifications() {
  if (!('Notification' in window)) return toast('Este navegador não suporta notificações', true);
  const perm = await Notification.requestPermission();
  $('#notifyBtn').classList.toggle('on', perm === 'granted');
  toast(perm === 'granted' ? 'Notificações ativadas 🔔' : 'Notificações bloqueadas', perm !== 'granted');
}

/* ---------- Painel ---------- */

async function loadDashboard() {
  const end = today(), start = periodStart(state.period, end), excessStart = addDays(end, -30);
  const { data, error } = await db.from('stock_transactions')
    .select('product_id, type, quantity, total_price, transaction_date, buyer_id, products(name, unit, categories(name))')
    .gte('transaction_date', start < excessStart ? start : excessStart).lte('transaction_date', end);
  if (error) return toast('Erro: ' + error.message, true);
  if (!barChart) initCharts(); // só depois da aba visível, senão o canvas nasce com altura 0

  const txs = data.filter(x => x.transaction_date >= start);
  const t = totals(txs);
  $('#kpiPurchase').textContent = brl(t.purchase);
  $('#kpiConsumption').textContent = brl(t.consumption);

  const s = series(txs, state.period);
  barChart.data.labels = s.labels.map(l => l.split('-').reverse().join('/'));
  barChart.data.datasets[0].data = s.purchase;
  barChart.data.datasets[1].data = s.consumption;
  barChart.update();

  const byCat = purchasesByCategory(txs);
  pieChart.data.labels = Object.keys(byCat);
  pieChart.data.datasets[0].data = Object.values(byCat);
  pieChart.update();

  const excess = findExcess(state.products, data.filter(x => x.transaction_date >= excessStart));
  $('#excessList').innerHTML = excess.map(x =>
    `<li><b>${esc(x.product.name)}</b> (${+x.units.toFixed(2)} ${esc(x.product.unit)} paradas, ${x.reason}) → Sugestão: reduzir compra no próximo ciclo</li>`
  ).join('') || '<li class="muted">Nenhuma sobra detectada 👌</li>';

  // shortcut: identifica a Minnie pelo nome da categoria; se renomear a categoria, ajuste aqui.
  const minnie = txs.filter(x => x.type === 'PURCHASE' && x.products?.categories?.name === 'Minnie')
    .sort((a, b) => b.transaction_date.localeCompare(a.transaction_date));
  const mateName = id => state.mates.find(m => m.id === id)?.name;
  $('#minnieTotal').textContent = brl(minnie.reduce((s, x) => s + Number(x.total_price), 0));
  $('#minnieList').innerHTML = minnie.map(x =>
    `<li>${shortDate(x.transaction_date)} · ${esc(x.products.name)} (${Number(x.quantity)} ${esc(x.products.unit)}) · <b>${brl(x.total_price)}</b>${x.buyer_id ? ` <small class="muted">· pago por ${esc(mateName(x.buyer_id))}</small>` : ''}</li>`
  ).join('') || '<li class="muted">Nenhuma compra para a Minnie no período. Lance na categoria 🐶 Minnie.</li>';

  loadSettlement();
}

const shortDate = d => d.slice(8, 10) + '/' + d.slice(5, 7);

async function loadSettlement() {
  const month = $('#settleMonth').value || today().slice(0, 7);
  const next = iso(new Date(+month.slice(0, 4), +month.slice(5, 7), 1)); // 1º dia do mês seguinte
  const [{ data, error }, lines] = await Promise.all([
    db.rpc('month_settlement', { p_month: month + '-01' }),
    db.from('stock_transactions')
      .select('transaction_date, type, quantity, total_price, is_collective, buyer_id, consumer_id, products(name, unit)')
      .gte('transaction_date', month + '-01').lt('transaction_date', next)
      .or('buyer_id.not.is.null,consumer_id.not.is.null')
      .order('transaction_date', { ascending: false }),
  ]);
  if (error || lines.error) return toast('Erro no fechamento: ' + (error ?? lines.error).message, true);

  $('#mateCards').innerHTML = data.map(r => {
    const b = Number(r.balance);
    const badge = b > 0 ? '<span class="badge pos">A receber</span>' : b < 0 ? '<span class="badge out">Deve pagar</span>' : '<span class="badge">Quite</span>';
    const items = lines.data.filter(x => x.buyer_id === r.housemate_id || x.consumer_id === r.housemate_id).map(x => {
      const what = `${shortDate(x.transaction_date)} · ${esc(x.products?.name)} (${Number(x.quantity)} ${esc(x.products?.unit)}) · <b>${brl(x.total_price)}</b>`;
      return x.type === 'PURCHASE'
        ? `<li>🛒 ${what} <small class="muted">· ${x.is_collective ? 'para a casa' : 'só para si'}</small></li>`
        : `<li>🍽️ ${what} <small class="muted">· consumo individual</small></li>`;
    }).join('') || '<li class="muted">Nenhuma compra ou consumo individual no mês.</li>';
    return `<details class="prod mate">
      <summary>
        <div class="prod-top"><b>${esc(r.avatar_icon)} ${esc(r.mate_name)} <small class="muted">· ${Number(r.share_pct)}%</small></b>${badge}</div>
        <small class="muted">Gastou ${brl(r.paid)} · Consumiu ${brl(Number(r.direct_cost) + Number(r.collective_share))}</small>
        <div class="saldo ${b > 0 ? 'pos' : b < 0 ? 'neg' : ''}">Saldo ${brl(b)}</div>
      </summary>
      <ul class="plain lines">
        ${items}
        <li class="muted">🏠 Parte dele(a) nas despesas da casa (${Number(r.share_pct)}%): <b>${brl(r.collective_share)}</b></li>
      </ul>
    </details>`;
  }).join('') || '<p class="muted">Cadastre os moradores na aba Estoque.</p>';

  const transfers = settle(data);
  $('#transferList').innerHTML = transfers.map(t =>
    `<li><b>${esc(t.from.mate_name)}</b> deve transferir <b>${brl(t.value)}</b> para <b>${esc(t.to.mate_name)}</b>
      ${t.to.pix_key ? `<button type="button" class="link" data-pix="${esc(t.to.pix_key)}">Copiar Pix</button>` : ''}</li>`
  ).join('') || '<li class="muted">Ninguém deve nada 🎉</li>';
  $('#settleWa').href = 'https://wa.me/?text=' + encodeURIComponent(settlementText(month, data, transfers));
}

async function copyPix(key) {
  try { await navigator.clipboard.writeText(key); toast('Chave Pix copiada ✓'); }
  catch { prompt('Copie a chave Pix:', key); } // sem clipboard (http ou permissão negada)
}

function initCharts() {
  Chart.defaults.color = '#8b93a3';
  Chart.defaults.borderColor = '#262a33';
  const money = { callbacks: { label: c => `${c.dataset.label ?? c.label}: ${brl(c.raw)}` } };
  barChart = new Chart($('#barChart'), {
    type: 'bar',
    data: { labels: [], datasets: [
      { label: 'Compras', data: [], backgroundColor: '#22c55e', borderRadius: 4 },
      { label: 'Consumo', data: [], backgroundColor: '#4f8cff', borderRadius: 4 },
    ] },
    options: { plugins: { tooltip: money }, scales: { y: { beginAtZero: true, ticks: { callback: brl } } } },
  });
  pieChart = new Chart($('#pieChart'), {
    type: 'doughnut',
    data: { labels: [], datasets: [{ data: [], borderWidth: 0,
      backgroundColor: ['#4f8cff', '#22c55e', '#eab308', '#ef4444', '#a855f7', '#14b8a6', '#f97316', '#ec4899', '#84cc16', '#64748b'] }] },
    options: { aspectRatio: 1.6, plugins: { tooltip: money, legend: { position: 'bottom' } } },
  });
}

/* ---------- Login ---------- */

async function start() {
  const { data } = await db.from('allowed_emails').select('email');
  if (!data?.length) { toast('Este e-mail não tem acesso ao estoque', true); return db.auth.signOut(); }
  loadBase();
}

async function sendLink(e) {
  e.preventDefault();
  const btn = e.submitter; btn.disabled = true;
  const { error } = await db.auth.signInWithOtp({
    email: $('#email').value.trim(),
    options: { emailRedirectTo: location.origin + location.pathname },
  });
  btn.disabled = false;
  toast(error ? 'Erro: ' + error.message : 'Link enviado! Confira seu e-mail 📬', !!error);
}

db.auth.onAuthStateChange((event, session) => {
  document.body.classList.toggle('out', !session);
  // setTimeout: a doc do supabase-js pede para não chamar o client dentro deste callback
  if (event === 'INITIAL_SESSION' && session || event === 'SIGNED_IN') setTimeout(start);
});

/* ---------- Eventos ---------- */

$('#loginForm').onsubmit = sendLink;
$('#logoutBtn').onclick = () => db.auth.signOut();

document.querySelector('.tabbar').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  document.querySelectorAll('.tabbar button, .view').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  $('#' + b.dataset.view).classList.add('active');
  if (b.dataset.view === 'view-dash') loadDashboard();
};
document.querySelector('.seg').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  state.type = b.dataset.type;
  document.querySelectorAll('.seg button').forEach(x => x.classList.toggle('active', x === b));
  $('#submitBtn').textContent = 'Lançar';
  renderMates();
};
$('#matePills').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  const id = b.dataset.mate || null;
  state.person = id === state.person ? null : id; // tocar de novo desmarca
  save('person', state.person);
  renderMates();
};
$('#mateForm').onsubmit = submitMate;
$('#mateList').onclick = e => {
  const { toggle, edit } = e.target.dataset;
  if (toggle) toggleMate(toggle);
  if (edit) editMate(edit);
};
$('#mateCancel').onclick = resetMateForm;
$('#transferList').onclick = e => { const k = e.target.dataset.pix; if (k) copyPix(k); };
$('#settleMonth').onchange = loadSettlement;
$('#catPills').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  state.cat = b.dataset.cat || null;
  renderPills(); renderPicker();
};
$('#picker').onclick = e => { const b = e.target.closest('button'); if (b) selectProduct(b.dataset.id); };
$('#search').oninput = renderPicker;
document.querySelector('.qty').onclick = e => {
  const step = +e.target.dataset.step; if (!step) return;
  $('#qty').value = Math.max(0, (+$('#qty').value || 0) + step);
  updateTotal();
};
$('#qty').oninput = $('#price').oninput = updateTotal;
$('#entryForm').onsubmit = submitEntry;
$('#productForm').onsubmit = submitProduct;
$('#productCancel').onclick = resetProductForm;
$('#productGrid').onclick = e => { const id = e.target.dataset.editProduct; if (id) editProduct(id); };
$('#notifyBtn').onclick = enableNotifications;
$('#periodPills').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  state.period = b.dataset.period;
  document.querySelectorAll('#periodPills button').forEach(x => x.classList.toggle('active', x === b));
  loadDashboard();
};

$('#date').value = today();
$('#settleMonth').value = today().slice(0, 7);
if (window.Notification?.permission === 'granted') $('#notifyBtn').classList.add('on');
navigator.serviceWorker?.register('sw.js').catch(() => {});
