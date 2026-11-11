// Saved items: the things a person keeps in a product (a Prebuild build, a Remodel room scan), one shelf per product.
// A product turns it on in deploy/clients.json with "items": { "kinds": [...], "free": 3, "pass": 500, "max_kb": 1000 }:
// how many a person may keep without and with the product's pass, and how big one may be. The data is the product's own
// JSON; Core never reads inside it. Only the product's server calls these (client id and secret), always for one person:
//   GET    /v1/items?user_id=&kind=          { items: [{ id, kind, name, thumb, size, created, updated }], used, limit, pass }
//   GET    /v1/items/<id>?user_id=           { item: { ...the same, data } }
//   POST   /v1/items  { user_id, kind, name, data, thumb?, id? }   save a new one, or replace one of theirs (id)
//   DELETE /v1/items/<id>  { user_id }
// A full shelf answers 402 LIMIT with the limit, so the product can offer its pass.
import { q } from './pb.mjs';

const SAFE = /^[a-z0-9]{15}$/;
const LIST = 'id,kind,name,thumb,size,created,updated';

export function makeItems({ pb, A, B }) {
  const view = (r, data = false) => ({ id: r.id, kind: r.kind, name: r.name, thumb: r.thumb || '', size: r.size || 0, created: r.created, updated: r.updated,
    ...(data ? { data: r.data } : {}) });

  async function api(req, res, url, form, c, json, fail) {
    const conf = c.items;
    if (!conf) return fail(res, 403, 'FORBIDDEN', 'This product does not keep saved items');
    const raw = String(req.method === 'GET' ? url.searchParams.get('user_id') ?? '' : form.user_id ?? '');
    const id = SAFE.test(raw) ? await A.resolve(raw) : null, u = id ? await A.active(id) : null;
    if (!u) return fail(res, 404, 'NOT_FOUND', 'Unknown user');
    const mine = `user_id=${q(id)} && product=${q(c.product)}`;
    const limitFor = async () => { const p = await B.passOf(id, c.product); return { pass: !!p, limit: p ? conf.pass ?? 500 : conf.free ?? 3 }; };
    const one = async (itemId) => {
      if (!SAFE.test(itemId)) return null;
      const r = await pb.get('nv_items', itemId);
      return r && r.user_id === id && r.product === c.product ? r : null;
    };
    const m = url.pathname.match(/^\/v1\/items\/([^/]+)$/);

    if (req.method === 'GET' && url.pathname === '/v1/items') {
      const kind = url.searchParams.get('kind');
      const all = [];
      for (let page = 1; page <= 10; page++) {
        const b = await pb.list('nv_items', { filter: mine + (kind ? ` && kind=${q(kind)}` : ''), sort: '-updated', perPage: 200, page, fields: LIST });
        all.push(...b); if (b.length < 200) break;
      }
      const used = kind ? (await pb.list('nv_items', { filter: mine, perPage: 500, fields: 'id' })).length : all.length;
      return json(res, 200, { items: all.map((r) => view(r)), used, ...(await limitFor()) });
    }
    if (req.method === 'GET' && m) {
      const r = await one(m[1]);
      return r ? json(res, 200, { item: view(r, true) }) : fail(res, 404, 'NOT_FOUND', 'No such item');
    }
    if (req.method === 'POST' && url.pathname === '/v1/items') {
      const kind = String(form.kind ?? '').slice(0, 30);
      if (Array.isArray(conf.kinds) && !conf.kinds.includes(kind)) return fail(res, 400, 'BAD_KIND', 'This product does not keep that kind of item');
      const name = String(form.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';
      if (form.data === undefined || form.data === null) return fail(res, 400, 'NO_DATA', 'Nothing to save');
      const size = Buffer.byteLength(JSON.stringify(form.data));
      if (size > (conf.max_kb ?? 1000) * 1024) return fail(res, 413, 'TOO_LARGE', 'This is too big to save');
      const thumb = typeof form.thumb === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(form.thumb) && form.thumb.length <= 90_000 ? form.thumb : '';
      const data = { kind, name, data: form.data, size, ...(thumb || form.thumb === '' ? { thumb } : {}) };
      if (form.id) {
        const r = await one(String(form.id));
        if (!r) return fail(res, 404, 'NOT_FOUND', 'No such item');
        return json(res, 200, { item: view(await pb.update('nv_items', r.id, data)) });
      }
      const { limit, pass } = await limitFor();
      const used = (await pb.list('nv_items', { filter: mine, perPage: limit + 1, fields: 'id' })).length;
      if (used >= limit) return json(res, 402, { error: { code: 'LIMIT', message: pass ? 'Your shelf is full' : 'Free accounts keep ' + limit }, limit, pass });
      const r = await pb.create('nv_items', { user_id: id, product: c.product, thumb: '', ...data });
      return json(res, 201, { item: view(r) });
    }
    if (req.method === 'DELETE' && m) {
      const r = await one(m[1]);
      if (!r) return fail(res, 404, 'NOT_FOUND', 'No such item');
      await pb.remove('nv_items', r.id);
      return json(res, 200, { deleted: r.id });
    }
    return fail(res, 404, 'NOT_FOUND', 'No such endpoint');
  }
  return { api };
}
