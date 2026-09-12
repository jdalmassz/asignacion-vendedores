/**
 * De dónde salen los productos, las ventas y el almacén.
 *
 * # Por qué la API y no el MySQL
 *
 * El código leía directamente la base `camaguey` en `192.168.1.217`, que es una dirección
 * de la red local de la sucursal. Eso funciona en el portátil de quien está allí y **no se
 * alcanza desde el servidor**: puesto en producción, las pantallas de resumen, almacén y
 * dashboard devolvían 500 y el resto de la aplicación parecía rota.
 *
 * Ventra ya expone esos mismos datos por HTTP, y es lo que usa `analitics` desde hace
 * meses. Se lee por ahí:
 *
 * | Antes, en MySQL | Ahora, en Ventra |
 * |---|---|
 * | `goods`      | `/axis/products` |
 * | `operations` | `/axis/sales`    |
 * | `store`      | `/axis/stock`    |
 *
 * # El cambio que esto obliga: se cruza por CÓDIGO, no por número
 *
 * En MySQL el enlace entre una venta y su producto era `operations.GoodID = goods.ID`, un
 * número interno. Ventra no lo publica: identifica el producto por su **código**
 * (`RONE0009`). Así que el índice de productos pasa a llevar el código como identidad.
 *
 * Es más robusto, además: el código es el mismo en todas las sucursales y el número
 * interno no tiene por qué serlo.
 */

const BASE = process.env.VENTRA_API_URL || 'http://10.188.2.2:3001/api/external-api';
const TOKEN = process.env.VENTRA_API_TOKEN || '';
const DB = process.env.VENTRA_DB || 'camaguey';

/**
 * El nombre con el que Ventra llama a esta sucursal en el inventario.
 *
 * Hace falta porque **`/axis/stock` ignora el parámetro `database`**: se le pida lo que se
 * le pida, devuelve las diez sucursales con `database: "all"`. Sin filtrar aquí, el
 * almacén de Camagüey saldría mezclado con el de La Habana y el de Santiago.
 */
const SUCURSAL = process.env.VENTRA_SUCURSAL || 'CAMAGUEY';

/** Sólo las ventas. Las devoluciones y los traslados son otros tipos y no cuentan. */
const TIPO_VENTA = 2;

class VentraNoDisponible extends Error {}

async function pedir(ruta) {
  if (!TOKEN) throw new VentraNoDisponible('falta VENTRA_API_TOKEN');

  const r = await fetch(`${BASE}${ruta}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });

  if (!r.ok) throw new VentraNoDisponible(`Ventra ${r.status}: ${(await r.text()).slice(0, 200)}`);

  return r.json();
}

/**
 * El precio de cada producto, sacado de lo que se ha vendido.
 *
 * Ventra **no publica el precio** ni en `/axis/products` ni en `/axis/stock`: sólo aparece
 * en las ventas, como `priceOut`. En MySQL venía en `goods.PriceOut1`, así que al pasar a
 * la API el precio se perdía y todo salía a $0.00.
 *
 * Se toma el precio de la venta MÁS RECIENTE de cada producto, que es el que está vigente.
 * Un producto que no se ha vendido nunca se queda sin precio — y eso es honesto: no lo
 * sabemos, y poner cero diría que es gratis.
 */
async function preciosRecientes() {
  const hoy = new Date();
  const desde = new Date(hoy.getTime() - 90 * 24 * 3600 * 1000).toISOString().split('T')[0];
  const d = await pedir(`/axis/sales?database=${DB}&from=${desde}&to=${hoy.toISOString().split('T')[0]}&limit=100000`);
  const precios = new Map();

  // De más viejo a más nuevo, así el último que se escribe es el precio vigente.
  for (const f of (d.rows || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    const precio = Number(f.priceOut);

    if (f.productCode && Number.isFinite(precio) && precio > 0) precios.set(f.productCode, precio);
  }

  return precios;
}

/**
 * Los productos, con la misma forma que tenían las filas de `goods`.
 *
 * Se conservan los nombres de campo de antes (`ID`, `Code`, `Name`) para no tener que
 * tocar el resto del código, que los usa por todas partes. `ID` pasa a ser el código.
 */
export async function productos() {
  const [filas, precios] = await Promise.all([
    pedir(`/axis/products?database=${DB}&limit=5000`),
    preciosRecientes().catch(() => new Map()),
  ]);

  return (Array.isArray(filas) ? filas : filas.items || [])
    .filter((p) => p.isActive !== false)
    .map((p) => ({
      ID: p.sku,
      Code: p.sku,
      Name: p.name,
      PriceOut1: precios.get(p.sku) ?? null,
      Measure1: p.unit ?? null,
      Measure2: null,
    }));
}

/**
 * Las ventas de un rango, con la forma que tenían las filas de `operations`.
 *
 * Ventra devuelve línea a línea y el código de antes agrupaba en SQL, así que se agrupa
 * aquí por la misma clave: nota + producto + fecha + cliente.
 */
export async function ventas(desde, hasta) {
  const d = await pedir(`/axis/sales?database=${DB}&from=${desde}&to=${hasta}&limit=100000`);
  const filas = d.rows || [];
  const agrupado = new Map();

  for (const f of filas) {
    // Sólo ventas de verdad. Cuando Ventra no dice el tipo se deja pasar, como hace
    // analitics: es una línea vieja, no una devolución.
    if (f.operType != null && Number(f.operType) !== TIPO_VENTA) continue;
    if (!f.note || !String(f.note).includes('V-')) continue;

    const fecha = String(f.date).split('T')[0];
    const clave = `${f.note}|${f.productCode}|${fecha}|${f.customerCode || ''}`;
    const y = agrupado.get(clave);

    if (y) {
      y.TotalVendido += Number(f.quantity) || 0;
    } else {
      agrupado.set(clave, {
        Note: f.note,
        GoodID: f.productCode,
        Date: fecha,
        PartnerID: f.customerCode || null,
        Name: f.productName,
        PriceOut1: f.priceOut ?? null,
        Measure1: f.unit ?? null,
        Measure2: null,
        TotalVendido: Number(f.quantity) || 0,
      });
    }
  }

  return [...agrupado.values()];
}

/**
 * El inventario, con la forma que tenían las filas de `store` cruzadas con `objects`.
 *
 * Ventra devuelve el almacén como nombre, no como número: donde antes había `object_id`
 * se pone el propio nombre, que es lo único que el código usaba para agrupar.
 */
export async function almacen() {
  const [d, precios] = await Promise.all([
    pedir(`/axis/stock?database=${DB}`),
    preciosRecientes().catch(() => new Map()),
  ]);
  // Ver `SUCURSAL`: este filtro no sobra, Ventra devuelve todas.
  const items = (d.items || []).filter(
    (i) => String(i.branchName || '').toUpperCase() === SUCURSAL.toUpperCase(),
  );
  const filas = [];

  for (const it of items) {
    /**
     * La cantidad de CADA almacén, no el total repartido a ojo.
     *
     * `it.quantity` es la suma de todos, y `it.objects` trae el desglose real con su
     * propia `quantity`. Atribuir el total al primero de la lista pone el stock donde no
     * está: las 7.072 Parranda salían en «ALM CAMAGUEY» cuando están en «PV CAMAGUEY».
     */
    const desglose = Array.isArray(it.objects) && it.objects.length
      ? it.objects
      : [{ name: it.branchName || 'Almacén', quantity: it.quantity }];

    for (const o of desglose) {
      const stock = Number(o.quantity) || 0;

      if (stock <= 0) continue;

      filas.push({
        object_id: o.id ?? o.name,
        almacen: o.name || it.branchName || 'Almacén',
        ID: it.productCode,
        Code: it.productCode,
        Name: it.productName,
        PriceOut1: precios.get(it.productCode) ?? null,
        stock,
      });
    }
  }

  return filas.filter((f) => f.Name && f.Name !== 'ENTREGA A DOMICILIO');
}

export { VentraNoDisponible };
