/**
 * Lo que se calcula y no se guarda: cifras, nombres y barras.
 *
 * Todo aquí es puro — recibe datos y devuelve el resultado —, así que vive fuera del
 * componente y se puede leer sin seguir el estado de la pantalla.
 */

/** El mes en curso en Cuba, igual que lo calcula el servidor. */
export function mesEnCurso() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Havana',
    year: 'numeric',
    month: '2-digit',
  })
    .format(new Date())
    .slice(0, 7)
}

/**
 * El día de hoy EN CUBA, `AAAA-MM-DD`, igual que lo calcula el servidor.
 *
 * `new Date().toISOString().slice(0, 10)` es UTC: a las 20:30 de La Habana ya da
 * mañana, y una asignación hecha a esas horas se guardaba con el día siguiente —el 1
 * de mes, con el día del mes entrante— y no aparecía en la lista que se estaba mirando.
 * Con `en-CA` el formato ya ES `AAAA-MM-DD` y el huso lo resuelve el propio navegador.
 */
export function hoyEnCuba() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Havana',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

/** "2026-09" -> "Septiembre 2026". Un AAAA-MM no se lee, se descifra. */
export function nombreDelMes(mes) {
  const [a, m] = String(mes || '').split('-')
  const nombres = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
  return nombres[Number(m) - 1] ? `${nombres[Number(m) - 1]} ${a}` : mes
}

/**
 * Las iniciales del vendedor: la primera del nombre y la primera del apellido.
 *
 * Con una sola letra, ALEXANDER PADRON y ANDY ALMANZA tenían el mismo círculo, que
 * es justo lo contrario de lo que sirve una inicial.
 */
export function inicialesDe(nombre) {
  const partes = String(nombre || '')
    .replace(/^V-/, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (!partes.length) return '?'
  const primera = partes[0][0]
  const ultima = partes.length > 1 ? partes[partes.length - 1][0] : ''
  return (primera + ultima).toUpperCase()
}

/** Lo de un vendedor, sumado, para poder comparar vendedores sin leer sus filas. */
export function totalesDe(item) {
  const t = { asignado: 0, en_proceso: 0, cambiado: 0, completada: 0, vendido: 0, exceso: 0, pendiente: 0, cerrado_sin_factura: 0 }
  for (const p of item.productos) {
    for (const k in t) t[k] += p[k] || 0
  }
  return t
}

/**
 * Cómo se reparte lo asignado de un producto, en porcentaje.
 *
 * Cuatro tramos que suman lo asignado: lo que ya salió del almacén, lo que está
 * salió con factura cambiada, lo que tiene pedido sin salir, y lo que nadie ha
 * tocado. Una barra se lee de un vistazo; seis números en seis columnas de 40 px,
 * no.
 *
 * Si lo despachado pasa de lo asignado —que ocurre— la barra se mide contra lo
 * ocupado y el exceso se dice aparte con su cifra, en vez de dibujar un tramo que
 * se sale de su caja.
 */
export function tramosDe(p) {
  const asignado = p.asignado || 0
  const despachado = p.completada || 0
  const proceso = p.en_proceso || 0
  const cerrado = p.cerrado_sin_factura || 0

  /*
   * DOS excesos distintos, que antes iban en el mismo número y con la etiqueta
   * equivocada.
   *
   * `deMas` era `despachado + facturado + en proceso - asignado` y el rótulo decía
   * "Salió más de lo que se le asignó". A MAYLEN le ponía "De más 35" cuando lo que
   * había salido eran 180 de 180 clavados: esos 35 eran pedidos SIN despachar. Lo que
   * de verdad se pasó eran 22, y no se veía por ningún lado.
   *
   *   salioDeMas    lo que YA salió por encima de lo asignado. Es un hecho.
   *   pedidoDeMas   lo que se pasaría SI sale todo lo que está pedido. Es un aviso.
   */
  const salioDeMas = Math.max(0, despachado - asignado)
  const dentro = Math.min(despachado, asignado)

  /*
   * LA ESCALA DE LA BARRA SÓLO CUENTA LO QUE LA BARRA DIBUJA.
   *
   * La barra tenía cinco tramos y al dejarla en tres —despachado, lo que salió de más y
   * el hueco— se quitaron los dibujos pero NO se quitaron del divisor: seguía midiéndose
   * contra `dentro + en proceso + cerrado`. Resultado: 912 despachados de 912 asignados
   * pintaban un tercio de barra, porque el otro tercio y pico lo ocupaban dos tramos
   * invisibles. Una barra llena de verdad tiene que verse llena.
   *
   * La escala es lo asignado; si se despachó de más, crece justo lo que se pasó, que es
   * lo que hace que el tramo morado asome por el extremo.
   */
  const base = Math.max(asignado + salioDeMas, 1)
  const parte = (n) => `${(n / base) * 100}%`

  return {
    despachado: parte(dentro),
    salioDeMas: parte(salioDeMas),
    // El hueco de la barra es lo que le falta a lo asignado para estar despachado.
    libre: parte(asignado - dentro),
    /*
     * «Sin pedir» es otra cosa y por eso se calcula aparte: de lo asignado, lo que nadie
     * ha pedido todavía. Un producto puede tener la barra a medias —le falta despachar—
     * y no tener nada sin pedir, si todo lo que queda ya está pedido.
     */
    sinTocar: Math.max(0, asignado - dentro - proceso - cerrado),
    exceso: salioDeMas,
  }
}

/** El avance de un vendedor sobre lo suyo, para el número grande de su cabecera. */
export function avanceDe(item) {
  const asignadoTotal = totalesDe(item).asignado
  if (!asignadoTotal) return 0

  // Sumamos solo lo que cuenta para la meta: el mínimo entre lo despachado y lo asignado.
  // Así el "exceso" no infla el porcentaje y no hay falsos 100%.
  const completadoReal = item.productos.reduce((sum, p) => sum + Math.min(p.completada || 0, p.asignado || 0), 0)

  return Math.floor((completadoReal / asignadoTotal) * 100)
}

/**
 * El nombre del producto sin lo que se repite en todas las filas.
 *
 * Dentro de la tarjeta de un vendedor todo es CERVEZA o MALTA; escribirlo en cada
 * línea gasta el ancho que necesita lo que sí distingue una de otra.
 */
export function nombreCorto(nombre) {
  return String(nombre || '').replace(/^(CERVEZA|MALTA)\s+/, '')
}

/**
 * Nombre y primer apellido.
 *
 * "ERNESTO RODRIGUEZ CASTELLANOS" no cabe en una lista de 250 px y se cortaba en
 * "ERNESTO RODRI…", que es peor que no ponerlo: dos vendedores pueden compartir el
 * trozo visible. Con nombre y apellido se distinguen, y el completo queda en el
 * título y en la cabecera del detalle.
 */
export function nombreCortoVendedor(nombre) {
  const partes = String(nombre || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (partes.length <= 2) return partes.join(' ')
  return `${partes[0]} ${partes[1]}`
}

/** Lo que lleva vendido un vendedor, para poder ordenarlos por eso en la lista. */
export function importeDe(v) {
  return Object.values(v.productos).reduce((t, p) => t + p.total, 0)
}

const palabras = (s) =>
  String(s || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

/** El volumen de un nombre en mililitros, si lo trae: «330», «1500». */
const volumen = (ts) => ts.find((t) => /^\d{3,5}$/.test(t))

/**
 * De las líneas de pedidos que no casaron con ningún producto, las que sí parecen
 * ser de ESTE producto.
 *
 * Sirve para decir «No queda ningún pedido por despachar **pero** estas tres líneas
 * tienen tu nombre y no se pudieron asociar», que es la diferencia entre «no hay
 * nada» y «hay algo que no estoy mirando».
 *
 * Dos palabras comunes de más de dos letras, y que si las dos miden midan lo mismo:
 * «MALTA GUAJIRA 0.33L» es de «MALTA GUAJIRA 330 ML…», pero «MALTA GUAJIRA 1500»
 * no lo es, y «ARROZ RIVIERA» no es «CERVEZA PARRANDA».
 */
export function afinesDe(lineas, nombreProducto) {
  const propias = palabras(nombreProducto)
  if (propias.length < 2) return []
  return (lineas || []).filter((l) => {
    const suyas = palabras(l.producto)
    const comunes = new Set(suyas.filter((t) => t.length > 2 && propias.includes(t)))
    if (comunes.size < 2) return false
    const a = volumen(suyas)
    const b = volumen(propias)
    return !(a && b && a !== b)
  })
}
