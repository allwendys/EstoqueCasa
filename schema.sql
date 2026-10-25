-- Estoque Casa: schema completo (rodar no SQL Editor do Supabase)

create table categories (
  id   uuid primary key default gen_random_uuid(),
  name text not null unique,
  icon text
);

create table products (
  id            uuid primary key default gen_random_uuid(),
  category_id   uuid references categories(id) on delete set null,
  name          text not null,
  unit          text not null default 'un',
  current_stock numeric not null default 0 check (current_stock >= 0),
  min_stock     numeric not null default 1,
  target_stock  numeric not null default 5,
  default_price numeric not null default 0,
  image_url     text,
  created_at    timestamptz not null default now()
);
create index products_category_idx on products(category_id);

create table stock_transactions (
  id               uuid primary key default gen_random_uuid(),
  product_id       uuid not null references products(id) on delete cascade,
  type             text not null check (type in ('PURCHASE', 'CONSUMPTION')),
  quantity         numeric not null check (quantity > 0),
  unit_price       numeric not null default 0 check (unit_price >= 0),
  total_price      numeric generated always as (quantity * unit_price) stored,
  transaction_date date not null default current_date,
  notes            text,
  created_at       timestamptz not null default now()
);
create index stock_tx_date_idx on stock_transactions(transaction_date);
create index stock_tx_product_idx on stock_transactions(product_id);

-- Mantém current_stock em sincronia em insert/update/delete (desfazer um lançamento = apagar a linha).
-- Compra também atualiza o preço de referência, que o formulário usa como pré-preenchimento.
create function apply_stock_tx() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    update products
       set current_stock = current_stock - case when old.type = 'PURCHASE' then old.quantity else -old.quantity end
     where id = old.product_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    update products
       set current_stock = current_stock + case when new.type = 'PURCHASE' then new.quantity else -new.quantity end,
           default_price = case when new.type = 'PURCHASE' and new.unit_price > 0 then new.unit_price else default_price end
     where id = new.product_id;
  end if;
  return null;
end $$;

create trigger stock_tx_apply
after insert or update or delete on stock_transactions
for each row execute function apply_stock_tx();

-- Acesso: login por link mágico + lista de e-mails da casa.
-- Qualquer um consegue criar conta no Auth, por isso a RLS exige o e-mail na lista, não só estar logado.
-- Para liberar alguém: insert into allowed_emails values ('email@exemplo.com');
create table allowed_emails (email text primary key check (email = lower(email)));
alter table allowed_emails enable row level security;
create policy "read own" on allowed_emails for select to authenticated
  using (email = lower((select auth.jwt() ->> 'email')));
insert into allowed_emails values ('seu-email@exemplo.com'); -- troque pelo(s) e-mail(s) da casa

alter table categories enable row level security;
alter table products enable row level security;
alter table stock_transactions enable row level security;
create policy "members" on categories for all to authenticated
  using (exists (select 1 from allowed_emails where email = lower((select auth.jwt() ->> 'email'))))
  with check (exists (select 1 from allowed_emails where email = lower((select auth.jwt() ->> 'email'))));
create policy "members" on products for all to authenticated
  using (exists (select 1 from allowed_emails where email = lower((select auth.jwt() ->> 'email'))))
  with check (exists (select 1 from allowed_emails where email = lower((select auth.jwt() ->> 'email'))));
create policy "members" on stock_transactions for all to authenticated
  using (exists (select 1 from allowed_emails where email = lower((select auth.jwt() ->> 'email'))))
  with check (exists (select 1 from allowed_emails where email = lower((select auth.jwt() ->> 'email'))));

insert into categories (name, icon) values
  ('Grãos & Massas', '🌾'),
  ('Laticínios', '🧀'),
  ('Carnes & Ovos', '🥩'),
  ('Hortifruti', '🥦'),
  ('Bebidas', '🥤'),
  ('Temperos & Molhos', '🧂'),
  ('Padaria & Café', '☕'),
  ('Congelados', '🧊'),
  ('Limpeza', '🧽'),
  ('Higiene', '🧴');

-- ============================================================
-- Migração 2: moradores e acerto de contas (incremental)
-- ============================================================

create table housemates (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  avatar_icon  text not null default '🙂',
  pix_key      text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);
alter table housemates enable row level security;
create policy "members" on housemates for all to authenticated
  using (exists (select 1 from allowed_emails where email = lower((select auth.jwt() ->> 'email'))))
  with check (exists (select 1 from allowed_emails where email = lower((select auth.jwt() ->> 'email'))));

-- FKs sem cascade: apagar morador com histórico é bloqueado (use is_active = false).
alter table stock_transactions
  add column buyer_id      uuid references housemates(id),
  add column consumer_id   uuid references housemates(id),
  add column is_collective boolean not null default true,
  add constraint buyer_only_on_purchase check (buyer_id is null or type = 'PURCHASE'),
  add constraint consumer_only_on_consumption check (consumer_id is null or type = 'CONSUMPTION');
create index stock_tx_buyer_idx on stock_transactions(buyer_id);
create index stock_tx_consumer_idx on stock_transactions(consumer_id);

-- Fechamento do mês. Regras (a soma dos saldos é sempre zero):
--   pagou        = compras com buyer_id = morador
--   custo direto = compras individuais dele + consumos individuais dele (consumer_id)
--   parcela      = (compras coletivas com comprador - todos os consumos individuais) / moradores ativos
--   saldo        = pagou - custo direto - parcela   (> 0 a receber, < 0 deve pagar)
-- Consumo individual = alguém usou sozinho algo do estoque da casa; sai do bolo coletivo e vai para a conta dele.
-- Compras sem comprador (anteriores a este recurso) ficam fora do acerto.
create function month_settlement(p_month date default current_date)
returns table (housemate_id uuid, mate_name text, avatar_icon text, pix_key text,
               paid numeric, direct_cost numeric, collective_share numeric, balance numeric)
language sql stable set search_path = public as $$
  with tx as (
    select * from stock_transactions
    where transaction_date >= date_trunc('month', p_month)::date
      and transaction_date <  (date_trunc('month', p_month) + interval '1 month')::date
  ),
  pot as (
    select (coalesce(sum(total_price) filter (where type = 'PURCHASE' and is_collective and buyer_id is not null), 0)
          - coalesce(sum(total_price) filter (where type = 'CONSUMPTION' and consumer_id is not null), 0))
         / nullif((select count(*) from housemates where is_active), 0) as share
    from tx
  ),
  per as (
    select h.id, h.name, h.avatar_icon, h.pix_key,
      coalesce((select sum(total_price) from tx where type = 'PURCHASE' and buyer_id = h.id), 0) as paid,
      coalesce((select sum(total_price) from tx where type = 'PURCHASE' and buyer_id = h.id and not is_collective), 0)
    + coalesce((select sum(total_price) from tx where type = 'CONSUMPTION' and consumer_id = h.id), 0) as direct,
      case when h.is_active then coalesce((select share from pot), 0) else 0 end as share
    from housemates h
    -- inativos só aparecem se movimentaram no mês, para o saldo continuar fechando em zero
    where h.is_active or exists (select 1 from tx where tx.buyer_id = h.id or tx.consumer_id = h.id)
  )
  select id, name, avatar_icon, pix_key, round(paid, 2), round(direct, 2), round(share, 2),
         round(paid - direct - share, 2)
  from per order by name;
$$;

-- ============================================================
-- Migração 3: % de cada morador e categoria da Minnie (incremental)
-- ============================================================

alter table housemates add column share_pct numeric not null default 0 check (share_pct between 0 and 100);

insert into categories (name, icon) values ('Minnie', '🐶') on conflict (name) do nothing;

-- Mudou o tipo de retorno (nova coluna share_pct), então precisa recriar.
drop function month_settlement(date);
create function month_settlement(p_month date default current_date)
returns table (housemate_id uuid, mate_name text, avatar_icon text, pix_key text, share_pct numeric,
               paid numeric, direct_cost numeric, collective_share numeric, balance numeric)
language sql stable set search_path = public as $$
  with tx as (
    select * from stock_transactions
    where transaction_date >= date_trunc('month', p_month)::date
      and transaction_date <  (date_trunc('month', p_month) + interval '1 month')::date
  ),
  -- Peso de cada ativo = % cadastrada normalizada para somar 100%; se ninguém tem %, divide igual.
  w as (
    select h.id,
      case when sum(h.share_pct) over () > 0 then h.share_pct / sum(h.share_pct) over ()
           else 1.0 / count(*) over () end as weight
    from housemates h where h.is_active
  ),
  pot as (
    select coalesce(sum(total_price) filter (where type = 'PURCHASE' and is_collective and buyer_id is not null), 0)
         - coalesce(sum(total_price) filter (where type = 'CONSUMPTION' and consumer_id is not null), 0) as total
    from tx
  ),
  per as (
    select h.id, h.name, h.avatar_icon, h.pix_key, coalesce(w.weight, 0) as weight,
      coalesce((select sum(total_price) from tx where type = 'PURCHASE' and buyer_id = h.id), 0) as paid,
      coalesce((select sum(total_price) from tx where type = 'PURCHASE' and buyer_id = h.id and not is_collective), 0)
    + coalesce((select sum(total_price) from tx where type = 'CONSUMPTION' and consumer_id = h.id), 0) as direct
    from housemates h left join w on w.id = h.id
    -- inativos só aparecem se movimentaram no mês, para o saldo continuar fechando em zero
    where h.is_active or exists (select 1 from tx where tx.buyer_id = h.id or tx.consumer_id = h.id)
  )
  select id, name, avatar_icon, pix_key, round(weight * 100, 2), round(paid, 2), round(direct, 2),
         round(weight * (select total from pot), 2),
         round(paid - direct - weight * (select total from pot), 2)
  from per order by name;
$$;
