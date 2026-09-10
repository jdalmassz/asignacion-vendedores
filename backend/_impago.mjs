import mysql from 'mysql2/promise';
const c = await mysql.createConnection({ host: 'DB_HOST_ENV', user: 'root', password: 'root', database: 'camaguey' });

// Ventas (Sign=-1, OperType=2) vs pagos por Acct
const [ventas] = await c.query(`
  SELECT o.Acct, o.GoodID, g.Name AS prod, SUM(o.Qtty) AS qty,
         SUM(o.PriceOut * o.Qtty) AS total
  FROM operations o
  LEFT JOIN goods g ON o.GoodID = g.ID
  WHERE o.Date >= '2026-09-01' AND o.Date < '2026-10-01'
    AND o.Sign = -1 AND o.OperType = 2
  GROUP BY o.Acct, o.GoodID, g.Name
`);
const [pagos] = await c.query(`
  SELECT Acct, SUM(Qtty) AS pagado
  FROM payments
  WHERE Date >= '2026-09-01' AND Date < '2026-10-01'
  GROUP BY Acct
`);
const pagoMap = {};
for (const p of pagos) pagoMap[p.Acct] = p.pagado;

let impago = 0, pagado = 0, filasLas = 0;
const porVendedor = {};
for (const v of ventas) {
  const p = pagoMap[v.Acct] || 0;
  if (p === 0 || p == null) {
    impago += v.total || 0;
    const vend = (v.prod.match(/V-/)?.[1]) || '';
    console.log(`SIN PAGO acct=${v.Acct} prod=${v.prod} qty=${v.qty} total=${v.total?.toFixed(2)}`);
  } else {
    pagado += v.total || 0;
  }
}
console.log(`\nVentas: ${ventas.length} filas | pagado=$ ${pagado.toFixed(2)} | IMPAGADO=$ ${impago.toFixed(2)}`);

await c.end();