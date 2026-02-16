// NovaLink Investor — Cloudflare Worker
const ADMIN_PASS = 'novalink2026';
const GROWTH_MULTIPLIER = 38;
const GROWTH_DAYS = 14;
const BASE_DEPOSIT = 100;

const USER_HTML = "__USER_HTML__";
const ADMIN_HTML = "__ADMIN_HTML__";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.startsWith('/api/')) return handleAPI(path, request, env, url);
    if (path === '/admin' || path === '/admin/') return new Response(ADMIN_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    return new Response(USER_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
};

function json(data, status, headers) { return new Response(JSON.stringify(data), { status, headers }); }

async function handleAPI(path, request, env, url) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Content-Type': 'application/json; charset=utf-8' };
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  try {
    if (path === '/api/portfolio' && request.method === 'GET') {
      const uid = url.searchParams.get('uid');
      if (!uid) return json({ error: 'uid required' }, 400, cors);
      return json(await getPortfolio(env, uid), 200, cors);
    }
    if (path === '/api/order' && request.method === 'POST') {
      const { uid, amount, shares } = await request.json();
      if (!uid || !amount || !shares) return json({ error: 'missing fields' }, 400, cors);
      return json(await createOrder(env, uid, Number(amount), Number(shares)), 200, cors);
    }
    if (path === '/api/withdraw' && request.method === 'POST') {
      const { uid, amount } = await request.json();
      if (!uid || !amount) return json({ error: 'missing fields' }, 400, cors);
      return json(await createWithdrawal(env, uid, Number(amount)), 200, cors);
    }
    if (path === '/api/init' && request.method === 'POST') {
      const body = await request.json();
      const uid = body.uid || crypto.randomUUID().slice(0, 8);
      await initUser(env, uid);
      return json({ uid }, 200, cors);
    }
    if (path.startsWith('/api/admin/')) {
      const auth = request.headers.get('Authorization');
      if (auth !== 'Bearer ' + ADMIN_PASS) return json({ error: 'unauthorized' }, 401, cors);
      if (path === '/api/admin/pending') return json(await getPendingOrders(env), 200, cors);
      if (path === '/api/admin/approve' && request.method === 'POST') { await approveOrder(env, (await request.json()).orderId); return json({ ok: true }, 200, cors); }
      if (path === '/api/admin/reject' && request.method === 'POST') { await rejectOrder(env, (await request.json()).orderId); return json({ ok: true }, 200, cors); }
      if (path === '/api/admin/users') return json(await getAllUsers(env), 200, cors);
      if (path === '/api/admin/settings') return json({ multiplier: GROWTH_MULTIPLIER, days: GROWTH_DAYS, base: BASE_DEPOSIT }, 200, cors);
    }
    return json({ error: 'not found' }, 404, cors);
  } catch (e) { return json({ error: e.message }, 500, cors); }
}

function calcMultiplier(days) {
  if (days <= 0) return 1;
  if (days >= GROWTH_DAYS) return GROWTH_MULTIPLIER;
  return Math.round(Math.pow(GROWTH_MULTIPLIER, days / GROWTH_DAYS) * 100) / 100;
}
function daysBetween(t1, t2) { return (t2 - t1) / 86400000; }

async function initUser(env, uid) {
  const existing = await env.INVESTOR_KV.get('user:' + uid, 'json');
  if (existing) return existing;
  const user = { uid, createdAt: Date.now(), deposits: [{ amount: BASE_DEPOSIT, timestamp: Date.now(), type: 'initial' }], totalDeposited: BASE_DEPOSIT, withdrawn: 0 };
  await env.INVESTOR_KV.put('user:' + uid, JSON.stringify(user));
  const idx = await env.INVESTOR_KV.get('index:users', 'json') || [];
  if (!idx.includes(uid)) { idx.push(uid); await env.INVESTOR_KV.put('index:users', JSON.stringify(idx)); }
  return user;
}

async function getPortfolio(env, uid) {
  const user = await env.INVESTOR_KV.get('user:' + uid, 'json');
  if (!user) return { error: 'user not found', portfolio: null };
  const now = Date.now();
  let totalValue = 0;
  for (const dep of user.deposits) { totalValue += dep.amount * calcMultiplier(daysBetween(dep.timestamp, now)); }
  totalValue = Math.round(totalValue);
  const gain = totalValue - user.totalDeposited;
  const gainPct = user.totalDeposited > 0 ? Math.round((gain / user.totalDeposited) * 1000) / 10 : 0;
  const overallDays = daysBetween(user.createdAt, now);
  const hasPendingWithdraw = await hasPendingWithdrawal(env, uid);
  return { uid: user.uid, totalValue, totalDeposited: user.totalDeposited, gain, gainPct, currentMultiplier: calcMultiplier(overallDays), daysSinceStart: Math.floor(overallDays), orders: await getOrdersForUser(env, uid), withdrawn: user.withdrawn || 0, hasPendingWithdraw };
}

async function hasPendingWithdrawal(env, uid) {
  const pending = await env.INVESTOR_KV.get('index:pending', 'json') || [];
  for (const id of pending) {
    const o = await env.INVESTOR_KV.get('order:' + id, 'json');
    if (o && o.uid === uid && o.type === 'withdraw' && o.status === 'pending') return true;
  }
  return false;
}

async function createOrder(env, uid, amount, shares) {
  const user = await env.INVESTOR_KV.get('user:' + uid, 'json');
  if (!user) throw new Error('user not found');
  const orderId = 'ord_' + crypto.randomUUID().slice(0, 8);
  const order = { orderId, uid, amount, shares, type: 'buy', status: 'pending', createdAt: Date.now() };
  await env.INVESTOR_KV.put('order:' + orderId, JSON.stringify(order));
  const pending = await env.INVESTOR_KV.get('index:pending', 'json') || [];
  pending.push(orderId); await env.INVESTOR_KV.put('index:pending', JSON.stringify(pending));
  return { orderId, status: 'pending' };
}

async function createWithdrawal(env, uid, amount) {
  const user = await env.INVESTOR_KV.get('user:' + uid, 'json');
  if (!user) throw new Error('user not found');
  if (await hasPendingWithdrawal(env, uid)) throw new Error('withdrawal already pending');
  const orderId = 'wdr_' + crypto.randomUUID().slice(0, 8);
  const order = { orderId, uid, amount, type: 'withdraw', status: 'pending', createdAt: Date.now() };
  await env.INVESTOR_KV.put('order:' + orderId, JSON.stringify(order));
  const pending = await env.INVESTOR_KV.get('index:pending', 'json') || [];
  pending.push(orderId); await env.INVESTOR_KV.put('index:pending', JSON.stringify(pending));
  return { orderId, status: 'pending' };
}

async function approveOrder(env, orderId) {
  const order = await env.INVESTOR_KV.get('order:' + orderId, 'json');
  if (!order || order.status !== 'pending') throw new Error('invalid order');
  order.status = 'approved'; order.approvedAt = Date.now();
  await env.INVESTOR_KV.put('order:' + orderId, JSON.stringify(order));
  const user = await env.INVESTOR_KV.get('user:' + order.uid, 'json');
  if (!user) return;
  if (order.type === 'withdraw') {
    user.withdrawn = (user.withdrawn || 0) + order.amount;
    user.deposits = [];
    user.totalDeposited = 0;
  } else {
    user.deposits.push({ amount: order.amount, timestamp: Date.now(), type: 'additional', orderId });
    user.totalDeposited += order.amount;
  }
  await env.INVESTOR_KV.put('user:' + user.uid, JSON.stringify(user));
  let pending = await env.INVESTOR_KV.get('index:pending', 'json') || [];
  await env.INVESTOR_KV.put('index:pending', JSON.stringify(pending.filter(id => id !== orderId)));
}

async function rejectOrder(env, orderId) {
  const order = await env.INVESTOR_KV.get('order:' + orderId, 'json');
  if (!order) throw new Error('not found');
  order.status = 'rejected'; order.rejectedAt = Date.now();
  await env.INVESTOR_KV.put('order:' + orderId, JSON.stringify(order));
  let pending = await env.INVESTOR_KV.get('index:pending', 'json') || [];
  await env.INVESTOR_KV.put('index:pending', JSON.stringify(pending.filter(id => id !== orderId)));
}

async function getPendingOrders(env) {
  const pending = await env.INVESTOR_KV.get('index:pending', 'json') || [];
  const out = [];
  for (const id of pending) { const o = await env.INVESTOR_KV.get('order:' + id, 'json'); if (o) out.push(o); }
  return out;
}

async function getOrdersForUser(env, uid) {
  const list = await env.INVESTOR_KV.list({ prefix: 'order:' });
  const out = [];
  for (const key of list.keys) { const o = await env.INVESTOR_KV.get(key.name, 'json'); if (o && o.uid === uid) out.push(o); }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

async function getAllUsers(env) {
  const idx = await env.INVESTOR_KV.get('index:users', 'json') || [];
  const out = [], now = Date.now();
  for (const uid of idx) {
    const u = await env.INVESTOR_KV.get('user:' + uid, 'json');
    if (u) { let tv = 0; for (const d of u.deposits) tv += d.amount * calcMultiplier(daysBetween(d.timestamp, now)); out.push({ uid: u.uid, totalDeposited: u.totalDeposited, totalValue: Math.round(tv), withdrawn: u.withdrawn || 0, createdAt: u.createdAt }); }
  }
  return out;
}
