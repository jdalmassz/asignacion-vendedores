import express from 'express';
import cors from 'cors';
import compression from 'compression';
import * as ventra from './ventra.js';
import {
  listarAsignaciones, crearAsignacion, borrarAsignacion,
  listarCobros, marcarCobro, desmarcarCobro, cobrosManualesSet,
} from './almacen.js';

const app = express();
app.use(cors());
app.use(compression());
app.use(express.json());

try {
  process.loadEnvFile();
} catch (e) {
  // .env no existe: usar variables de entorno del sistema
}

// Procovar API config
const API_BASE = process.env.PROCOVAR_API_BASE || 'https://pedidos.procovar.cloud/api';
const API_KEY = process.env.PROCOVAR_API_KEY || '';
const SUCURSAL_ID = process.env.PROCOVAR_SUCURSAL_ID || '';

/**
 * Los datos del punto de venta ya no salen de MySQL, sino de la API de Ventra.
 *
 * La base `camaguey` vive en la red local de la sucursal (`192.168.1.217`) y desde el
 * servidor no se alcanza. Ventra la publica por HTTP y es lo que usa analitics. Ver
 * `ventra.js`.
 */

// Caché en memoria con TTL. cachea la promesa para evitar "thundering herd"
// (varias requests concurrentes comparten el mismo fetch).
const cache = new Map();

function cached(key, ttlMs, fn) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.ts < ttlMs) return hit.promise;
  const promise = Promise.resolve().then(fn).catch(err => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, { ts: now, promise });
  return promise;
}

function invalidate(prefix) {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}


function normalizeVendedorName(note) {
  if (!note) return null;
  const idx = note.indexOf('V-');
  if (idx === -1) return null;
  let name = note.substring(idx + 2).split(';')[0].trim();
  name = name.replace(/Ñ/gi, 'N');
  name = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  name = name.replace(/PADRAN/gi, 'PADRON');
  name = name.replace(/HECAVARRAA/gi, 'HECAVARRIA');
  name = name.replace(/IRADIEL(?!\sCISNEROS)/gi, 'IRADIEL CISNEROS');
  name = name.replace(/[^A-Za-z\s]/g, '').toUpperCase();
  return name.replace(/\s+/g, ' ').trim();
}

function normProdTokens(s) {
  if (!s) return [];
  return s
    .toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/0\.5|0,5/g, ' 500 ')
    .replace(/1\.5|1,5/g, ' 1500 ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !/^(CERVEZA|MALTA|BOTELLA|BLISTER|REGIO|GUAJIRA)$/.test(t));
}

function canonCode(g) {
  return String(g.Code || '').trim() || String(g.ID);
}

// Índice de productos para búsquedas O(1) en vez de recorrer el array por cada ítem.
function makeGoodsIndex(goods) {
  const byCanon = new Map();
  const byRawCode = new Map();
  const byId = new Map();
  const tokensList = [];
  for (const g of goods) {
    byId.set(g.ID, g);
    byCanon.set(canonCode(g).toUpperCase(), g);
    if (g.Code) byRawCode.set(String(g.Code).trim(), g);
    tokensList.push({ id: g.ID, tokens: new Set(normProdTokens(g.Name)) });
  }
  return { byCanon, byRawCode, byId, tokensList };
}

async function loadGoodsIndex() {
  return cached('goodsIndex', 5 * 60 * 1000, async () => {
    return makeGoodsIndex(await ventra.productos());
  });
}

function findGoodIDForAsign(a, index) {
  const pid = String(a.producto_id || '').trim();
  const byCode = index.byRawCode.get(pid);
  if (byCode) return byCode.ID;

  const aTokens = normProdTokens(a.producto_nombre + ' ' + a.producto_id);
  let best = null, bestScore = 0;
  for (const g of index.tokensList) {
    let score = 0;
    for (const t of aTokens) if (g.tokens.has(t)) score++;
    if (score > bestScore) { bestScore = score; best = g.id; }
  }
  return bestScore >= 2 ? best : null;
}

function goodIdFromItem(it, index) {
  if (!it) return null;
  const c = String(it.codigo || '').trim().toUpperCase();
  if (c) {
    const byCode = index.byCanon.get(c);
    if (byCode) return byCode.ID;
  }
  return findGoodIDForAsign({ producto_id: it.codigo || '', producto_nombre: it.producto || it.codigo || '' }, index) || null;
}

/** El primer y el último día del mes en curso, `AAAA-MM-DD`. */
function rangoDelMes() {
  const hoy = new Date();
  const a = hoy.getFullYear();
  const m = String(hoy.getMonth() + 1).padStart(2, '0');
  const ultimo = new Date(a, hoy.getMonth() + 1, 0).getDate();

  return [`${a}-${m}-01`, `${a}-${m}-${String(ultimo).padStart(2, '0')}`];
}

async function apiGet(path) {
  const url = `${API_BASE}${path}${path.includes('?') ? '&' : '?'}sucursalId=${SUCURSAL_ID}`;
  const resp = await fetch(url, {
    headers: {
      'x-api-key': API_KEY,
      'Content-Type': 'application/json'
    }
  });
  if (!resp.ok) throw new Error(`API error ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function fetchAllOrders(desde, hasta) {
  return cached(`orders:${desde}:${hasta}`, 60 * 1000, () => fetchAllOrdersUncached(desde, hasta));
}

async function fetchAllOrdersUncached(desde, hasta) {
  const allOrders = [];
  let page = 1;
  const limit = 1000;
  let totalPages = 1;

  while (page <= totalPages) {
    /**
     * `fechaDesde` y `fechaHasta`, no `desde` y `hasta`.
     *
     * PEDIDO lee esos dos nombres y **ignora en silencio** cualquier otro: con `desde` y
     * `hasta` no filtraba nada y esto se traía los 63.000 pedidos de todas las sucursales,
     * de mil en mil, tres veces por pantalla. No fallaba: tardaba y contaba de más.
     */
    let path = `/orders?page=${page}&limit=${limit}`;
    if (desde) path += `&fechaDesde=${desde}`;
    if (hasta) path += `&fechaHasta=${hasta}`;

    const result = await apiGet(path);

    if (Array.isArray(result)) {
      allOrders.push(...result);
      break;
    }

    if (result.data) {
      allOrders.push(...result.data);
      if (result.pagination) {
        totalPages = result.pagination.totalPages;
      }
    } else {
      break;
    }

    page++;
    await new Promise(r => setTimeout(r, 200));
  }

  // Filtro extra por fecha (la API devuelve pedidos fuera de rango en las últimas páginas)
  const desdeTs = desde ? new Date(desde + 'T00:00:00').getTime() : null;
  const hastaTs = hasta ? new Date(hasta + 'T23:59:59').getTime() : null;
  const filtrados = allOrders.filter(o => {
    if (!o.fecha) return true;
    const ts = new Date(o.fecha).getTime();
    if (desdeTs && ts < desdeTs) return false;
    if (hastaTs && ts > hastaTs) return false;
    return true;
  });

  // Deduplicar por id (la paginación repite pedidos en páginas distintas)
  const vistos = new Set();
  return filtrados.filter(o => {
    if (!o.id) return true;
    if (vistos.has(o.id)) return false;
    vistos.add(o.id);
    return true;
  });
}

// GET /api/vendedores — desde Procovar API
app.get('/api/vendedores', async (req, res) => {
  try {
    const vendedores = await apiGet('/vendedores');
    const activos = vendedores.filter(v => v.activo);
    activos.sort((a, b) => a.nombre.localeCompare(b.nombre));
    res.json({ vendedores: activos.map(v => ({
      id: v.id,
      nombre: v.nombre,
      codigo: v.codigo
    }))});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/productos — productos únicos de Procovar API con stock
app.get('/api/productos', async (req, res) => {
  try {
    const orders = await fetchAllOrders(...rangoDelMes());
    const seen = {};
    for (const order of orders) {
      if (!order.items) continue;
      for (const item of order.items) {
        const name = item.producto || item.codigo;
        if (name && !seen[name]) {
          seen[name] = {
            id: item.codigo || name,
            code: item.codigo || '',
            name: name,
            precio: item.precioUnidad || 0,
            stock: item.stock || 0
          };
        }
        if (name && item.stock > (seen[name]?.stock || 0)) {
          seen[name].stock = item.stock;
        }
      }
    }
    const productos = Object.values(seen)
      .filter(p => p.stock > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ productos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Las asignaciones de un mes.
 *
 * El mes viene de fuera, y si no viene se usa el actual. Antes estaba escrito a mano
 * (`startsWith('2026-09')`): en octubre la pantalla se habría quedado vacía y nadie habría
 * sabido por qué.
 */
function mesActual() {
  return new Date().toISOString().slice(0, 7);
}

function getAsignaciones(mes) {
  return listarAsignaciones(mes || mesActual());
}

// GET /api/asignaciones — acepta ?mes=AAAA-MM; sin él, el mes en curso
app.get('/api/asignaciones', async (req, res, next) => {
  try {
    res.json({ asignaciones: await getAsignaciones(req.query.mes) });
  } catch (e) { next(e); }
});

// POST /api/asignaciones
app.post('/api/asignaciones', async (req, res, next) => {
  try {
    const { vendedor, producto_id, producto_nombre, cantidad, fecha } = req.body;
    const nueva = await crearAsignacion({ vendedor, producto_id, producto_nombre, cantidad, fecha });

    res.json({ success: true, id: nueva.id, asignacion: nueva });
  } catch (e) { next(e); }
});

// DELETE /api/asignaciones/:id
app.delete('/api/asignaciones/:id', async (req, res, next) => {
  try {
    const borrada = await borrarAsignacion(req.params.id);

    if (!borrada) return res.status(404).json({ success: false, error: 'Asignación no encontrada' });

    res.json({ success: true });
  } catch (e) { next(e); }
});

// GET /api/ventas — desde MariaDB (operaciones despachadas Sign=-1)
async function computeVentas() {
  return cached('ventas', 60 * 1000, async () => {
    // El mes en curso. Antes eran dos fechas escritas a mano ('2026-09-01'..'2026-10-01').
    const hoy = new Date();
    const primero = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-01`;
    const ultimo = hoy.toISOString().split('T')[0];
    const rows = await ventra.ventas(primero, ultimo);

    const ventas = [];
    for (const row of rows) {
      const vendedor = normalizeVendedorName(row.Note);
      if (!vendedor) continue;
      const fechaStr = row.Date instanceof Date
        ? `${row.Date.getFullYear()}-${String(row.Date.getMonth() + 1).padStart(2, '0')}-${String(row.Date.getDate()).padStart(2, '0')}`
        : String(row.Date).split('T')[0];
      ventas.push({
        vendedor,
        producto_id: row.GoodID,
        producto_nombre: row.Name,
        precio: row.PriceOut1 || 0,
        cantidad: row.TotalVendido || 0,
        total: (row.PriceOut1 || 0) * (row.TotalVendido || 0),
        fecha: fechaStr,
        cliente: row.PartnerID || 0
      });
    }
    return ventas;
  });
}

app.get('/api/ventas', async (req, res) => {
  try {
    res.json({ ventas: await computeVentas() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Los despachos reales del mes, por vendedor y producto. Salen de Ventra, no de MySQL.
async function loadDespachos() {
  return cached('despachos', 60 * 1000, async () => {
    const hoy = new Date();
    const primero = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-01`;
    // `ventra.ventas` ya agrupa y ya filtra por tipo de operación y por la nota `V-`.
    const rows = (await ventra.ventas(primero, hoy.toISOString().split('T')[0]))
      .map((r) => ({ Note: r.Note, GoodID: r.GoodID, Qtty: r.TotalVendido }));

    const despachosMap = {};   // vendedor|GoodID -> packs despachados
    const foliosDespachados = new Set();
    for (const row of rows) {
      const vendedor = normalizeVendedorName(row.Note);
      if (!vendedor) continue;
      const m = row.Note.match(/(?:^|;)P-([A-Z0-9\-]+);/i);
      if (m) foliosDespachados.add(m[1].toUpperCase());
      despachosMap[`${vendedor}|${row.GoodID}`] = (despachosMap[`${vendedor}|${row.GoodID}`] || 0) + (row.Qtty || 0);
    }
    return { despachosMap, foliosDespachados };
  });
}

async function computeResumen() {
  // El mes en curso, no uno escrito a mano: ver `getAsignaciones`.
  const asignSep = await listarAsignaciones(mesActual());

  // Group assignments by vendedor + producto (mapear a GoodID real)
  const goodsIndex = await loadGoodsIndex();
  const asignMap = {};
  const asignInfo = {};
  for (const a of asignSep) {
    const vendedorNorm = normalizeVendedorName('V-' + a.vendedor) || a.vendedor;
    const goodId = findGoodIDForAsign(a, goodsIndex);
    if (!goodId) continue;
    const g = goodsIndex.byId.get(goodId);
    const key = `${vendedorNorm}|${goodId}`;
    if (!asignMap[key]) {
      asignMap[key] = 0;
      asignInfo[key] = {
        vendedor: vendedorNorm,
        goodId,
        producto_id: g ? canonCode(g) : String(a.producto_id || a.producto_nombre || goodId),
        producto_nombre: g ? g.Name : a.producto_nombre
      };
    }
    asignMap[key] += a.cantidad;
  }

  // Despachos REALES desde MariaDB (Sign=-1) en el mes, por vendedor + GoodID
  const { despachosMap, foliosDespachados } = await loadDespachos();

  // Pedidos del API: solo en_proceso que aún NO se despacharon (evitar doble conteo)
  // Los que ya están cobrados (pedido_cobrado=completo o marcado manual) van a "cobrado",
  // no a "en_proceso" (que queda solo para los que de verdad no han pagado).
  const orders = await fetchAllOrders(...rangoDelMes());
  const cobrosManuales = await cobrosManualesSet();
  const procesoMap = {};
  const cobradoMap = {};
  for (const o of orders) {
    if (o.estado !== 'en_proceso') continue;
    if (!o.folio) continue;
    if (foliosDespachados.has(o.folio.toUpperCase())) continue;
    const vendedor = normalizeVendedorName('V-' + (o.vendedor?.nombre || ''));
    if (!vendedor) continue;
    const esCobrado = o.pedido_cobrado === 'completo' || cobrosManuales.has(o.folio.toUpperCase());
    for (const it of (o.items || [])) {
      const goodId = goodIdFromItem(it, goodsIndex);
      if (!goodId) continue;
      const key = `${vendedor}|${goodId}`;
      if (!asignInfo[key]) continue;
      const target = esCobrado ? cobradoMap : procesoMap;
      target[key] = (target[key] || 0) + (it.packs || 0);
    }
  }

  // Build resumen: completada = despachos reales (topeado al asignado),
  // cobrado = pagado pendiente de despacho, en_proceso = el resto sin pagar
  const resumen = [];
  for (const key in asignMap) {
    const info = asignInfo[key];
    const completada = Math.min(despachosMap[`${info.vendedor}|${info.goodId}`] || 0, asignMap[key]);
    const cobrado = cobradoMap[key] || 0;
    const enProceso = procesoMap[key] || 0;
    resumen.push({
      vendedor: info.vendedor,
      producto_id: info.producto_id,
      good_id: info.goodId,
      producto_nombre: info.producto_nombre,
      asignado: asignMap[key],
      en_proceso: enProceso,
      cobrado,
      completada,
      pendiente: Math.max(0, asignMap[key] - completada - cobrado)
    });
  }
  return resumen;
}

// GET /api/resumen — asignaciones vs despachos reales (MariaDB) + pedidos en proceso (API)
app.get('/api/resumen', async (req, res) => {
  try {
    res.json({ resumen: await computeResumen() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/almacen — desde MariaDB (store, inventario real)
async function computeAlmacen() {
  return cached('almacen', 60 * 1000, async () => {
    const rows = await ventra.almacen();

    const almacenes = {};
    for (const r of rows) {
      if (!r.Name || !r.ID) continue;
      const nombre = r.almacen || ('Almacen ' + r.object_id);
      if (!almacenes[nombre]) almacenes[nombre] = { almacen: nombre, productos: [] };
      almacenes[nombre].productos.push({
        producto_id: r.Code || r.ID,
        nombre: r.Name,
        precio: r.PriceOut1 || 0,
        stock: r.stock
      });
    }
    Object.values(almacenes).forEach(a => {
      a.productos.sort((x, y) => x.nombre.localeCompare(y.nombre));
      a.total_unidades = a.productos.reduce((s, p) => s + p.stock, 0);
      a.total_valor = a.productos.reduce((s, p) => s + (p.precio || 0) * p.stock, 0);
    });
    const lista = Object.values(almacenes).sort((a, b) => a.almacen.localeCompare(b.almacen));
    const totales = {
      productos: lista.reduce((s, a) => s + a.productos.length, 0),
      unidades: lista.reduce((s, a) => s + a.total_unidades, 0),
      valor: lista.reduce((s, a) => s + a.total_valor, 0)
    };
    return { productos: lista, totales };
  });
}

app.get('/api/almacen', async (req, res) => {
  try {
    res.json(await computeAlmacen());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clientes-por-vendedor — desde Procovar API
app.get('/api/clientes-por-vendedor', async (req, res) => {
  try {
    const data = await apiGet('/clientes/por-vendedor');
    res.json({ vendedores: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/detalle-proceso — detalle de pedidos en_proceso por vendedor+producto
async function computeDetalleProceso() {
  const orders = await fetchAllOrders(...rangoDelMes());
  const goodsIndex = await loadGoodsIndex();

  // Despachos reales para saber qué folios ya se despacharon
  const { foliosDespachados } = await loadDespachos();

  const result = {};
  const cobrosManuales = await cobrosManualesSet();
  for (const o of orders) {
    if (o.estado !== 'en_proceso') continue;
    if (!o.folio) continue;
    if (foliosDespachados.has(o.folio.toUpperCase())) continue;
    const vendedor = normalizeVendedorName('V-' + (o.vendedor?.nombre || ''));
    if (!vendedor) continue;
    const pedidoCobrado = o.pedido_cobrado === 'completo' || cobrosManuales.has(o.folio.toUpperCase());
    for (const it of (o.items || [])) {
      const goodId = goodIdFromItem(it, goodsIndex);
      if (!goodId) continue;
      const g = goodsIndex.byId.get(goodId);
      const producto_id = g ? canonCode(g) : String(it.codigo || it.producto || goodId);
      const key = `${vendedor}|${producto_id}`;
      if (!result[key]) {
        result[key] = { vendedor, producto_id, pedidos: [] };
      }
      result[key].pedidos.push({
        folio: o.folio,
        producto_codigo: it.codigo,
        packs: it.packs || 0,
        fecha: o.fecha || null,
        cliente_nombre: o.cliente?.nombre || null,
        cobrado: pedidoCobrado
      });
    }
  }
  return Object.values(result);
}

app.get('/api/detalle-proceso', async (req, res) => {
  try {
    res.json({ detalle: await computeDetalleProceso() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard — resumen + ventas + asignaciones en UNA sola request
app.get('/api/dashboard', async (req, res) => {
  try {
    const [resumen, ventas, asignaciones] = await Promise.all([
      computeResumen(),
      computeVentas(),
      Promise.resolve(getAsignaciones())
    ]);
    res.json({ resumen, ventas, asignaciones });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/init-db
app.get('/api/init-db', (req, res) => {
  res.json({ success: true, message: 'OK' });
});

// POST /api/cobros — marca un pedido como cobrado manualmente
app.post('/api/cobros', async (req, res, next) => {
  try {
    const { folio } = req.body;

    if (!folio) return res.status(400).json({ success: false, error: 'folio requerido' });

    // Idempotente: marcarlo dos veces deja una sola marca. Ver `almacen.marcarCobro`.
    await marcarCobro(folio);
    res.json({ success: true });
  } catch (e) { next(e); }
});

// DELETE /api/cobros/:folio — desmarca un pedido manualmente marcado
app.delete('/api/cobros/:folio', async (req, res, next) => {
  try {
    const quitado = await desmarcarCobro(req.params.folio || '');

    if (!quitado) return res.status(404).json({ success: false, error: 'No encontrado' });

    res.json({ success: true });
  } catch (e) { next(e); }
});

/**
 * El último recurso: cualquier fallo no atrapado contesta 500 con su motivo.
 *
 * Sin esto, un error dentro de un `async` deja la petición colgada hasta que vence el
 * tiempo del navegador, y en la pantalla se ve un spinner eterno en vez de un error.
 */
app.use((err, _req, res, _next) => {
  console.error('[asignaciones]', err);
  res.status(500).json({ success: false, error: err?.message || 'error interno' });
});

/**
 * Comprobación al arrancar: que la sucursal configurada devuelva pedidos.
 *
 * PEDIDO acepta el ID de la sucursal, no su código. Si se le manda `CAM` en vez del
 * identificador **contesta 200 con cero pedidos**, sin error ninguno: las pantallas salen
 * vacías y parece que no hay ventas ese mes. Costó encontrarlo una vez; que avise solo.
 *
 * No impide arrancar —una caída de PEDIDO no puede tumbar esto— pero lo deja escrito en
 * el log, que es donde se mira cuando algo sale en blanco.
 */
async function avisarSiLaSucursalNoDevuelveNada() {
  try {
    const [desde, hasta] = rangoDelMes();
    const r = await apiGet(`/orders?page=1&limit=1&fechaDesde=${desde}&fechaHasta=${hasta}`);
    const total = r?.pagination?.total ?? (Array.isArray(r) ? r.length : 0);

    if (total > 0) {
      console.log(`[pedido] sucursal ${SUCURSAL_ID}: ${total} pedidos este mes`);
    } else {
      console.warn(
        `[pedido] AVISO: la sucursal '${SUCURSAL_ID}' no devuelve ningún pedido este mes. ` +
        `Comprueba PROCOVAR_SUCURSAL_ID: tiene que ser el ID de la sucursal, no su código ` +
        `(no vale 'CAM').`,
      );
    }
  } catch (e) {
    console.warn('[pedido] no se pudo comprobar la sucursal al arrancar:', e.message);
  }
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  void avisarSiLaSucursalNoDevuelveNada();
});
