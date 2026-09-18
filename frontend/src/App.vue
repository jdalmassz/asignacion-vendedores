<script setup>
import { ref, onMounted, onUnmounted, onBeforeUnmount, computed, nextTick, watch } from 'vue'
import axios from 'axios'
import AppIcon from './components/AppIcon.vue'

/**
 * Dónde está la API.
 *
 * Estaba escrita a mano como `http://localhost:4000/api`, que funciona en el portátil de
 * quien la escribió y en ningún otro sitio: puesto en el servidor, el navegador del
 * usuario intentaría hablar con SU propio ordenador.
 *
 * Por defecto `/api`, que es una ruta relativa: el mismo nginx que sirve la página la
 * reenvía al backend por la red interna. `VITE_API_URL` permite apuntar a otro sitio en
 * desarrollo — Vite la sustituye al construir, no al arrancar.
 */
const API_URL = import.meta.env.VITE_API_URL || '/api'

// Estado de los datos
const vendedores = ref([])
const resumen = ref([])
const ventas = ref([])
const asignaciones = ref([])
const almacen = ref([])
const totalesAlmacen = ref({ productos: 0, unidades: 0, valor: 0 })
const loading = ref(false)
const error = ref(null)

// Vendedor seleccionado para filtrar
const vendedorSeleccionado = ref('')

// Filtro de fecha para ventas
const filtroPreset = ref('mes') // 'hoy', 'mes', 'rango'
/**
 * Las dos secciones, en una lista.
 *
 * En una lista y no escritas dos veces en el HTML porque el deslizador necesita saber
 * cuál va antes y cuál después para las flechas. Añadir una tercera es añadirla aquí.
 */
const SECCIONES = [
  { id: 'resumen', titulo: 'Resumen', icono: 'clipboard' },
  { id: 'asignaciones', titulo: 'Asignaciones', icono: 'edit' },
  { id: 'almacen', titulo: 'Almacén', icono: 'warehouse' },
  { id: 'ventas', titulo: 'Ventas', icono: 'cart' },
]

const seccionActiva = ref('resumen')

const indiceSeccion = computed(() => SECCIONES.findIndex((s) => s.id === seccionActiva.value))

/**
 * Cuántas cosas hay en cada sección, para el contador de la pestaña.
 *
 * `null` cuando no tiene sentido contar: el resumen es una lectura, no una lista de
 * cosas que se acumulen.
 */
function cuentaSeccion(id) {
  /*
   * `?.length ?? 0` en vez de `.length`.
   *
   * Este contador se pinta en la cabecera, o sea en CADA render. Si una de las tres
   * listas llega `undefined` -una respuesta que no trae lo que se espera, la API a
   * medio desplegar- aquí petaba el render y con él la pantalla entera: no se veía la
   * sección rota, se veía la página en blanco. Un contador no puede tumbar la
   * aplicación.
   */
  if (id === 'asignaciones') return asignaciones.value?.length ?? 0
  if (id === 'almacen') return almacen.value?.length ?? 0
  if (id === 'ventas') return ventas.value?.length ?? 0

  return null
}

const pistaSecciones = ref(null)

/**
 * Traer la sección activa a la vista del deslizador.
 *
 * En el móvil la pista sólo enseña una sección a la vez. Sin esto la pista se queda
 * donde estaba: se entraba en Ventas y arriba seguía poniendo "Resumen" con el punto
 * de la cuarta encendido, o sea el rótulo diciendo una cosa y el contenido otra.
 */
function centrarSeccion() {
  nextTick(() => {
    const el = pistaSecciones.value?.querySelector('button.active')
    el?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  })
}

/** Pasa a la sección de al lado. No da la vuelta: en el extremo la flecha se apaga. */
function cambiarSeccion(paso) {
  const i = indiceSeccion.value + paso

  if (i >= 0 && i < SECCIONES.length) seccionActiva.value = SECCIONES[i].id
}
const filtroFechaDesde = ref('')
const filtroFechaHasta = ref('')

const fechaHoy = (() => {
  const f = new Date()
  return `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`
})()

/**
 * Paginación de la lista de asignaciones.
 *
 * Hoy son catorce, pero son diez vendedores por un producto cada vez que se reparte:
 * en un mes de trabajo normal esto pasa de cien filas y la página se convierte en un
 * scroll infinito donde no se encuentra nada.
 */
const POR_PAGINA = [25, 50, 100, 0]
const porPagina = ref(25)
const pagina = ref(1)

const totalPaginas = computed(() => {
  if (porPagina.value === 0) return 1
  return Math.max(Math.ceil((asignaciones.value?.length || 0) / porPagina.value), 1)
})

/* La página no puede quedarse fuera de rango cuando se borran filas: si estás en la 4
   y borras hasta que sólo quedan 3 páginas, sin esto verías una tabla vacía. */
const paginaActual = computed(() => Math.min(pagina.value, totalPaginas.value))

const asignacionesVisibles = computed(() => {
  const todas = asignaciones.value || []
  if (porPagina.value === 0) return todas
  const desde = (paginaActual.value - 1) * porPagina.value
  return todas.slice(desde, desde + porPagina.value)
})

/** El número de fila real, no el de la página: en la 2 la primera es la 26. */
const primeraDeLaPagina = computed(() =>
  porPagina.value === 0 ? 0 : (paginaActual.value - 1) * porPagina.value
)

watch(porPagina, () => { pagina.value = 1 })

// Formulario de nueva asignación
const nuevaAsignacion = ref({
  producto: '',
  cantidad: 0,
  fecha: new Date().toISOString().split('T')[0]
})
const vendedoresSeleccionados = ref([])
const showForm = ref(false)
const showCalendar = ref(false)
const showCalRango = ref(false)
const calObjetivo = ref('desde')
const calMonth = ref(new Date().getMonth())
const calYear = ref(new Date().getFullYear())
const rangoTmpDesde = ref('')
const rangoTmpHasta = ref('')

function toggleTodosVendedores() {
  if (vendedoresSeleccionados.value.length === vendedores.value.length) {
    vendedoresSeleccionados.value = []
  } else {
    vendedoresSeleccionados.value = [...vendedores.value]
  }
}

const calMonthName = computed(() => {
  const names = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']
  return names[calMonth.value]
})

const calDays = computed(() => {
  const first = new Date(calYear.value, calMonth.value, 1).getDay()
  const last = new Date(calYear.value, calMonth.value + 1, 0).getDate()
  const days = []
  for (let i = 0; i < first; i++) days.push(null)
  for (let i = 1; i <= last; i++) days.push(i)
  return days
})

function selectCalendarDay(day) {
  if (!day) return
  const m = String(calMonth.value + 1).padStart(2, '0')
  const d = String(day).padStart(2, '0')
  nuevaAsignacion.value.fecha = `${calYear.value}-${m}-${d}`
  showCalendar.value = false
}

function abrirCalAsignacion() {
  const f = nuevaAsignacion.value.fecha
  if (f) {
    const d = new Date(f + 'T00:00:00')
    calMonth.value = d.getMonth()
    calYear.value = d.getFullYear()
  }
  showCalendar.value = !showCalendar.value
}

function abrirCalRango() {
  if (!showCalRango.value) {
    if (filtroFechaDesde.value) {
      rangoTmpDesde.value = filtroFechaDesde.value
      const f = new Date(filtroFechaDesde.value)
      calYear.value = f.getFullYear()
      calMonth.value = f.getMonth()
      calObjetivo.value = filtroFechaHasta.value ? 'desde' : 'hasta'
    } else {
      rangoTmpDesde.value = ''
      calObjetivo.value = 'desde'
      const hoy = new Date()
      calYear.value = hoy.getFullYear()
      calMonth.value = hoy.getMonth()
    }
    rangoTmpHasta.value = filtroFechaHasta.value
    if (!rangoTmpDesde.value && !rangoTmpHasta.value) calObjetivo.value = 'desde'
  }
  showCalRango.value = !showCalRango.value
}

function seleccionarDiaRango(day) {
  if (!day) return
  const m = String(calMonth.value + 1).padStart(2, '0')
  const d = String(day).padStart(2, '0')
  const fecha = `${calYear.value}-${m}-${d}`
  if (calObjetivo.value === 'desde') {
    rangoTmpDesde.value = fecha
    calObjetivo.value = 'hasta'
  } else {
    let desde = rangoTmpDesde.value
    let hasta = fecha
    if (desde > fecha) {
      desde = fecha
      hasta = rangoTmpDesde.value
    }
    filtroFechaDesde.value = desde
    filtroFechaHasta.value = hasta
    showCalRango.value = false
  }
}

function esDiaEnRango(fecha) {
  if (!rangoTmpDesde.value && !rangoTmpHasta.value) return false
  if (!rangoTmpHasta.value) return fecha === rangoTmpDesde.value
  return fecha >= rangoTmpDesde.value && fecha <= rangoTmpHasta.value
}

function prevMonth() {
  if (calMonth.value === 0) { calMonth.value = 11; calYear.value-- }
  else calMonth.value--
}

function nextMonth() {
  if (calMonth.value === 11) { calMonth.value = 0; calYear.value++ }
  else calMonth.value++
}

/**
 * El mes que se está mirando, calculado — no escrito a mano.
 *
 * Estaba puesto `'Septiembre 2026'` como texto fijo: el 1 de octubre la cabecera habría
 * seguido diciendo septiembre mientras los datos eran de octubre, y nadie lo habría
 * notado hasta cuadrar algo. Es el mismo fallo que tenía el servidor y que ya se arregló
 * allí.
 *
 * Sale de `mesEnCurso()`, que va en hora de Cuba, así que cambia cuando cambia el mes
 * aquí y no cuando cambia en Londres.
 */
const mesActual = computed(() => nombreDelMes(mesEnCurso()))

onMounted(async () => {
  document.addEventListener('click', (e) => {
    if ((showCalendar.value || showCalRango.value) && !e.target.closest('.calendar-group')) {
      showCalendar.value = false
      showCalRango.value = false
    }
  })
  await cargarDatos()
  escucharCambios()
})

onUnmounted(() => {
  dejarDeEscuchar()
})

/**
 * Los cambios llegan solos; esta pantalla no pregunta nada.
 *
 * Antes había un `setInterval` que pedía el panel entero cada 30 segundos y lo comparaba
 * consigo mismo. Con tres pestañas abiertas eran seis consultas por minuto a PEDIDO y a
 * Ventra por la VPN para recibir, casi siempre, lo mismo. Y encima no servía: avisaba de
 * que había cambios, pero había que recargar para verlos.
 *
 * Ahora el servidor mira una vez para todos y avisa por `/api/eventos`. El navegador abre
 * esa conexión y espera. `EventSource` reconecta solo si se cae la red o si el backend se
 * redespliega, así que no hay que vigilar nada.
 */
let fuente = null


function dejarDeEscuchar() {
  if (fuente) {
    fuente.close()
    fuente = null
  }
}

function escucharCambios() {
  dejarDeEscuchar()

  try {
    fuente = new EventSource(`${API_URL}/eventos`)
  } catch (e) {
    // Sin eventos la pantalla sigue sirviendo: se ve lo que había al abrirla y el botón
    // de recargar está ahí. Peor sería quedarse en blanco.
    console.warn('No se pudieron escuchar los cambios:', e)

    return
  }

  fuente.onmessage = (e) => {
    let dato = {}

    try {
      dato = JSON.parse(e.data)
    } catch {
      return
    }

    if (dato.que === 'conectado') return

    /*
     * Se recarga, no se avisa.
     *
     * El aviso de «hay cambios» obligaba a pulsar algo para verlos, que es lo mismo que
     * recargar a mano. Si el servidor dice que cambió, se trae y se pinta: para eso está
     * la transición, para que el cambio se vea llegar en vez de aparecer de golpe.
     */
    void cargarEstado()

    if (dato.que === 'asignaciones') {
      void cargarAsignaciones()
      void cargarResumen()
    } else {
      void cargarDatos()
    }
  }

  // `EventSource` reintenta solo; esto es sólo para que quede en la consola si pasa mucho.
  fuente.onerror = () => {
    if (fuente?.readyState === EventSource.CLOSED) console.warn('Conexión de eventos cerrada')
  }
}

const cargandoAlmacen = ref(false)

/** Cuándo se calculó lo que se está viendo, para poder decirlo. */
const actualizado = ref(null)

async function cargarEstado() {
  try {
    const r = await axios.get(`${API_URL}/eventos/estado`)
    const fechas = Object.values(r.data?.calculado || {}).filter(Boolean)

    // La más vieja de las tres: es la que manda para decir «esto es de hace…».
    actualizado.value = fechas.length ? fechas.sort()[0] : null
  } catch {
    actualizado.value = null
  }
}

/** «hace 2 minutos». Se recalcula solo porque `ahora` avanza cada 30 segundos. */
const ahora = ref(Date.now())

setInterval(() => { ahora.value = Date.now() }, 30000)

const haceCuanto = computed(() => {
  if (!actualizado.value) return null

  const m = Math.round((ahora.value - new Date(actualizado.value).getTime()) / 60000)

  if (m < 1) return 'ahora mismo'
  if (m === 1) return 'hace 1 minuto'
  if (m < 60) return `hace ${m} minutos`

  const h = Math.round(m / 60)

  return h === 1 ? 'hace 1 hora' : `hace ${h} horas`
})

async function cargarDatos() {
  loading.value = true
  error.value = null
  try {
    await axios.get(`${API_URL}/init-db`)

    /*
     * El almacén NO bloquea la pantalla.
     *
     * En frío tarda dieciséis segundos —son 90 días de ventas de Ventra por la VPN para
     * sacar los precios, que Ventra no da en la ficha del producto—. Pidiéndolo a la vez
     * que lo demás, la pantalla entera se quedaba esperando por una pestaña que quizá ni
     * se abre. Ahora entra por su cuenta y aparece cuando llega.
     */
    const [rDashboard, resVendedores] = await Promise.all([
      axios.get(`${API_URL}/dashboard`),
      axios.get(`${API_URL}/vendedores`)
    ])
    void cargarAlmacen()
    resumen.value = rDashboard.data?.resumen || []
    ventas.value = rDashboard.data?.ventas || []
    /*
     * El panel siempre trae las del mes EN CURSO. Si estás mirando otro mes, esto te
     * cambiaría la lista debajo de las manos —y con el selector diciendo "Agosto"—, así
     * que en ese caso se vuelve a pedir el mes que elegiste.
     */
    if (!mesElegido.value || mesElegido.value === mesEnCurso()) {
      asignaciones.value = rDashboard.data?.asignaciones || []
    } else {
      await cargarAsignaciones()
    }
    vendedores.value = resVendedores.data?.vendedores || []
    cargarMeses()
    void cargarEstado()

    // Seleccionar primer vendedor por defecto en ventas
    const uniqueVendedores = [...new Set(ventas.value.map(v => v.vendedor))]
    if (uniqueVendedores.length > 0) {
      vendedorSeleccionado.value = uniqueVendedores[0]
    }
  } catch (e) {
    error.value = 'Error al cargar datos: ' + (e.message || e)
    console.error(e)
  } finally {
    loading.value = false
  }
}

/**
 * Qué mes enseña la lista de asignaciones.
 *
 * Vacío = el que corre. Hasta ahora era lo ÚNICO que se podía ver: el 1 de octubre las
 * catorce de septiembre siguen en la base pero desaparecen de la pantalla, sin forma de
 * llegar a ellas. La API ya aceptaba `?mes=`; lo que faltaba era pedirlo.
 *
 * El resumen no cambia con esto y es a propósito: mide cómo va lo asignado ESTE mes
 * contra lo que se está despachando ahora. Mirar septiembre en la lista no debe
 * reescribir el resumen de octubre.
 */
/** El mes en curso en Cuba, igual que lo calcula el servidor. */
function mesEnCurso() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Havana',
    year: 'numeric',
    month: '2-digit',
  }).format(new Date()).slice(0, 7)
}

const mesElegido = ref('')
const mesesDisponibles = ref([])

async function cargarMeses() {
  try {
    const res = await axios.get(`${API_URL}/asignaciones/meses`)
    mesesDisponibles.value = res.data.meses || []
    if (!mesElegido.value) mesElegido.value = res.data.actual
  } catch (e) {
    console.error('Error al cargar los meses:', e)
  }
}

/** "2026-09" -> "Septiembre 2026". Un AAAA-MM no se lee, se descifra. */
function nombreDelMes(mes) {
  const [a, m] = String(mes || '').split('-')
  const nombres = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']
  return nombres[Number(m) - 1] ? `${nombres[Number(m) - 1]} ${a}` : mes
}

async function cargarAsignaciones() {
  try {
    const mes = mesElegido.value ? `?mes=${mesElegido.value}` : ''
    const res = await axios.get(`${API_URL}/asignaciones${mes}`)
    // `|| []` y no a secas: si la respuesta no trae la lista -un proxy que devuelve
    // otra cosa, la API a medio desplegar- esto dejaba `asignaciones` en `undefined` y
    // el contador de la pestaña reventaba la pantalla ENTERA, no sólo esta sección.
    asignaciones.value = res.data?.asignaciones || []
    pagina.value = 1
  } catch (e) {
    console.error('Error al cargar asignaciones:', e)
  }
}

watch(mesElegido, cargarAsignaciones)

async function cargarAlmacen() {
  cargandoAlmacen.value = true
  try {
    const res = await axios.get(`${API_URL}/almacen`)

    almacen.value = res.data?.productos || []
    totalesAlmacen.value = res.data?.totales || { productos: 0, unidades: 0, valor: 0 }
  } catch (e) {
    console.error('Error al cargar almacén:', e)
  } finally {
    cargandoAlmacen.value = false
  }
}

async function cargarVentas() {
  try {
    const resVentas = await axios.get(`${API_URL}/ventas`)
    ventas.value = resVentas.data.ventas
  } catch (e) {
    console.error('Error al cargar ventas:', e)
  }
}

async function cargarResumen() {
  try {
    const resResumen = await axios.get(`${API_URL}/resumen`)
    resumen.value = resResumen.data.resumen
  } catch (e) {
    console.error('Error al cargar resumen:', e)
  }
}

async function crearAsignacion() {
  if (vendedoresSeleccionados.value.length === 0 || !nuevaAsignacion.value.producto || !nuevaAsignacion.value.cantidad) {
    alert('Por favor seleccione al menos un vendedor, un producto y una cantidad')
    return
  }

  const producto = productosFiltrados.value.find(p => p.id == nuevaAsignacion.value.producto)
  if (!producto) return

  try {
    let aviso = null
    for (const vendedor of vendedoresSeleccionados.value) {
      const r = await axios.post(`${API_URL}/asignaciones`, {
        vendedor,
        producto_id: nuevaAsignacion.value.producto,
        producto_nombre: producto.name,
        cantidad: parseFloat(nuevaAsignacion.value.cantidad),
        fecha: nuevaAsignacion.value.fecha
      })
      // El servidor avisa si el producto no casa con ninguno de Ventra: la asignación
      // se guarda pero NO va a salir en el resumen. Es el mismo aviso para todos los
      // vendedores del lote, así que con enseñarlo una vez basta.
      if (r.data?.aviso) aviso = r.data.aviso
    }

    vendedoresSeleccionados.value = []
    nuevaAsignacion.value = { producto: '', cantidad: 0, fecha: new Date().toISOString().split('T')[0] }
    showForm.value = false

    await cargarResumen()
    await cargarAsignaciones()
    if (aviso) alert(aviso)
  } catch (e) {
    alert('Error al crear asignación: ' + (e.response?.data?.error || e.message))
  }
}

async function eliminarAsignacion(id) {
  if (!confirm('¿Estás seguro de eliminar esta asignación?')) return

  try {
    await axios.delete(`${API_URL}/asignaciones/${id}`)
    await cargarResumen()
    await cargarAsignaciones()
  } catch (e) {
    alert('Error al eliminar asignación: ' + (e.response?.data?.error || e.message))
  }
}

// Agrupar resumen por vendedor
const resumenPorVendedor = computed(() => {
  const grouped = {}
  const vendidoMap = {}
  for (const v of ventas.value) {
    const key = `${v.vendedor}|${v.producto_id}`
    vendidoMap[key] = (vendidoMap[key] || 0) + (v.cantidad || 0)
  }
  for (const item of resumen.value) {
    if (!grouped[item.vendedor]) {
      grouped[item.vendedor] = {
        vendedor: item.vendedor,
        productos: {}
      }
    }
    grouped[item.vendedor].productos[item.producto_id] = {
      producto_id: item.producto_id,
      producto_nombre: item.producto_nombre,
      asignado: item.asignado,
      en_proceso: item.en_proceso,
      // De lo despachado, lo que se facturó distinto de lo que se pidió.
      pedido: item.pedido ?? 0,
      cerrado_sin_factura: item.cerrado_sin_factura ?? 0,
      cambiado: item.cambiado ?? 0,
      sin_pedido: item.sin_pedido ?? 0,
      exceso: item.exceso ?? 0,
      completada: item.completada,
      pendiente: item.pendiente,
      vendido: vendidoMap[`${item.vendedor}|${item.good_id}`] || 0
    }
  }
  return Object.values(grouped)
    .sort((a, b) => a.vendedor.localeCompare(b.vendedor))
    .map(g => ({
      ...g,
      productos: Object.values(g.productos).sort((a, b) => (a.producto_nombre || '').localeCompare(b.producto_nombre || ''))
    }))
})

/**
 * Las iniciales del vendedor: la primera del nombre y la primera del apellido.
 *
 * Con una sola letra, ALEXANDER PADRON y ANDY ALMANZA tenían el mismo círculo, que
 * es justo lo contrario de lo que sirve una inicial.
 */
function inicialesDe(nombre) {
  const partes = String(nombre || '').replace(/^V-/, '').trim().split(/\s+/).filter(Boolean)
  if (!partes.length) return '?'
  const primera = partes[0][0]
  const ultima = partes.length > 1 ? partes[partes.length - 1][0] : ''
  return (primera + ultima).toUpperCase()
}

/** Lo de un vendedor, sumado, para poder comparar vendedores sin leer sus filas. */
function totalesDe(item) {
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
function tramosDe(p) {
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
    exceso: salioDeMas
  }
}

/** El avance de un vendedor sobre lo suyo, para el número grande de su cabecera. */
function avanceDe(item) {
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
function nombreCorto(nombre) {
  return String(nombre || '').replace(/^(CERVEZA|MALTA)\s+/, '')
}

// Agrupar ventas por vendedor
const ventasPorVendedor = computed(() => {
  const grouped = {}
  for (const item of ventas.value) {
    if (!grouped[item.vendedor]) {
      grouped[item.vendedor] = {
        vendedor: item.vendedor,
        productos: {}
      }
    }
    const key = item.producto_nombre
    if (!grouped[item.vendedor].productos[key]) {
      grouped[item.vendedor].productos[key] = {
        producto_nombre: item.producto_nombre,
        precio: item.precio || 0,
        vendido: 0,
        total: 0
      }
    }
    grouped[item.vendedor].productos[key].vendido += item.cantidad
    grouped[item.vendedor].productos[key].total += item.total
  }
  return Object.values(grouped)
})

// Totales generales
const totalesGenerales = computed(() => {
  let totalAsignado = 0
  let totalEnProceso = 0
  let totalCobrado = 0
  let totalCompletada = 0
  let totalPendiente = 0
  for (const item of resumen.value) {
    totalAsignado += item.asignado
    totalEnProceso += item.en_proceso
    totalCobrado += item.cobrado || 0
    totalCompletada += item.completada
    totalPendiente += item.pendiente || 0
  }
  return {
    asignado: totalAsignado,
    en_proceso: totalEnProceso,
    cobrado: totalCobrado,
    completada: totalCompletada,
    pendiente: totalPendiente
  }
})

// Total de ventas
const totalVentas = computed(() => {
  let total = 0
  for (const item of ventas.value) {
    total += item.total || 0
  }
  return total
})

// Ventas filtradas por vendedor seleccionado
const ventasFiltradas = computed(() => {
  if (!vendedorSeleccionado.value) {
    return ventasPorVendedorFiltrado.value
  }
  return ventasPorVendedorFiltrado.value.filter(v => v.vendedor === vendedorSeleccionado.value)
})

// Ventas filtradas por fecha
const ventasFiltradasPorFecha = computed(() => {
  if (filtroPreset.value === 'hoy') {
    return ventas.value.filter(v => v.fecha === fechaHoy)
  }
  if (filtroPreset.value === 'rango') {
    if (!filtroFechaDesde.value && !filtroFechaHasta.value) return ventas.value
    return ventas.value.filter(v => {
      if (!v.fecha) return false
      const f = v.fecha
      const desde = filtroFechaDesde.value
      const hasta = filtroFechaHasta.value
      if (desde && hasta) return f >= desde && f <= hasta
      if (desde) return f >= desde
      if (hasta) return f <= hasta
      return true
    })
  }
  return ventas.value.filter(v => v.fecha && v.fecha.startsWith('2026-09'))
})

// Agrupar ventas por vendedor filtradas por fecha
const ventasPorVendedorFiltrado = computed(() => {
  const grouped = {}
  for (const item of ventasFiltradasPorFecha.value) {
    if (!grouped[item.vendedor]) {
      grouped[item.vendedor] = {
        vendedor: item.vendedor,
        productos: {},
        clientes: new Set()
      }
    }
    if (item.cliente) grouped[item.vendedor].clientes.add(item.cliente)
    const key = item.producto_nombre
    if (!grouped[item.vendedor].productos[key]) {
      grouped[item.vendedor].productos[key] = {
        producto_nombre: item.producto_nombre,
        precio: item.precio || 0,
        vendido: 0,
        total: 0,
        clientes: new Set()
      }
    }
    grouped[item.vendedor].productos[key].vendido += item.cantidad
    grouped[item.vendedor].productos[key].total += item.total
    if (item.cliente) grouped[item.vendedor].productos[key].clientes.add(item.cliente)
  }
  return Object.values(grouped)
    .sort((a, b) => a.vendedor.localeCompare(b.vendedor))
    .map(g => ({
      ...g,
      clientes: g.clientes.size,
      productos: Object.values(g.productos)
        .map(p => ({ ...p, clientes: p.clientes.size }))
        .sort((a, b) => a.producto_nombre.localeCompare(b.producto_nombre))
    }))
})

watch(seccionActiva, centrarSeccion)

// Matriz ventas "Todos": productos por fila, vendedores por columna
const matrizVentasTodos = computed(() => {
  const vendedores = ventasPorVendedorFiltrado.value
  const productosMap = {}
  const clientesGlobales = {}
  for (const item of ventasFiltradasPorFecha.value) {
    const key = item.producto_nombre
    if (!clientesGlobales[key]) clientesGlobales[key] = new Set()
    if (item.cliente) clientesGlobales[key].add(item.cliente)
  }
  for (const [key, setClientes] of Object.entries(clientesGlobales)) {
    if (!productosMap[key]) {
      productosMap[key] = {
        producto_nombre: key,
        porVendedor: {},
        cantidadTotal: 0,
        totalTotal: 0,
        clientes: setClientes.size
      }
    }
  }
  for (const v of vendedores) {
    for (const p of v.productos) {
      productosMap[p.producto_nombre].porVendedor[v.vendedor] = { vendido: p.vendido, total: p.total, clientes: p.clientes }
      productosMap[p.producto_nombre].cantidadTotal += p.vendido
      productosMap[p.producto_nombre].totalTotal += p.total
    }
  }
  return {
    vendedores: vendedores.map(v => v.vendedor),
    filas: Object.values(productosMap).sort((a, b) => a.producto_nombre.localeCompare(b.producto_nombre))
  }
})

/**
 * Nombre y primer apellido.
 *
 * "ERNESTO RODRIGUEZ CASTELLANOS" no cabe en una lista de 250 px y se cortaba en
 * "ERNESTO RODRI…", que es peor que no ponerlo: dos vendedores pueden compartir el
 * trozo visible. Con nombre y apellido se distinguen, y el completo queda en el
 * título y en la cabecera del detalle.
 */
function nombreCortoVendedor(nombre) {
  const partes = String(nombre || '').trim().split(/\s+/).filter(Boolean)
  if (partes.length <= 2) return partes.join(' ')
  return `${partes[0]} ${partes[1]}`
}

/** Lo que lleva vendido un vendedor, para poder ordenarlos por eso en la lista. */
function importeDe(v) {
  return Object.values(v.productos).reduce((t, p) => t + p.total, 0)
}

/**
 * Los vendedores de la lista, de más a menos vendido.
 *
 * Por orden alfabético el primero de la lista no dice nada; por importe, la lista
 * misma es el dato: quién vende y quién no se ve sin abrir a nadie.
 */
const vendedoresPorImporte = computed(() =>
  [...ventasPorVendedorFiltrado.value].sort((a, b) => importeDe(b) - importeDe(a))
)

/** La suma de todos, para la fila "Todos" de la lista. */
const totalTodosVendedores = computed(() =>
  ventasPorVendedorFiltrado.value.reduce((t, v) => t + importeDe(v), 0)
)

// Total de ventas filtradas
const totalVentasFiltrado = computed(() => {
  let total = 0
  for (const item of ventasPorVendedorFiltrado.value) {
    if (vendedorSeleccionado.value && item.vendedor !== vendedorSeleccionado.value) continue
    total += Object.values(item.productos).reduce((s, p) => s + p.total, 0)
  }
  return total
})

const totalVentasUnidades = computed(() => {
  let total = 0
  for (const item of ventasPorVendedorFiltrado.value) {
    if (vendedorSeleccionado.value && item.vendedor !== vendedorSeleccionado.value) continue
    total += Object.values(item.productos).reduce((s, p) => s + p.vendido, 0)
  }
  return total
})

function totalPorVendedorEnMatriz(vendedor) {
  const v = ventasPorVendedorFiltrado.value.find(x => x.vendedor === vendedor)
  if (!v) return 0
  return Object.values(v.productos).reduce((s, p) => s + p.vendido, 0)
}

const totalClientesMatriz = computed(() => {
  const set = new Set()
  for (const item of ventasFiltradasPorFecha.value) {
    if (item.cliente) set.add(item.cliente)
  }
  return set.size
})

// Matriz de stock por producto y almacén
const matrizAlmacen = computed(() => {
  const productos = {}
  for (const alm of almacen.value) {
    for (const p of alm.productos) {
      if (!productos[p.producto_id]) {
        productos[p.producto_id] = {
          producto_id: p.producto_id,
          nombre: p.nombre,
          precio: p.precio,
          // De cuándo es el precio: sin esto la matriz perdía el dato por el camino y
          // la columna volvía a no poder distinguir un precio de hoy de uno de 2025.
          precio_fecha: p.precio_fecha || null,
          precio_viejo: !!p.precio_viejo,
          stock: 0,
          porAlmacen: {},
        }
      }
      productos[p.producto_id].porAlmacen[alm.almacen] = p.stock
      productos[p.producto_id].stock += p.stock
    }
  }
  return {
    productos: Object.values(productos).sort((a, b) => a.nombre.localeCompare(b.nombre))
  }
})

// Filtrar solo los productos disponibles en camaguey (sin contar FLORIDA, es otra sucursal)
const productosFiltrados = computed(() => {
  return matrizAlmacen.value.productos
    .map(p => ({
      id: p.producto_id,
      name: p.nombre,
      stock: Object.entries(p.porAlmacen).reduce((s, [k, v]) => k === 'FLORIDA' ? s : s + v, 0)
    }))
    .filter(p => p.stock > 0)
})

// Detalle de pedidos en proceso
const detalleProceso = ref([])
const filaExpandida = ref(null)
/** De qué vendedor y producto es el detalle que está abierto. */
const detalleDe = ref(null)
const loadingDetalle = ref(false)
/** Qué falló al traer el detalle, para poder decirlo y ofrecer reintentar. */
const errorDetalle = ref(null)

/**
 * Abre el detalle de una fila.
 *
 * El detalle sale FUERA de la tarjeta: en escritorio como ventana, en móvil como
 * cajón que sube desde abajo. Cuando se abría dentro, la tarjeta crecía y con ella
 * toda la fila de la rejilla, así que abrir un producto dejaba dos huecos enormes a
 * los lados y empujaba hacia abajo a los vendedores siguientes. Ver un pedido no
 * puede mover de sitio lo demás.
 */
async function toggleDetalle(vendedor, producto_id, producto_nombre, prod = null) {
  const key = `${vendedor}|${producto_id}`
  if (filaExpandida.value === key) {
    filaExpandida.value = null
    return
  }
  filaExpandida.value = key
  detalleDe.value = { vendedor, producto_id, producto_nombre, prod }
  // Cada producto empieza por su primera página, no por donde se quedó el anterior.
  paginaDetalle.value = 1
  await traerDetalle()
}

/**
 * Trae los pedidos sin despachar.
 *
 * Dos cosas que estaban mal y se notaban en la misma pantalla:
 *
 * 1. Sin tiempo límite. Si la respuesta se corta a medias -pasa al redesplegar el
 *    backend, mientras el contenedor viejo se cambia por el nuevo- la petición se
 *    queda colgada para siempre y el cartel de "Cargando…" no se va nunca. Con un
 *    tope, a los 20 segundos se rinde y se puede reintentar.
 *
 * 2. Se pedía sólo si la lista estaba vacía, o sea UNA vez por sesión. Quien dejara
 *    la pestaña abierta toda la mañana seguía viendo los pedidos de las nueve. El
 *    servidor ya guarda su propia copia un minuto, así que volver a pedirlo pasado
 *    ese minuto no le cuesta nada.
 */
const DETALLE_FRESCO_MS = 60 * 1000
let detalleTraidoEn = 0

async function traerDetalle(forzar = false) {
  const viejo = Date.now() - detalleTraidoEn > DETALLE_FRESCO_MS
  if (!forzar && detalleProceso.value.length > 0 && !viejo) return

  loadingDetalle.value = true
  errorDetalle.value = null
  try {
    const res = await axios.get(`${API_URL}/detalle-proceso`, { timeout: 20000 })
    detalleProceso.value = res.data.detalle || []
    detalleTraidoEn = Date.now()
  } catch (e) {
    console.error('Error cargando detalle:', e)
    // Se dice qué pasó y se deja reintentar: un cartel eterno no informa de nada.
    errorDetalle.value =
      e.code === 'ECONNABORTED'
        ? 'El servidor tardó demasiado en responder.'
        : 'No se pudo cargar el detalle.'
  } finally {
    loadingDetalle.value = false
  }
}

function pedidosParaFila(vendedor, producto_id) {
  const entry = detalleProceso.value.find(d => d.vendedor === vendedor && d.producto_id === producto_id)
  return entry ? entry.pedidos : []
}

function esFilaExpandida(vendedor, producto_id) {
  return filaExpandida.value === `${vendedor}|${producto_id}`
}

/**
 * Elegir vendedor.
 *
 * Ya no hace falta traer nada a la vista: en pantalla ancha los diez están en la
 * lista, y en estrecha el desplegable lo abre el propio teléfono.
 */
function elegirVendedor(nombre) {
  vendedorSeleccionado.value = nombre
}

/**
 * La lista de pedidos del detalle, paginada.
 *
 * Un producto con muchos pedidos sin despachar hace una lista que no se acaba: ALEXANDER
 * tenía nueve, pero con un mes cargado son decenas y la ventana se convierte en un
 * scroll sin fondo. Diez por página, que es lo que cabe sin tener que arrastrar.
 */
const POR_PAGINA_DETALLE = 10
const paginaDetalle = ref(1)

const pedidosDelDetalle = computed(() =>
  detalleDe.value ? pedidosParaFila(detalleDe.value.vendedor, detalleDe.value.producto_id) : []
)

const paginasDetalle = computed(() =>
  Math.max(Math.ceil(pedidosDelDetalle.value.length / POR_PAGINA_DETALLE), 1)
)

/* Si se borra o cambia la lista, la página no puede quedarse fuera de rango. */
const paginaDetalleActual = computed(() => Math.min(paginaDetalle.value, paginasDetalle.value))

const pedidosVisibles = computed(() => {
  const desde = (paginaDetalleActual.value - 1) * POR_PAGINA_DETALLE

  return pedidosDelDetalle.value.slice(desde, desde + POR_PAGINA_DETALLE)
})

function cerrarDetalle() {
  filaExpandida.value = null
}

/**
 * Con el cajón abierto, la página de detrás no se mueve.
 *
 * Sin esto, al arrastrar dentro del cajón el dedo acaba moviendo la página de debajo:
 * el cajón se queda quieto y el fondo se va, que es exactamente la sensación de que
 * "no sale" o de que está roto. Se guarda lo que hubiera puesto antes en vez de dar
 * por hecho que era `visible`.
 */
let desplazamientoAnterior = ''

watch([filaExpandida, showForm], ([detalle, form]) => {
  const abierto = detalle || form
  if (abierto) {
    desplazamientoAnterior = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  } else {
    document.body.style.overflow = desplazamientoAnterior
  }
})

onBeforeUnmount(() => {
  document.body.style.overflow = desplazamientoAnterior
})

/**
 * Escape cierra.
 *
 * Es lo primero que prueba cualquiera con una ventana abierta delante, y si no
 * responde parece que se ha quedado colgada.
 */
function teclaDetalle(e) {
  if (e.key !== 'Escape') return
  if (filaExpandida.value) cerrarDetalle()
  else if (showForm.value) showForm.value = false
}

onMounted(() => window.addEventListener('keydown', teclaDetalle))
onBeforeUnmount(() => window.removeEventListener('keydown', teclaDetalle))
</script>

<template>
  <div class="app">
    <!-- Header -->
    <header class="app-header">
      <div class="header-content">
        <div class="header-title">
          <span class="logo"><AppIcon name="box" :size="28" /></span>
          <div>
            <h1>Asignación de Productos a Vendedores</h1>
            <p class="subtitle">{{ mesActual }}</p>
          </div>
        </div>
        <div class="header-actions">
          <button @click="showForm = !showForm" class="btn btn-primary btn-lg">
            <span v-if="!showForm"><AppIcon name="plus" :size="16" /> Nueva Asignación</span>
            <span v-else><AppIcon name="x" :size="16" /> Cancelar</span>
          </button>
          <!--
            La frescura va PEGADA al botón de actualizar, en una sola pieza.
            Suelta entre los dos botones quedaba apretada y sin alinear, como si se
            hubiera caído ahí. Aquí se lee como lo que es: el estado de ese botón.
          -->
          <span v-if="haceCuanto" class="frescura" :title="`Calculado el ${actualizado}`">
            <span class="frescura-punto" aria-hidden="true"></span>
            {{ haceCuanto }}
          </span>
          <button class="btn btn-ghost ref-btn" @click="cargarDatos" title="Actualizar datos">
            <AppIcon name="refresh" :size="16" />
          </button>
        </div>
      </div>
    </header>

    <!-- Loading -->
    <div v-if="loading" class="loading-overlay">
      <div class="spinner"></div>
      <p>Cargando datos...</p>
    </div>

    <!-- Error -->
    <div v-if="error" class="error-banner">
      <span class="error-icon"><AppIcon name="alert" :size="16" /></span> {{ error }}
      <button @click="error = null"><AppIcon name="x" :size="16" /></button>
    </div>

    <main class="main-content">
      <!-- Los totales y las secciones se quedan donde están. -->
      <!-- Totales Generales -->
      <div v-if="resumen.length > 0" class="stats-grid">
        <div class="stat-card stat-primary">
          <div class="stat-icon"><AppIcon name="box" :size="26" /></div>
          <div class="stat-info">
            <span class="stat-label">Total Asignado</span>
            <span class="stat-value">{{ totalesGenerales.asignado }}</span>
          </div>
        </div>
        <div class="stat-card stat-success">
          <div class="stat-icon"><AppIcon name="hourglass" :size="26" /></div>
          <div class="stat-info">
            <span class="stat-label">En Proceso</span>
            <span class="stat-value">{{ totalesGenerales.en_proceso }}</span>
          </div>
        </div>
        <div class="stat-card stat-warning">
          <div class="stat-icon"><AppIcon name="check" :size="26" /></div>
          <div class="stat-info">
            <span class="stat-label">Completado</span>
            <span class="stat-value">{{ totalesGenerales.completada }}</span>
          </div>
        </div>
        <div class="stat-card stat-purple">
          <div class="stat-icon"><AppIcon name="inbox" :size="26" /></div>
          <div class="stat-info">
            <span class="stat-label">Pendiente</span>
            <span class="stat-value">{{ totalesGenerales.pendiente }}</span>
          </div>
        </div>
      </div>

      <!-- Tabs Asignaciones / Resumen -->
      <section class="card">
        <!-- EL SELECTOR MANDA SOBRE LAS CUATRO SECCIONES.
             Antes sólo gobernaba Resumen y Asignaciones, y Almacén y Ventas iban apiladas
             debajo: la página era un scroll de cuatro bloques, uno detrás de otro, y en el
             móvil no se acababa nunca. Ahora se ve una a la vez.
             En pantalla ancha son pestañas de toda la vida; en el móvil, un deslizador con
             flechas, porque cuatro pestañas con icono y texto no caben en 360 px. -->
        <div class="seccion-tabs">
          <button
            class="tab-flecha"
            type="button"
            aria-label="Sección anterior"
            :disabled="indiceSeccion === 0"
            @click="cambiarSeccion(-1)"
          >
            <AppIcon name="chevronLeft" :size="16" />
          </button>

          <div ref="pistaSecciones" class="tabs-pista">
            <button
              v-for="(s, i) in SECCIONES"
              :key="s.id"
              :class="{ active: seccionActiva === s.id }"
              :aria-current="seccionActiva === s.id ? 'page' : undefined"
              type="button"
              @click="seccionActiva = s.id"
            >
              <AppIcon :name="s.icono" :size="14" /> {{ s.titulo }}
              <!-- El contador dice si hay algo ahí dentro sin tener que entrar. -->
              <span v-if="cuentaSeccion(s.id) !== null" class="tab-badge">{{ cuentaSeccion(s.id) }}</span>
            </button>
          </div>

          <button
            class="tab-flecha"
            type="button"
            aria-label="Sección siguiente"
            :disabled="indiceSeccion === SECCIONES.length - 1"
            @click="cambiarSeccion(1)"
          >
            <AppIcon name="chevronRight" :size="16" />
          </button>
        </div>

        <!-- Puntitos: en el móvil dicen en cuál de las dos estás, que con el deslizador
             no se ve de un vistazo. -->
        <div class="tabs-puntos">
          <span
            v-for="s in SECCIONES"
            :key="'p-' + s.id"
            :class="{ activo: seccionActiva === s.id }"
          ></span>
        </div>
      </section>

      <!--
        El cambio de sección también se acompaña.

        Las cuatro secciones miden cosas distintas -una rejilla de tarjetas, una tabla
        de treinta filas, una matriz de once columnas-, así que al cambiar de pestaña
        la página saltaba de un tamaño a otro en un fotograma. Aquí la salida es
        inmediata y sólo la entrada se atenúa: si la salida también durara, quedaría un
        hueco vacío entre las dos y la página encogería y volvería a crecer, que es
        peor que el salto.
      -->
      <Transition name="seccion">
      <div :key="seccionActiva" class="seccion-contenido">

      <!--
        Cada sección en su propia tarjeta, con su cabecera.

        Resumen y Asignaciones vivían DENTRO de la tarjeta del selector, así que la
        tabla arrancaba pegada a las pestañas, sin separación ni título, mientras
        Almacén y Ventas sí tenían la suya. Eran dos maneras distintas de enseñar lo
        mismo en la misma pantalla.
      -->
      <section v-if="seccionActiva === 'resumen'" class="card">
        <div class="card-header">
          <h2><AppIcon name="clipboard" :size="18" /> Resumen por Vendedor</h2>
          <span class="badge">{{ resumenPorVendedor.length }} {{ resumenPorVendedor.length === 1 ? 'vendedor' : 'vendedores' }}</span>
        </div>
        <div>
          <div v-if="resumenPorVendedor.length > 0" class="vendedor-grid">
            <article v-for="item in resumenPorVendedor" :key="item.vendedor" class="vendedor-card">
              <header class="vendedor-header">
                <span class="vendedor-avatar">{{ inicialesDe(item.vendedor) }}</span>
                <div class="vendedor-id">
                  <h3>{{ item.vendedor }}</h3>
                  <p>{{ totalesDe(item).completada }} de {{ totalesDe(item).asignado }} despachados</p>
                </div>
                <span class="vendedor-avance" :title="`${avanceDe(item)} por ciento de lo asignado ya salió del almacén`">
                  {{ avanceDe(item) }}<small>%</small>
                </span>
              </header>

              <ul class="producto-lista">
                <li
                  v-for="prod in item.productos"
                  :key="prod.producto_id"
                  class="producto"
                  :class="{ abierto: esFilaExpandida(item.vendedor, prod.producto_id) }"
                >
                  <button
                    type="button"
                    class="producto-cabeza"
                    :aria-expanded="esFilaExpandida(item.vendedor, prod.producto_id)"
                    @click="toggleDetalle(item.vendedor, prod.producto_id, prod.producto_nombre, prod)"
                  >
                    <span class="producto-nombre">{{ nombreCorto(prod.producto_nombre) }}</span>
                    <span class="producto-cifra">
                      <b>{{ prod.completada }}</b><span class="de">/</span>{{ prod.asignado }}
                    </span>
                    <AppIcon name="chevronRight" :size="16" class="producto-flecha" />
                  </button>

                  <div
                    class="barra"
                    role="img"
                    :aria-label="`De ${prod.asignado} asignados: ${prod.completada} despachados, de ellos ${prod.cambiado} con factura distinta; ${prod.en_proceso} pedidos sin salir`"
                  >
                    <span class="tramo t-despachado" :style="{ width: tramosDe(prod).despachado }"></span>
                    <span class="tramo t-exceso" :style="{ width: tramosDe(prod).salioDeMas }"></span>
                    <span class="tramo t-libre" :style="{ width: tramosDe(prod).libre }"></span>
                  </div>

                  <!--
                    Pedido contra factura, que es para lo que sirve esta pantalla:
                    ver si se está llevando lo que se pidió. La diferencia se dice con
                    signo, que un +210 y un -80 no significan lo mismo.
                  -->
                  <p v-if="prod.pedido" class="cotejo">
                    Pidieron <b>{{ prod.pedido }}</b>
                    <span class="cotejo-flecha">→</span>
                    facturado <b>{{ prod.completada - prod.sin_pedido }}</b>
                    <span
                      v-if="prod.completada - prod.sin_pedido - prod.pedido"
                      class="cotejo-dif"
                      :class="{ 'dif-menos': prod.completada - prod.sin_pedido - prod.pedido < 0 }"
                    >{{ prod.completada - prod.sin_pedido - prod.pedido > 0 ? '+' : '' }}{{ prod.completada - prod.sin_pedido - prod.pedido }}</span>
                    <span v-else class="cotejo-igual">clavado</span>
                  </p>

                  <!--
                    Tres cifras y para. Llegó a haber seis por producto -y dos de ellas
                    diciendo lo mismo con distinto nombre-, y una fila con seis números
                    no se lee: se descifra. Lo que importa de un vistazo es cuánto salió,
                    cuánto se pasó y cuánto queda sin pedir. Lo demás -en proceso,
                    cerrado sin factura, salió sin pedido, lo que cambió- está en el
                    detalle, a un clic, que es donde hay sitio para explicarlo.
                  -->
                  <p class="marcas">
                    <span class="marca m-despachado">Despachado <b>{{ prod.completada }}</b></span>
                    <span
                      v-if="tramosDe(prod).exceso"
                      class="marca m-demas"
                      :title="`Vendió ${prod.completada} contra ${prod.asignado} asignados`"
                    >Vendió de más <b>{{ tramosDe(prod).exceso }}</b></span>
                    <span
                      v-if="prod.pendiente"
                      class="marca m-libre"
                      title="Asignado que todavía no ha sido despachado"
                    >Pendiente <b>{{ prod.pendiente }}</b></span>
                  </p>

                </li>
              </ul>

              <!--
                El pie va pegado al fondo de la tarjeta.

                Al igualar el alto de las tarjetas de una fila, a la del vendedor con un
                solo producto le sobraban doscientos píxeles en blanco. Con el pie abajo
                ese hueco deja de ser un vacío: cierra la tarjeta y repite los totales
                del vendedor, que es lo que se compara entre uno y otro.
              -->
              <footer class="vendedor-pie">
                <span><b>{{ totalesDe(item).asignado }}</b> asignados</span>
                <span class="pie-despachado"><b>{{ totalesDe(item).completada }}</b> despachados</span>
                <span class="pie-proceso"><b>{{ totalesDe(item).en_proceso }}</b> en proceso</span>
                <span v-if="totalesDe(item).pendiente > 0" class="pie-pendiente">Pendientes <b>{{ totalesDe(item).pendiente }}</b></span>
                <span v-if="totalesDe(item).exceso" class="pie-exceso">
                  <b>{{ totalesDe(item).exceso }}</b> vendidos de más
                </span>
              </footer>
            </article>
          </div>
          <div v-else class="empty-state">
            <p>No hay resumen de asignaciones</p>
          </div>
        </div>
      </section>

      <section v-if="seccionActiva === 'asignaciones'" class="card">
        <div class="card-header">
          <h2><AppIcon name="edit" :size="18" /> Asignaciones</h2>
          <div class="cabecera-derecha">
            <label class="elegir-mes">
              <AppIcon name="calendar" :size="15" />
              <select v-model="mesElegido" aria-label="Mes de las asignaciones">
                <option v-for="m in mesesDisponibles" :key="m.mes" :value="m.mes">
                  {{ nombreDelMes(m.mes) }}<template v-if="m.cuantas"> ({{ m.cuantas }})</template>
                </option>
              </select>
            </label>
            <span class="badge">{{ asignaciones ? asignaciones.length : 0 }} {{ (asignaciones ? asignaciones.length : 0) === 1 ? 'asignación' : 'asignaciones' }}</span>
          </div>
        </div>
        <div>
          <div v-if="asignaciones && asignaciones.length > 0" class="table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th class="fila-num">#</th>
                  <th>Fecha</th>
                  <th>Vendedor</th>
                  <th>Producto</th>
                  <th class="text-right">Cantidad</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(asig, i) in asignacionesVisibles" :key="asig.id">
                  <td class="fila-num">{{ primeraDeLaPagina + i + 1 }}</td>
                  <td>{{ asig.fecha }}</td>
                  <td>{{ asig.vendedor }}</td>
                  <td>{{ asig.producto_nombre }}</td>
                  <td class="text-right">{{ asig.cantidad }}</td>
                  <td class="text-center">
                    <button @click="eliminarAsignacion(asig.id)" class="btn-icon btn-danger" title="Eliminar"><AppIcon name="trash" :size="16" /></button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- El pie sólo aparece cuando hay más de una página o más filas de las que
               caben: con catorce asignaciones no pinta nada y estorba. -->
          <div v-if="asignaciones.length > POR_PAGINA[0]" class="paginacion">
            <span class="pag-cuenta">
              <template v-if="porPagina === 0">
                Las {{ asignaciones.length }}
              </template>
              <template v-else>
                {{ primeraDeLaPagina + 1 }}–{{ primeraDeLaPagina + asignacionesVisibles.length }}
                de {{ asignaciones.length }}
              </template>
            </span>

            <label class="pag-cuantas">
              Por página
              <select v-model.number="porPagina">
                <option v-for="n in POR_PAGINA" :key="n" :value="n">{{ n === 0 ? 'Todas' : n }}</option>
              </select>
            </label>

            <span v-if="totalPaginas > 1" class="pag-pasos">
              <button type="button" :disabled="paginaActual === 1" aria-label="Página anterior" @click="pagina = paginaActual - 1">
                <AppIcon name="chevronLeft" :size="16" />
              </button>
              <span class="pag-donde">{{ paginaActual }} de {{ totalPaginas }}</span>
              <button type="button" :disabled="paginaActual === totalPaginas" aria-label="Página siguiente" @click="pagina = paginaActual + 1">
                <AppIcon name="chevronRight" :size="16" />
              </button>
            </span>
          </div>

          <!--
            Condición propia, no `v-else`.

            El `v-else` tiene que ir pegado a su `v-if`, y al meter el pie de la
            paginación entre los dos se rompió la pareja: Vue dejó de emparejarlos y el
            "No hay asignaciones" salía SIEMPRE, debajo de las catorce filas.
          -->
          <div v-if="!asignaciones || asignaciones.length === 0" class="empty-state">
            <p>No hay asignaciones en {{ nombreDelMes(mesElegido) }}</p>
          </div>
        </div>
      </section>

      <!-- Cuando la sección elegida no tiene nada que enseñar se dice, en vez de dejar la
           pantalla en blanco: un hueco vacío no se distingue de algo roto. -->
      <section
        v-if="(seccionActiva === 'almacen' && !almacen.length) || (seccionActiva === 'ventas' && !ventas.length)"
        class="card seccion-vacia"
      >
        <AppIcon :name="seccionActiva === 'almacen' ? 'warehouse' : 'cart'" :size="28" />
        <p>
          {{ seccionActiva === 'almacen' ? 'No hay stock que mostrar.' : 'No hay ventas registradas este mes.' }}
        </p>
      </section>

      <!-- Stock en Almacén -->
      <section v-if="seccionActiva === 'almacen' && almacen.length > 0" class="card">
        <div class="card-header">
          <h2><AppIcon name="warehouse" :size="18" /> Stock en Almacén</h2>
          <span class="badge">{{ totalesAlmacen.productos }} productos</span>
        </div>
        <div class="table-wrapper table-almacen">
          <table class="data-table">
            <thead>
              <tr>
                <th>Producto</th>
                <th class="text-right">Precio</th>
                <th v-for="a in almacen" :key="a.almacen" class="text-right">{{ a.almacen }}</th>
                <th class="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in matrizAlmacen.productos" :key="item.producto_id">
                <td>{{ item.nombre }}</td>
                <!--
                  El precio sale de la última venta, no de la ficha: Ventra no guarda
                  precio en el producto. Si esa venta es vieja se dice de cuándo es, en
                  vez de esconder el número: saber que el KAPITAL INDUSTRIAL se vendió a
                  18 en febrero de 2025 es más útil que un "sin precio" que se lee como
                  que no vale nada.
                -->
                <td class="text-right" :class="{ 'sin-precio': !item.precio }">
                  <template v-if="item.precio">
                    ${{ item.precio.toFixed(2) }}
                    <span v-if="item.precio_viejo" class="precio-viejo" :title="`Último precio conocido, de una venta del ${item.precio_fecha}`">
                      {{ item.precio_fecha }}
                    </span>
                  </template>
                  <template v-else>nunca se ha vendido</template>
                </td>
                <!-- El cero se apaga: en una tabla de diez almacenes, si todos los
                     números pesan lo mismo hay que leerlos uno a uno para ver dónde
                     hay mercancía de verdad. -->
                <td
                  v-for="a in almacen"
                  :key="a.almacen"
                  class="text-right stock-val"
                  :class="{ 'stock-cero': !item.porAlmacen[a.almacen] }"
                >{{ item.porAlmacen[a.almacen] || 0 }}</td>
                <td class="text-right stock-val stock-total">{{ item.stock }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Ventas Registradas -->
      <section v-if="seccionActiva === 'ventas' && ventas.length > 0" class="card">
        <div class="card-header">
          <h2><AppIcon name="cart" :size="18" /> Ventas Registradas</h2>
          <span class="badge success">${{ totalVentasFiltrado.toFixed(2) }}</span>
        </div>

        <!-- Filtro de fecha -->
        <div class="filtro-fecha">
          <span class="filtro-modo">
            <button :class="{ active: filtroPreset === 'hoy' }" @click="filtroPreset = 'hoy'">Hoy</button>
            <button :class="{ active: filtroPreset === 'mes' }" @click="filtroPreset = 'mes'">Mes</button>
            <button :class="{ active: filtroPreset === 'rango' }" @click="filtroPreset = 'rango'">Rango</button>
          </span>
          <div v-if="filtroPreset === 'rango'" class="filtro-rango">
            <div class="calendar-group">
              <div class="calendar-input-wrapper" @click="abrirCalRango">
                <span class="cal-display"><AppIcon name="calendar" :size="16" /> {{ filtroFechaDesde ? `${filtroFechaDesde} — ${filtroFechaHasta || filtroFechaDesde}` : 'Elegir fechas' }}</span>
              </div>
              <div v-if="showCalRango" class="calendar-popup" @click.stop>
                <div class="cal-header">
                  <button type="button" @click="prevMonth" class="cal-nav">&lt;</button>
                  <span class="cal-title">{{ calMonthName }} {{ calYear }}</span>
                  <button type="button" @click="nextMonth" class="cal-nav">&gt;</button>
                </div>
                <p class="cal-hint">{{ calObjetivo === 'desde' ? 'Elige el día inicial' : 'Elige el día final' }}</p>
                <div class="cal-weekdays">
                  <span>Lu</span><span>Ma</span><span>Mi</span><span>Ju</span><span>Vi</span><span>Sa</span><span>Do</span>
                </div>
                <div class="cal-grid">
                  <button
                    v-for="(day, idx) in calDays"
                    :key="idx"
                    type="button"
                    class="cal-day"
                    :class="{ empty: !day, selected: day && esDiaEnRango(`${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`) }"
                    @click="seleccionarDiaRango(day)"
                    :disabled="!day"
                  >{{ day }}</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!--
          Elegir vendedor.

          Antes era una fila de fichas. Con diez vendedores se partía en dos filas y
          empujaba la tabla; puesta en una sola línea había que arrastrarla para ver
          los últimos. Ninguna de las dos sirve cuando la lista crece.

          En pantalla ancha va como lista a un lado: caben los diez a la vez, cada uno
          con su importe, y la lista por sí sola ya dice quién vende y quién no. En
          pantalla estrecha, un desplegable del propio teléfono: una línea, sin
          arrastrar, y da igual que sean diez que cuarenta.
        -->
        <div class="ventas-cuerpo">
          <div class="ventas-lado">
            <label class="lado-etiqueta" for="elegir-vendedor">Vendedor</label>

            <select
              id="elegir-vendedor"
              class="lado-select"
              :value="vendedorSeleccionado"
              @change="elegirVendedor($event.target.value)"
            >
              <option value="">Todos los vendedores</option>
              <option v-for="v in vendedoresPorImporte" :key="v.vendedor" :value="v.vendedor">
                {{ v.vendedor }} — ${{ importeDe(v).toFixed(2) }}
              </option>
            </select>

            <ul class="lado-lista">
              <li>
                <button
                  type="button"
                  :class="{ active: !vendedorSeleccionado }"
                  @click="elegirVendedor('')"
                >
                  <AppIcon name="users" :size="14" />
                  <span class="lado-nombre">Todos</span>
                  <span class="lado-importe">${{ totalTodosVendedores.toFixed(2) }}</span>
                </button>
              </li>
              <li v-for="v in vendedoresPorImporte" :key="v.vendedor">
                <button
                  type="button"
                  :class="{ active: vendedorSeleccionado === v.vendedor }"
                  :title="v.vendedor"
                  @click="elegirVendedor(v.vendedor)"
                >
                  <span class="lado-inicial">{{ inicialesDe(v.vendedor) }}</span>
                  <span class="lado-nombre">{{ nombreCortoVendedor(v.vendedor) }}</span>
                  <span class="lado-importe">${{ importeDe(v).toFixed(2) }}</span>
                </button>
              </li>
            </ul>
          </div>

          <div class="ventas-detalle">
          <!--
            Al cambiar de vendedor el contenido se cruza en vez de aparecer de golpe.

            Sin esto, pasar de "Todos" -una matriz de once columnas- a un vendedor con
            tres productos es un parpadeo seco: desaparece un bloque grande y aparece
            otro pequeño en el mismo fotograma, y la vista tiene que volver a buscar
            dónde está todo. Con el cruce el ojo sigue el cambio.
          -->
          <Transition name="cambio" mode="out-in">
          <div :key="vendedorSeleccionado || 'todos'">
        <!-- Matriz cuando está "Todos" -->
        <div v-if="!vendedorSeleccionado" class="matriz-ventas">
          <table class="mini-table">
            <thead>
              <tr>
                <th>Producto</th>
                <th v-for="v in matrizVentasTodos.vendedores" :key="v" class="text-right">{{ v.split(' ')[0] }} {{ v.split(' ').slice(-1)[0] }}</th>
                <th class="text-right">Total</th>
                <th class="text-right">Clientes</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="prod in matrizVentasTodos.filas" :key="prod.producto_nombre">
                <td>{{ prod.producto_nombre.replace('CERVEZA ', '').replace('MALTA ', '') }}</td>
                <td v-for="v in matrizVentasTodos.vendedores" :key="v" class="text-right">
                  {{ prod.porVendedor[v] ? prod.porVendedor[v].vendido : 0 }}
                  <span v-if="prod.porVendedor[v] && prod.porVendedor[v].clientes" class="clientes-mini"><AppIcon name="users" :size="12" /> {{ prod.porVendedor[v].clientes }}</span>
                </td>
                <td class="text-right total-val">{{ prod.cantidadTotal }}</td>
                <td class="text-right clientes-total"><AppIcon name="users" :size="13" /> {{ prod.clientes }}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td><strong>Total</strong></td>
                <td v-for="v in matrizVentasTodos.vendedores" :key="v" class="text-right">
                  <strong>{{ totalPorVendedorEnMatriz(v) }}</strong>
                </td>
                <td class="text-right total-val"><strong>{{ totalVentasUnidades }}</strong></td>
                <td class="text-right clientes-total"><strong><AppIcon name="users" :size="13" /> {{ totalClientesMatriz }}</strong></td>
              </tr>
            </tfoot>
          </table>
        </div>

        <!-- Ventas del vendedor seleccionado -->
        <div v-if="vendedorSeleccionado">
          <div v-for="item in ventasFiltradas" :key="item.vendedor" class="venta-card">
          <div class="venta-header">
            <span class="vendedor-avatar">{{ inicialesDe(item.vendedor) }}</span>
            <h3>{{ item.vendedor }}</h3>
            <span class="venta-clientes"><AppIcon name="users" :size="14" /> {{ item.clientes }} {{ item.clientes === 1 ? 'cliente' : 'clientes' }}</span>
            <span class="venta-total">${{ Object.values(item.productos).reduce((s, p) => s + p.total, 0).toFixed(2) }}</span>
          </div>
          <!-- En una pantalla de 390 px estas cinco columnas no caben y la de Total
               quedaba cortada por el borde, sin forma de llegar a ella. -->
          <div class="table-wrapper">
          <table class="mini-table tabla-vendedor">
            <thead>
              <tr>
                <th>Producto</th>
                <th class="text-right">Precio</th>
                <th class="text-right">Cantidad</th>
                <th class="text-right">Clientes</th>
                <th class="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(prod, prodId) in item.productos" :key="prodId">
                <td>{{ prod.producto_nombre.replace('CERVEZA ', '').replace('MALTA ', '') }}</td>
                <td class="text-right">${{ prod.precio.toFixed(2) }}</td>
                <td class="text-right">{{ prod.vendido }}</td>
                <td class="text-right"><AppIcon name="users" :size="13" /> {{ prod.clientes }}</td>
                <td class="text-right total-val">${{ prod.total.toFixed(2) }}</td>
              </tr>
            </tbody>
          </table>
          </div>
          </div>
        </div>

        <div v-if="vendedorSeleccionado && ventasFiltradas.length === 0" class="empty-state">
          <span class="empty-icon"><AppIcon name="inbox" :size="40" /></span>
          <p>No hay ventas para este vendedor</p>
        </div>
          </div>
          </Transition>
          </div>
        </div>
      </section>

      </div>
      </Transition>

    </main>
      <!-- El detalle de una fila: ventana en escritorio, cajón en móvil. Fuera de la
         rejilla, para que abrirlo no mueva de sitio a los demás vendedores. -->

    <!--
      Nueva asignación: ventana en escritorio, cajón en el móvil.

      Estaba dentro del flujo de la página: al abrirlo, el bloque crecía y empujaba
      hacia abajo los totales, las pestañas y la tabla entera. Elegir nueve vendedores
      obligaba a mirar cómo se movía todo lo demás, y al cerrarlo la página volvía a
      dar el salto en sentido contrario. Un formulario que se abre no puede reordenar
      la pantalla que hay detrás.
    -->
    <Teleport to="body">
      <Transition name="ventana">
        <div v-if="showForm" class="capa capa-desde-boton" @click.self="showForm = false">
          <div class="hoja hoja-ancha" role="dialog" aria-modal="true" aria-labelledby="titulo-form">
            <span class="hoja-asa" aria-hidden="true"></span>
            <header class="hoja-cabeza">
              <div class="hoja-quien">
                <p id="titulo-form">Nueva Asignación</p>
                <p class="hoja-vendedor">{{ nombreDelMes(mesEnCurso()) }}</p>
              </div>
              <button type="button" class="hoja-cerrar" aria-label="Cerrar" @click="showForm = false">
                <AppIcon name="x" :size="18" />
              </button>
            </header>

            <div class="hoja-cuerpo">
              <form @submit.prevent="crearAsignacion">
            <div class="form-row">
              <div class="form-group">
                <label>Producto</label>
                <select v-model="nuevaAsignacion.producto" required>
                  <option value="">-- Seleccionar --</option>
                  <option v-for="p in productosFiltrados" :key="p.id" :value="p.id">{{ p.name }} (stock: {{ p.stock }})</option>
                </select>
              </div>
              <div class="form-group">
                <label>Cantidad</label>
                <input type="number" v-model="nuevaAsignacion.cantidad" min="1" placeholder="0" required />
              </div>
              <div class="form-group calendar-group">
                <label>Fecha</label>
                <div class="calendar-input-wrapper" @click="abrirCalAsignacion">
                  <span class="cal-display"><AppIcon name="calendar" :size="16" /> {{ nuevaAsignacion.fecha }}</span>
                </div>
                <div v-if="showCalendar" class="calendar-popup" @click.stop>
                  <div class="cal-header">
                    <button type="button" @click="prevMonth" class="cal-nav">&lt;</button>
                    <span class="cal-title">{{ calMonthName }} {{ calYear }}</span>
                    <button type="button" @click="nextMonth" class="cal-nav">&gt;</button>
                  </div>
                  <div class="cal-weekdays">
                    <span>Lu</span><span>Ma</span><span>Mi</span><span>Ju</span><span>Vi</span><span>Sa</span><span>Do</span>
                  </div>
                  <div class="cal-grid">
                    <button
                      v-for="(day, idx) in calDays"
                      :key="idx"
                      type="button"
                      class="cal-day"
                      :class="{ empty: !day, selected: day && nuevaAsignacion.fecha === `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}` }"
                      @click="selectCalendarDay(day)"
                      :disabled="!day"
                    >{{ day }}</button>
                  </div>
                </div>
              </div>
            </div>
            <div class="form-group">
              <label>Vendedores ({{ vendedoresSeleccionados.length }}/{{ vendedores.length }})</label>
              <!-- `btn-ghost` es blanco sobre transparente: está hecho para la cabecera
                   morada. Aquí el fondo es blanco, así que este botón llevaba todo este
                   tiempo siendo invisible: ocupaba su sitio y no se veía. -->
              <button type="button" class="btn btn-suave btn-sm" @click="toggleTodosVendedores">
                {{ vendedoresSeleccionados.length === vendedores.length ? 'Desmarcar Todos' : 'Seleccionar Todos' }}
              </button>
              <div class="vendedores-checklist">
                <label v-for="v in vendedores" :key="v.id" class="vendedor-check">
                  <input type="checkbox" :value="v.nombre" v-model="vendedoresSeleccionados" />
                  <span>{{ v.nombre }}</span>
                </label>
              </div>
            </div>
            <button type="submit" class="btn btn-success btn-block" :disabled="vendedoresSeleccionados.length === 0">
              <AppIcon name="save" :size="16" /> Guardar Asignación ({{ vendedoresSeleccionados.length }} vendedor{{ vendedoresSeleccionados.length !== 1 ? 'es' : '' }})
            </button>
</form>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <Teleport to="body">
      <Transition name="ventana">
      <div v-if="filaExpandida && detalleDe" class="capa" @click.self="cerrarDetalle">
        <div class="hoja" role="dialog" aria-modal="true" aria-labelledby="hoja-titulo">
          <!-- El asa sólo se ve en el móvil: es lo que dice que esto es un cajón y
               que se cierra tirando hacia abajo. -->
          <span class="hoja-asa" aria-hidden="true"></span>
          <header class="hoja-cabeza">
            <div class="hoja-quien">
              <p id="hoja-titulo">{{ nombreCorto(detalleDe.producto_nombre) }}</p>
              <p class="hoja-vendedor">{{ detalleDe.vendedor }}</p>
            </div>
            <button type="button" class="hoja-cerrar" aria-label="Cerrar" @click="cerrarDetalle">
              <AppIcon name="x" :size="18" />
            </button>
          </header>

          <div class="hoja-cuerpo">
            <!--
              Aquí sí caben todas las cifras, porque hay sitio para decir qué es cada
              una. En la tarjeta sólo van tres; seis números seguidos sin explicación no
              se leen.
            -->
            <dl v-if="detalleDe.prod" class="cifras">
              <div>
                <dt>Asignado</dt>
                <dd>{{ detalleDe.prod.asignado }}</dd>
              </div>
              <div>
                <dt>Despachado <small>facturas de Ventra</small></dt>
                <dd class="c-verde">{{ detalleDe.prod.completada }}</dd>
              </div>
              <div v-if="detalleDe.prod.en_proceso">
                <dt>En proceso <small>pedido y sin facturar</small></dt>
                <dd class="c-ambar">{{ detalleDe.prod.en_proceso }}</dd>
              </div>
              <div v-if="detalleDe.prod.cerrado_sin_factura">
                <dt>Cerrado sin factura <small>no va a salir solo</small></dt>
                <dd class="c-rojo">{{ detalleDe.prod.cerrado_sin_factura }}</dd>
              </div>
            </dl>

            <p v-if="loadingDetalle" class="detalle-aviso">Cargando…</p>
            <div v-else-if="errorDetalle" class="detalle-fallo">
              <AppIcon name="alert" :size="18" />
              <p>{{ errorDetalle }}</p>
              <button type="button" class="btn-reintentar" @click="traerDetalle(true)">Reintentar</button>
            </div>
            <p v-else-if="pedidosDelDetalle.length === 0" class="detalle-aviso">
              No queda ningún pedido por despachar de este producto
            </p>
            <template v-else>
              <div class="detalle-titulo">
                Pedidos sin despachar ({{ pedidosDelDetalle.length }})
              </div>
              <ul class="pedido-lista">
                <li v-for="(ped, idx) in pedidosVisibles" :key="idx" class="pedido">
                  <span class="pedido-folio">{{ ped.folio }}</span>
                  <span class="pedido-cliente">{{ ped.cliente_nombre || 'Sin cliente' }}</span>
                  <span class="pedido-packs">{{ ped.packs }}</span>
                  <span class="pedido-fecha">{{ ped.fecha ? ped.fecha.split('T')[0] : '—' }}</span>
                  <span class="pedido-estado">
                    <span
                      v-if="ped.factura_estado === 'cambiado'"
                      class="sello s-cambiado"
                      :title="ped.factura ? `Factura ${ped.factura}: se facturó algo distinto de lo pedido` : 'Se facturó algo distinto de lo pedido'"
                    >Facturó y cambió</span>
                    <span
                      v-else-if="ped.facturado"
                      class="sello s-facturado"
                      :title="ped.factura ? `Factura ${ped.factura}` : 'Facturado'"
                    >Facturado</span>
                    <span
                      v-if="ped.cerrado_sin_factura"
                      class="sello s-cerrado"
                      title="PEDIDO lo dio por completado y Ventra nunca lo facturó"
                    >Cerrado sin factura</span>
                    <span v-else class="sello s-proceso">Sin factura</span>
                    <span
                      v-if="ped.cobrado_vendedor"
                      class="sello s-cobrado"
                      title="El vendedor lo declaró cobrado. Es otra cosa que estar facturado."
                    >Cobrado</span>
                    <span
                      v-if="ped.cobrado_manual"
                      class="sello s-manual"
                      title="Marcado a mano desde esta aplicación"
                    >Marcado</span>
                  </span>
                </li>
              </ul>

              <!-- Sólo cuando hay más de una página: con ocho pedidos estorba. -->
              <div v-if="paginasDetalle > 1" class="detalle-paginas">
                <button type="button" :disabled="paginaDetalleActual === 1" aria-label="Anterior"
                        @click="paginaDetalle = paginaDetalleActual - 1">
                  <AppIcon name="chevronLeft" :size="15" />
                </button>
                <span>{{ paginaDetalleActual }} de {{ paginasDetalle }}</span>
                <button type="button" :disabled="paginaDetalleActual === paginasDetalle" aria-label="Siguiente"
                        @click="paginaDetalle = paginaDetalleActual + 1">
                  <AppIcon name="chevronRight" :size="15" />
                </button>
              </div>
            </template>
          </div>
        </div>
      </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

:root {
  --bg: #f0f2f5;
  --surface: #ffffff;
  --primary: #4f46e5;
  --primary-light: #818cf8;
  --success: #10b981;
  --success-light: #34d399;
  --warning: #f59e0b;
  --danger: #ef4444;
  --purple: #8b5cf6;
  --text: #1e293b;
  --text-light: #64748b;
  --border: #e2e8f0;
  --shadow: 0 1px 3px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06);
  /*
   * La aplicación es clara y punto. Sin esto el navegador de quien tenga el sistema
   * en oscuro pinta las barras de desplazamiento y los desplegables en negro sobre
   * una página blanca.
   */
  color-scheme: light;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  --shadow-lg: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05);
  --radius: 12px;
}

/*
 * El hueco de la barra de desplazamiento se reserva siempre.
 *
 * Al abrir la ventana de detalle se bloquea el desplazamiento de la página, la barra
 * desaparece y la página gana de golpe los 9 px que ocupaba: todo -cabecera, tarjetas,
 * tablas- da un salto hacia la derecha justo en el momento en que aparece la ventana.
 * Con el hueco reservado no hay nada que devolver y no se mueve nada.
 */
html {
  scrollbar-gutter: stable;
}

body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
}

/*
 * La aplicación ocupa la ventana.
 *
 * El andamio que trae Vite al crear el proyecto dejaba `#app` en una caja de 1126 px
 * centrada, con una raya vertical a cada lado, `text-align: center` —de ahí que los
 * nombres de los vendedores salieran centrados— y `min-height: 100svh`. Se quitó
 * entero: no lo usaba nada más que esa caja, y era lo que tenía el diseño metido en
 * un sobre con la barra de desplazamiento colgando lejos del contenido.
 */
#app {
  min-height: 100vh;
}

/* Fina y discreta. La de serie es una franja gris de 15 px al lado de todo. */
* {
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--text-light) 35%, transparent) transparent;
}

*::-webkit-scrollbar {
  width: 9px;
  height: 9px;
}

*::-webkit-scrollbar-track {
  background: transparent;
}

*::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--text-light) 35%, transparent);
  border-radius: 99px;
}

*::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--text-light) 60%, transparent);
}

.app {
  min-height: 100vh;
}

/* Header */
.app-header {
  background: linear-gradient(135deg, var(--primary) 0%, #7c3aed 100%);
  color: white;
  padding: 0 24px;
  position: sticky;
  top: 0;
  z-index: 100;
  box-shadow: var(--shadow-lg);
}

.header-content {
  max-width: var(--ancho, 1200px);
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 72px;
}

.header-title {
  display: flex;
  align-items: center;
  gap: 16px;
}

.logo {
  font-size: 32px;
  background: rgba(255,255,255,0.2);
  width: 52px;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
}

.header-title h1 {
  font-size: 20px;
  font-weight: 600;
  margin: 0;
}

.subtitle {
  font-size: 13px;
  opacity: 0.85;
  margin: 0;
}

.header-actions {
  display: flex;
  gap: 8px;
}

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 18px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-lg {
  padding: 12px 24px;
  font-size: 15px;
}

.btn-primary {
  background: white;
  color: var(--primary);
}

.btn-primary:hover {
  background: #f8fafc;
  transform: translateY(-1px);
}

/* Sólo para la cabecera morada: blanco sobre el degradado. */
.btn-ghost {
  background: rgba(255,255,255,0.15);
  color: white;
  padding: 10px;
}

/* El mismo papel, pero sobre fondo claro. */
.btn-suave {
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
}

.btn-suave:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.btn-ghost:hover {
  background: rgba(255,255,255,0.25);
}

.ref-btn {
  position: relative;
}

.ref-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  width: 12px;
  height: 12px;
  background: var(--danger);
  border: 2px solid #fff;
  border-radius: 50%;
  animation: refPulse 1.2s ease-in-out infinite;
}

@keyframes refPulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.35); opacity: 0.7; }
}

.btn-success {
  background: var(--success);
  color: white;
}

.btn-success:hover {
  background: #059669;
}

.btn-block {
  width: 100%;
}

.btn-sm {
  padding: 6px 12px;
  font-size: 12px;
  margin-bottom: 8px;
}

.vendedores-checklist {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 4px;
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px;
  margin-top: 4px;
}

.vendedor-check {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  transition: background 0.15s;
}

.vendedor-check:hover {
  background: var(--bg);
}

.vendedor-check input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: var(--primary);
}

.btn-icon {
  background: none;
  border: none;
  font-size: 16px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
  transition: background 0.2s;
}

.btn-icon:hover {
  background: var(--bg);
}

.btn-danger:hover {
  background: #fee2e2;
}

/* Main Content */
.main-content {
  /**
   * Ancho del contenido.
   *
   * Estaba clavado en 1200 px: en un monitor de 27 pulgadas dejaba media pantalla en
   * blanco a cada lado, y las tablas de ventas —que tienen ocho columnas— seguían
   * apretadas teniendo sitio de sobra al lado. Ahora crece con la pantalla hasta un tope
   * donde el texto sigue siendo cómodo de leer.
   */
  max-width: var(--ancho, 1200px);
  margin: 0 auto;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* Loading */
.loading-overlay {
  position: fixed;
  inset: 0;
  background: rgba(255,255,255,0.9);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  gap: 16px;
}

.spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--border);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Error */
.error-banner {
  background: var(--danger);
  color: white;
  padding: 12px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-radius: var(--radius);
}

.error-banner .error-icon,
.error-banner svg {
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

.error-banner button {
  background: none;
  border: none;
  color: white;
  cursor: pointer;
  font-size: 18px;
  opacity: 0.8;
}

/* Form Card */
.form-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  margin-bottom: 20px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-group label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-light);
}

.form-group select,
.form-group input {
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 14px;
  transition: border-color 0.2s, box-shadow 0.2s;
  background: var(--surface);
  color: var(--text);
}

.form-group select:focus,
.form-group input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.1);
}

.form-group input[type="date"] {
  color: var(--text);
}

/* Slide transition */
/* Stats Grid */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
}

.stat-card {
  background: var(--surface);
  border-radius: var(--radius);
  padding: 20px;
  display: flex;
  align-items: center;
  gap: 16px;
  box-shadow: var(--shadow);
  border: 1px solid var(--border);
  transition: transform 0.2s, box-shadow 0.2s;
}

.stat-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg);
}

.stat-icon {
  font-size: 28px;
  width: 52px;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
}

.stat-primary .stat-icon { background: #eef2ff; }
.stat-success .stat-icon { background: #d1fae5; }
.stat-warning .stat-icon { background: #fef3c7; }
.stat-purple .stat-icon { background: #ede9fe; }

.stat-info {
  display: flex;
  flex-direction: column;
}

.stat-label {
  font-size: 12px;
  color: var(--text-light);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.stat-value {
  font-size: 24px;
  font-weight: 700;
}

.stat-primary .stat-value { color: var(--primary); }
.stat-success .stat-value { color: var(--success); }
.stat-warning .stat-value { color: var(--warning); }
.stat-purple .stat-value { color: var(--purple); }

/* Card */
.card {
  background: var(--surface);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  border: 1px solid var(--border);
  overflow: hidden;
}

.card-header {
  padding: 20px 24px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card-header h2 {
  font-size: 16px;
  font-weight: 700;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 8px;
}

.badge {
  background: var(--bg);
  color: var(--text-light);
  font-size: 12px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 20px;
}

.badge.success {
  background: #d1fae5;
  color: var(--success);
}

/* Tables */
.table-wrapper {
  overflow-x: auto;
}

.table-almacen {
  max-height: 480px;
  overflow: auto;
}

.table-almacen thead th {
  position: sticky;
  top: 0;
  z-index: 3;
  background: #eef2f6;
  box-shadow: 0 1px 0 var(--border, #d1d5db);
}

.data-table {
  width: 100%;
  border-collapse: collapse;
}

.data-table th,
.data-table td {
  padding: 11px 20px;
  font-size: 13px;
}

/*
 * Ojo con esto: `.data-table td { text-align: left }` pesa más que `.text-right`, así
 * que ponerlo aquí dejaba sin efecto todos los `text-right` de las plantillas y las
 * cantidades salían pegadas a la izquierda de una celda anchísima. Izquierda ya es lo
 * que hace el navegador solo; no hacía falta escribirlo.
 */

.data-table th {
  background: var(--bg);
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text);
}

.data-table tbody tr {
  border-bottom: 1px solid var(--border);
}

.data-table tbody tr:last-child {
  border-bottom: none;
}

.data-table tbody tr:hover {
  background: #fafbfc;
}

.data-table tfoot {
  background: var(--bg);
  border-top: 2px solid var(--border);
}

.data-table tfoot td {
  font-size: 14px;
}

.text-right {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.text-center {
  text-align: center;
}

.stock-val {
  color: var(--primary);
  font-weight: 600;
}

.precio-viejo {
  display: block;
  font-size: 10.5px;
  font-weight: 500;
  color: var(--warning);
  font-variant-numeric: tabular-nums;
}

.sin-precio {
  color: var(--text-light);
  font-size: 12px;
  font-style: italic;
}

.stock-cero {
  color: var(--text-light);
  font-weight: 400;
  opacity: 0.45;
}

/* La suma de todos los almacenes: es de otro orden que las columnas de al lado. */
.stock-total {
  color: var(--text);
  font-weight: 700;
  border-left: 1px solid var(--border);
}

.unidad-val {
  color: var(--text-light);
  font-weight: 600;
  font-size: 13px;
}

.total-val {
  color: var(--success);
  font-weight: 600;
}

.success {
  color: var(--success);
}

.warning {
  color: var(--warning);
}.danger {
  color: var(--danger);
  font-weight: 600;
}

/* Mini Table */
.mini-table {
  width: 100%;
  border-collapse: collapse;
}

.mini-table th,
.mini-table td {
  padding: 10px 16px;
  font-size: 13px;
}

.mini-table th {
  background: var(--bg);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--text);
}

.mini-table tbody tr {
  border-bottom: 1px solid var(--border);
}

.mini-table tbody tr:last-child {
  border-bottom: none;
}

/* Matriz de ventas "Todos" */
.matriz-ventas {
  overflow: auto;
  max-height: 480px;
  border-top: 1px solid var(--border);
}

.matriz-ventas table {
  min-width: 900px;
}

.matriz-ventas th:first-child,
.matriz-ventas td:first-child {
  position: sticky;
  left: 0;
  z-index: 2;
  background: var(--bg);
  font-weight: 600;
  min-width: 130px;
}

.matriz-ventas thead th {
  position: sticky;
  top: 0;
  z-index: 3;
  background: #eef2f6;
  box-shadow: 0 1px 0 var(--border);
}

.matriz-ventas thead th:first-child {
  z-index: 4;
}

/* Vendedor Grid */
.vendedor-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 16px;
  padding: 20px 24px;
  /*
   * Todas las tarjetas de una fila, del mismo alto.
   *
   * Con `align-items: start` cada tarjeta medía lo que midieran sus productos, y como
   * un vendedor lleva tres y otro siete, la fila la marcaba la más alta y las demás
   * dejaban un hueco debajo: la rejilla salía dentada y parecía que las tarjetas
   * crecían y encogían al pasar de una fila a otra. Igualadas, el hueco que sobra
   * queda DENTRO de la tarjeta, donde no rompe la cuadrícula.
   */
  align-items: stretch;
}

/* Filtro Fecha */
.filtro-fecha {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 24px;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}

.filtro-modo {
  display: flex;
  gap: 4px;
}

.filtro-modo button {
  padding: 6px 14px;
  border: 1px solid var(--border);
  background: var(--surface);
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text-light);
  transition: all 0.2s;
}

.filtro-modo button:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.filtro-modo button.active {
  background: var(--primary);
  color: white;
  border-color: var(--primary);
}

.filtro-rango {
  display: flex;
  align-items: center;
  gap: 12px;
}

.filtro-rango .calendar-input-wrapper {
  padding: 8px 12px;
  font-size: 13px;
  min-width: 140px;
}

.filtro-rango label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.filtro-rango input[type="date"] {
  padding: 8px 12px;
  border: 2px solid var(--border);
  border-radius: 8px;
  font-size: 13px;
  color: var(--text);
  background: var(--surface);
  cursor: pointer;
  min-width: 140px;
}

.filtro-rango input[type="date"]:hover {
  border-color: var(--primary);
}

.filtro-rango input[type="date"]:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.1);
}

.cal-icon {
  font-size: 16px;
}

.date-input {
  padding: 8px 12px;
  border: 2px solid var(--border);
  border-radius: 8px;
  font-size: 13px;
  color: var(--text);
  background: var(--surface);
  cursor: pointer;
  min-width: 140px;
}

.date-input:hover {
  border-color: var(--primary);
}

.date-input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.1);
}

.date-field {
  width: 100%;
  min-width: 180px;
  cursor: pointer;
}

.date-field::-webkit-calendar-picker-indicator {
  cursor: pointer;
  opacity: 0.6;
  font-size: 18px;
}

.date-field::-webkit-calendar-picker-indicator:hover {
  opacity: 1;
}

.calendar-group {
  position: relative;
}

.calendar-input-wrapper {
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 14px;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.calendar-input-wrapper:hover {
  border-color: var(--primary);
}

.cal-display {
  user-select: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.calendar-popup {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 200;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow-lg);
  padding: 12px;
  width: 280px;
  margin-top: 4px;
}

.cal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.cal-nav {
  background: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  width: 32px;
  height: 32px;
  font-size: 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text);
  transition: background 0.15s;
}

.cal-nav:hover {
  background: var(--bg);
}

.cal-title {
  font-weight: 700;
  font-size: 14px;
  color: var(--text);
}

.cal-weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
  margin-bottom: 4px;
}

.cal-weekdays span {
  text-align: center;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-light);
  padding: 4px 0;
}

.cal-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}

.cal-day {
  border: none;
  background: none;
  padding: 8px 0;
  font-size: 13px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--text);
  transition: background 0.15s;
  text-align: center;
}

.cal-day:hover:not(.empty):not(:disabled) {
  background: var(--bg);
}

.cal-day.selected {
  background: var(--primary);
  color: white;
  font-weight: 700;
}

.cal-day.empty {
  cursor: default;
}

/* Seccion Tabs */
.seccion-tabs button {
  padding: 14px 20px;
  border: none;
  background: none;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-light);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: all 0.2s;
}

.seccion-tabs button:hover {
  color: var(--primary);
}

.seccion-tabs button.active {
  color: var(--primary);
  border-bottom-color: var(--primary);
}

.tab-badge {
  background: var(--primary);
  color: white;
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 10px;
  margin-left: 6px;
  font-weight: 600;
}

/* Vendedor Tabs */
/*
 * Los vendedores, en una sola línea que rueda.
 *
 * Con `flex-wrap: wrap` diez vendedores ocupaban dos filas y quince ocuparían tres:
 * el bloque cambia de alto según cuántos haya y empuja la tabla hacia abajo cada vez
 * que se filtra por fecha y cambia la lista. Una línea que rueda mide siempre lo
 * mismo, y aquí hay diez vendedores por sucursal.
 *
 * El degradado del borde derecho es lo que dice que hay más a la derecha; sin él, en
 * una pantalla donde justo caben ocho, nadie va a probar a arrastrar.
 */
/* El degradado sólo del lado donde queda algo por ver. */
/* Venta Card */
.venta-card {
  border-bottom: 1px solid var(--border);
}

.venta-card:last-child {
  border-bottom: none;
}

.venta-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 24px;
  background: #fafbfc;
}

.venta-header h3 {
  flex: 1;
  font-size: 14px;
  font-weight: 600;
}

.venta-total {
  background: var(--success);
  color: white;
  padding: 4px 12px;
  border-radius: 20px;
  font-size: 13px;
  font-weight: 600;
}

.venta-clientes {
  background: #eef2ff;
  color: var(--primary);
  padding: 4px 12px;
  border-radius: 20px;
  font-size: 13px;
  font-weight: 600;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.clientes-mini {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--primary);
  font-weight: 600;
}

.clientes-total {
  color: var(--primary);
  font-weight: 600;
}

/* Empty State */
.empty-state {
  text-align: center;
  padding: 32px;
  color: var(--text-light);
}

.empty-state-large {
  text-align: center;
  padding: 64px 32px;
  background: var(--surface);
  border-radius: var(--radius);
  border: 1px solid var(--border);
}

.empty-icon {
  font-size: 48px;
  display: block;
  margin-bottom: 16px;
}

.empty-state-large h3 {
  font-size: 18px;
  margin-bottom: 8px;
  color: var(--text);
}

.empty-state-large p {
  color: var(--text-light);
}.detalle-titulo {
  padding: 4px 20px 8px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--primary);
}/* ==========================================================================
   EL DESLIZADOR DE SECCIONES

   En pantalla ancha son pestañas de toda la vida y las flechas no aparecen.
   En el móvil, dos pestañas con su icono, su texto y su contador no caben en
   360 px: se encogían hasta solaparse. Ahí pasan a ser un deslizador con
   flechas, que es lo que pidió Jose.
   ========================================================================== */

/**
 * El selector se queda pegado arriba al bajar.
 *
 * Es la única navegación que tiene la aplicación, y las tablas de ventas y almacén son
 * largas: sin esto hay que subir hasta el principio para cambiar de sección. En una vista
 * única eso es lo que más cansa.
 */
.seccion-tabs {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: stretch;
  gap: 0;
  padding: 0 24px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

/* La tarjeta que lleva el selector se queda sin cuerpo cuando la sección activa vive en
   otra tarjeta (Almacén, Ventas). Sin esto quedaría un borde suelto debajo de las
   pestañas, como una caja vacía. */
.card:has(> .seccion-tabs) .seccion-tabs {
  border-bottom: none;
}

.seccion-vacia {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 40px 20px;
  color: var(--text-light);
  text-align: center;
}

/*
 * Las flechas sólo existen en el móvil.
 *
 * Va calificada con `.seccion-tabs` a propósito: `.seccion-tabs button` —que pone las
 * pestañas en fila— pesa más que `.tab-flecha` a secas, así que el `display: none`
 * perdía y las dos flechas salían en escritorio, pequeñas y medio transparentes, a
 * los lados de las pestañas. Se veían como dos motas de suciedad en la pantalla.
 */
.seccion-tabs .tab-flecha {
  display: none;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  /* 44 px es el mínimo para que un dedo acierte sin pelearse. */
  width: 44px;
  /*
   * Sin este `padding: 0` la flecha se ve como una rayita.
   *
   * `.seccion-tabs button` —la regla de las pestañas— le mete 20 px de relleno a cada
   * lado, así que dentro de un botón de 44 px le quedaban 4 px al icono y el chevron
   * salía aplastado: 4 de ancho por 16 de alto.
   */
  padding: 0;
  border: none;
  background: none;
  color: var(--text-light);
  cursor: pointer;
}

/* Y que el icono no encoja aunque le falte sitio: antes se deformaba en silencio. */
.seccion-tabs .tab-flecha svg {
  flex: none;
}

.tab-flecha:disabled {
  opacity: 0.25;
  cursor: default;
}

.tabs-pista {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
}

/* Los puntitos también son sólo del móvil. */
.tabs-puntos {
  display: none;
  justify-content: center;
  gap: 6px;
  padding: 10px 0 2px;
}

.tabs-puntos span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--border);
  transition: background 0.2s, width 0.2s;
}

.tabs-puntos span.activo {
  width: 18px;
  border-radius: 3px;
  background: var(--primary);
}

/* ==========================================================================
   MÓVIL  (hasta 640 px)

   No había ni una `@media` en todo el fichero: el diseño era de escritorio y
   en el teléfono se rompía entero. Esto es lo mínimo para que se use de pie
   en la calle, que es donde se va a usar.
   ========================================================================== */

@media (max-width: 640px) {
  .main-content {
    /* 16 px de aire a los lados: menos, y el texto toca el borde del cristal. */
    padding: 16px 12px;
    gap: 16px;
  }

  /* --- La cabecera, en dos filas --- */
  .header-content {
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
    height: auto;
    padding: 12px 0;
  }

  .header-title h1 {
    font-size: 17px;
    line-height: 1.25;
  }

  .header-actions {
    display: flex;
    gap: 8px;
  }

  /* El botón principal ocupa lo que queda; el de refrescar, lo justo. */
  .header-actions .btn-lg {
    flex: 1 1 auto;
    justify-content: center;
  }

  .header-actions .ref-btn {
    flex: 0 0 44px;
    min-height: 44px;
  }

  /* --- Las secciones, una a una con flechas --- */
  .seccion-tabs {
    padding: 0 4px;
  }

  .seccion-tabs .tab-flecha {
    display: flex;
  }

  .tabs-puntos {
    display: flex;
  }

  .tabs-pista {
    /* Una sección a la vez, y el dedo también puede arrastrar. */
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    scrollbar-width: none;
  }

  .tabs-pista::-webkit-scrollbar {
    display: none;
  }

  .tabs-pista button {
    flex: 0 0 100%;
    scroll-snap-align: center;
    justify-content: center;
    /* Sin recortar el nombre: «Resumen por Vendedor» cabe entero si tiene la
       fila para él solo. */
    white-space: nowrap;
    padding: 14px 8px;
  }

  /* --- Las rejillas, a una columna --- */
  .stats-grid {
    /* `auto-fit` con 200 px de mínimo metía dos por fila y quedaban ilegibles. */
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .vendedor-grid {
    /* Era `minmax(340px, 1fr)`: en una pantalla de 360 px la tarjeta se salía. */
    grid-template-columns: 1fr;
    padding: 14px 12px;
    gap: 12px;
  }

  .form-row {
    grid-template-columns: 1fr;
    gap: 12px;
  }

  /* --- Las tablas, cada una con su propio desplazamiento --- */
  .table-wrapper,
  .tabla-scroll {
    overflow-x: auto;
    /* Que el dedo la deslice suave y no arrastre la página entera. */
    -webkit-overflow-scrolling: touch;
  }

  /* Las grandes van dentro de `.table-wrapper`, que ya rueda: se les pone un
     mínimo para que no se compriman hasta pisarse las columnas. */
  .data-table,
  .table-almacen {
    min-width: 520px;
  }  .card-header {
    flex-wrap: wrap;
    gap: 8px;
    padding: 14px 12px;
  }

  .card-header h2 {
    font-size: 16px;
  }

  /* --- Lo que se toca, que se pueda tocar --- */
  .btn,
  .seccion-tabs button {
    min-height: 44px;
  }

  input,
  select,
  textarea {
    /* Menos de 16 px hace que iOS dé un salto de zoom al enfocar el campo. */
    font-size: 16px;
    min-height: 44px;
  }
}

/* ==========================================================================
   MÓVIL ESTRECHO  (hasta 380 px)
   ========================================================================== */

@media (max-width: 380px) {
  .stats-grid {
    grid-template-columns: 1fr;
  }

  .header-title h1 {
    font-size: 15px;
  }
}

/* Quien haya pedido menos movimiento en su sistema, que no lo tenga. */
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}

/* ==========================================================================
   LA TARJETA DEL VENDEDOR

   Antes era una tabla de siete columnas dentro de una tarjeta de 340 px: las
   cifras cabían en 40 px cada una, las cabeceras salían partidas ("EN / PROC.") y
   el nombre del producto se rompía en cuatro líneas, de forma que cada fila medía
   lo que mide un párrafo para enseñar seis números.

   Ahora cada producto es una línea con su barra. La barra dice de un vistazo cómo
   va lo asignado —qué salió, qué salió con la factura cambiada, qué tiene pedido y qué
   no ha tocado nadie—; las cifras van debajo con su nombre escrito entero, que es
   lo que hacía falta para no tener que adivinar qué significaba "Cobr.".
   ========================================================================== */

.vendedor-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.vendedor-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}

.vendedor-avatar {
  flex: none;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--primary) 12%, transparent);
  color: var(--primary);
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.5px;
}

.vendedor-id {
  min-width: 0;
  flex: 1;
}

/* El nombre completo, sin recortar: son nombres de personas y hay que poder
   distinguir dos que empiezan igual. */
.vendedor-id h3 {
  font-size: 14px;
  font-weight: 650;
  line-height: 1.25;
  color: var(--text);
  overflow-wrap: anywhere;
}

.vendedor-id p {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-light);
  font-variant-numeric: tabular-nums;
}

.vendedor-avance {
  flex: none;
  font-size: 22px;
  font-weight: 700;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.vendedor-avance small {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-light);
  margin-left: 1px;
}

/* --- Los productos ------------------------------------------------------- */

.producto-lista {
  list-style: none;
  /* Se come el espacio que sobra, así el pie queda abajo del todo. */
  flex: 1;
}

.vendedor-pie {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
  background: color-mix(in srgb, var(--text-light) 4%, transparent);
  font-size: 11.5px;
  color: var(--text-light);
}

.vendedor-pie b {
  color: var(--text);
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

.pie-despachado b { color: var(--success); }
.pie-pendiente b { color: var(--purple); }

.pie-proceso b    { color: var(--warning); }

.producto {
  padding: 12px 16px 14px;
  border-bottom: 1px solid var(--border);
  transition: background 0.15s ease, box-shadow 0.15s ease;
}

.producto:hover {
  background: color-mix(in srgb, var(--text-light) 4%, transparent);
}

.producto:last-child {
  border-bottom: 0;
}

.producto.abierto {
  background: color-mix(in srgb, var(--primary) 6%, transparent);
  box-shadow: inset 3px 0 0 var(--primary);
}

.producto-cabeza {
  width: 100%;
  display: flex;
  align-items: baseline;
  gap: 10px;
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
  text-align: left;
  color: inherit;
  font: inherit;
}

.producto-cabeza:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 3px;
  border-radius: 4px;
}

.producto-nombre {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

/* Lo despachado sobre lo asignado: la cifra que resume la fila. */
.producto-cifra {
  flex: none;
  font-size: 13px;
  color: var(--text-light);
  font-variant-numeric: tabular-nums;
}

.producto-cifra b {
  font-size: 15px;
  color: var(--text);
}

.producto-cifra .de {
  margin: 0 1px;
  opacity: 0.5;
}

.producto-flecha {
  flex: none;
  color: var(--text-light);
  transition: transform 0.15s ease;
  align-self: center;
}

.producto.abierto .producto-flecha {
  transform: rotate(90deg);
}

/* --- La barra ------------------------------------------------------------ */

.barra {
  display: flex;
  height: 7px;
  margin-top: 9px;
  border-radius: 99px;
  overflow: hidden;
  /* El fondo se ve sólo si los tramos no llegan a llenarla, que es justo lo que
     hay que notar. */
  background: var(--border);
}

.tramo {
  height: 100%;
  /*
   * Los tramos se mueven al cambiar los datos.
   *
   * La pantalla se refresca sola: sin esto, un pedido que entra hace que la barra
   * salte de una posición a otra entre dos fotogramas y no se ve QUÉ cambió. Con el
   * movimiento se ve el tramo verde avanzar, que es justo la noticia.
   */
  transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.t-despachado { background: var(--success); }
.t-exceso     { background: var(--purple); }
.t-libre      { background: transparent; }

/* --- Las cifras, con su nombre entero ------------------------------------ */

.marcas {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: 9px;
}

.marca {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--text-light);
  white-space: nowrap;
}

/* El punto de color es lo que ata cada cifra con su tramo de la barra. Sin él la
   barra es decoración y los números vuelven a ser una lista. */
.marca::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  flex: none;
}

.marca b {
  color: var(--text);
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

.m-despachado { color: var(--success); }
.m-libre      { color: var(--text-light); }
.m-demas      { color: var(--purple); }
/* --- El detalle de los pedidos ------------------------------------------- */

.detalle {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--border);
}

.detalle-aviso {
  font-size: 12px;
  color: var(--text-light);
  padding: 4px 0;
}

.detalle-titulo {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--text-light);
  margin-bottom: 8px;
}

.pedido-lista {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/*
 * Rejilla y no tabla: una tabla de cinco columnas dentro de una tarjeta estrecha
 * vuelve al problema de partida. Aquí el folio y los packs mandan, el cliente se
 * queda con lo que sobra y los sellos caen a la línea de abajo cuando no caben.
 */
.pedido {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 2px 8px;
  align-items: baseline;
  font-size: 12px;
}

.pedido-folio {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 11.5px;
  font-weight: 600;
}

.pedido-cliente {
  color: var(--text-light);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pedido-packs {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.pedido-packs::after {
  content: ' packs';
  font-weight: 400;
  font-size: 10.5px;
  color: var(--text-light);
}

.pedido-fecha {
  grid-column: 1;
  font-size: 11px;
  color: var(--text-light);
  font-variant-numeric: tabular-nums;
}

.pedido-estado {
  grid-column: 2 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.sello {
  font-size: 10.5px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 99px;
  border: 1px solid;
  white-space: nowrap;
}

.s-facturado {
  color: var(--primary);
  border-color: color-mix(in srgb, var(--primary) 35%, transparent);
  background: color-mix(in srgb, var(--primary) 8%, transparent);
}

/* Facturó y cambió: hubo factura, pero no de lo que se pidió. Ni verde ni rojo. */
.s-cambiado {
  color: #7c3aed;
  border-color: color-mix(in srgb, var(--purple) 40%, transparent);
  background: color-mix(in srgb, var(--purple) 10%, transparent);
}

.s-cerrado {
  color: #991b1b;
  border-color: color-mix(in srgb, var(--danger) 40%, transparent);
  background: color-mix(in srgb, var(--danger) 9%, transparent);
}

.s-proceso {
  color: #92400e;
  border-color: color-mix(in srgb, var(--warning) 40%, transparent);
  background: color-mix(in srgb, var(--warning) 10%, transparent);
}

/* Lo que declara el vendedor y lo que se marcó a mano van sin relleno: se ven,
   pero no compiten con el hecho de que haya factura. */
.s-cobrado,
.s-manual {
  color: var(--text-light);
  border-color: var(--border);
  background: none;
}

/* ==========================================================================
   LA VENTANA DEL DETALLE

   Ventana centrada en escritorio, cajón que sube desde abajo en el móvil. La regla
   de la casa en todos los proyectos de Procovar.

   La ✕ está siempre visible, pegada arriba mientras la lista rueda por debajo: en
   una lista larga, si la ✕ se va con el desplazamiento hay que subir a buscarla
   para poder cerrar.
   ========================================================================== */

.capa {
  position: fixed;
  inset: 0;
  /* `dvh` y no `vh`: en el móvil la barra del navegador aparece y desaparece, y con
     `vh` el cajón se queda cortado por debajo del borde justo cuando la barra está. */
  height: 100dvh;
  z-index: 200;
  background: rgba(15, 23, 42, 0.45);
  display: grid;
  place-items: center;
  padding: 24px;
}

/* El asa no pinta nada en una ventana de escritorio. */
.hoja-asa {
  display: none;
}

.hoja {
  background: var(--surface);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  width: min(560px, 100%);
  /* Tope de alto: la lista rueda por dentro y la ventana no se come la pantalla. */
  max-height: min(70vh, 640px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.hoja-cabeza {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
  flex: none;
}

.hoja-quien {
  flex: 1;
  min-width: 0;
}

.hoja-quien p {
  font-size: 14px;
  font-weight: 650;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.hoja-vendedor {
  margin-top: 2px;
  font-size: 12px;
  font-weight: 500 !important;
  color: var(--text-light);
}

.hoja-cerrar {
  flex: none;
  /* 40 px: la ✕ es lo que más se toca de una ventana y tiene que acertarse. */
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: none;
  color: var(--text-light);
  cursor: pointer;
}

.hoja-cerrar:hover {
  background: var(--bg);
  color: var(--text);
}

.hoja-cerrar:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}

.hoja-cuerpo {
  padding: 14px 16px 18px;
  overflow-y: auto;
}

/*
 * El formulario necesita más ancho que el detalle: lleva tres campos en fila y una
 * rejilla de vendedores que en 560 px se quedaría en una sola columna.
 */
.hoja-ancha {
  width: min(860px, 100%);
  max-height: min(85vh, 760px);
}

/* ==========================================================================
   EL FORMULARIO SALE DEL BOTÓN, NO DEL CENTRO

   Una ventana en mitad de la pantalla no dice de dónde viene: se abre lejos de donde
   pulsaste y hay que volver a buscar el hilo. Este panel cae justo debajo de "Nueva
   Asignación", pegado a la derecha como el botón, así que la relación entre lo que
   pulsas y lo que se abre se ve sola.

   El velo de detrás es más suave que el del detalle: aquí no hace falta apagar la
   página, sólo dejar claro que lo de delante manda.

   En el móvil esto NO aplica: allí sigue siendo cajón, porque un panel colgado de un
   botón en 360 px es una ventana pegada a los cuatro bordes.
   ========================================================================== */

.capa-desde-boton {
  place-items: start end;
  /* 80 px = la cabecera (72) más un respiro, para que el panel no la tape. */
  padding: 80px 24px 24px;
  background: rgba(15, 23, 42, 0.28);
}

.capa-desde-boton .hoja {
  /* Crece hacia abajo desde su esquina, que es donde está el botón. */
  transform-origin: top right;
}


@media (max-width: 640px) {
  /* Cajón, como todo lo demás en el móvil. */
  .capa-desde-boton {
    place-items: end stretch;
    padding: 0;
  }
}

/* --- En el móvil, cajón ---------------------------------------------------
   Una ventana centrada en una pantalla de 360 px queda pegada a los cuatro bordes
   y el pulgar no llega arriba del todo. El cajón sube desde donde está la mano. */
@media (max-width: 640px) {
  .capa {
    padding: 0;
    place-items: end stretch;
  }

  .hoja {
    width: 100%;
    max-height: 85dvh;
    /*
     * Un mínimo, porque un cajón de 110 px con dos líneas dentro parece un trozo de
     * algo asomando por el borde y no una hoja que ha subido.
     */
    min-height: 200px;
    border-radius: 16px 16px 0 0;
    padding-bottom: env(safe-area-inset-bottom);
  }

  .hoja-asa {
    display: block;
    width: 40px;
    height: 4px;
    margin: 8px auto 0;
    border-radius: 99px;
    background: var(--border);
    flex: none;
  }

  .hoja-cabeza {
    position: sticky;
    top: 0;
    background: var(--surface);
  }
}

/* ==========================================================================
   ABRIR Y CERRAR

   Antes sólo había entrada, y sólo en el móvil: la ventana de escritorio aparecía de
   golpe y las dos desaparecían de golpe. Cerrar sin animación es lo que más se nota,
   porque el ojo se queda buscando dónde estaba lo que había.

   El fondo se atenúa y la hoja crece un pelo desde el centro; en el móvil, sube y baja
   por donde entró. Los tiempos son cortos a propósito -180 ms al abrir, 140 al
   cerrar-: esto se usa decenas de veces al día y una animación lenta se vuelve un
   peaje.
   ========================================================================== */

.ventana-enter-active {
  transition: opacity 0.18s ease;
}

.ventana-leave-active {
  transition: opacity 0.14s ease;
}

.ventana-enter-from,
.ventana-leave-to {
  opacity: 0;
}

.ventana-enter-active .hoja {
  transition: transform 0.18s cubic-bezier(0.2, 0.9, 0.3, 1);
}

.ventana-leave-active .hoja {
  transition: transform 0.14s ease-in;
}

.ventana-enter-from .hoja,
.ventana-leave-to .hoja {
  transform: scale(0.96);
}

@media (max-width: 640px) {
  /* En el cajón no vale encoger: entra y sale por abajo, por donde vino. */
  .ventana-enter-from .hoja,
  .ventana-leave-to .hoja {
    transform: translateY(100%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ventana-enter-active,
  .ventana-leave-active,
  .ventana-enter-active .hoja,
  .ventana-leave-active .hoja {
    transition: none;
  }

  .ventana-enter-from .hoja,
  .ventana-leave-to .hoja {
    transform: none;
  }
}

/*
 * Las columnas de esta tabla no se aprietan más de la cuenta: por debajo de su ancho
 * mínimo la caja rueda. Es preferible arrastrar a leer "PARRANDA / 500 / ML / BLISTER
 * / 6U" en cinco líneas.
 */
.tabla-vendedor {
  min-width: 480px;
}

.tabla-vendedor td:first-child,
.tabla-vendedor th:first-child {
  min-width: 190px;
}

/* ==========================================================================
   VENTAS: ELEGIR VENDEDOR

   Dos columnas en pantalla ancha —la lista y el detalle—, una sola columna con un
   desplegable del teléfono cuando no hay sitio. El corte está en 900 px: por debajo,
   240 px de lista dejan la tabla en menos de 600 y las columnas se aprietan.
   ========================================================================== */

.ventas-cuerpo {
  display: grid;
  grid-template-columns: 250px minmax(0, 1fr);
}

.ventas-lado {
  border-right: 1px solid var(--border);
  padding: 14px 0 14px 12px;
  /*
   * Alto FIJO, no `max-height`.
   *
   * Con un máximo, la columna se estiraba hasta lo que midiera el detalle de al lado:
   * "Todos" es una matriz de once columnas y un vendedor con tres productos ocupa un
   * tercio, así que al cambiar de vendedor la lista crecía o encogía, le aparecía o
   * le desaparecía su barra, y los nombres se movían solos. Fija, la lista es el
   * punto quieto de la pantalla: lo único que cambia es lo que se mira.
   */
  height: 520px;
  overflow-y: auto;
  /* Y el hueco de su barra reservado, por lo mismo que en la página entera: sin esto
     los nombres se desplazan 9 px en cuanto la lista deja de necesitar barra. */
  scrollbar-gutter: stable;
}

.lado-etiqueta {
  display: block;
  padding: 0 12px 8px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--text-light);
}

/* El desplegable es sólo para pantallas estrechas. */
.lado-select {
  display: none;
}

.lado-lista {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.lado-lista button {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 0;
  background: none;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
}

.lado-lista button {
  transition: background 0.14s ease, color 0.14s ease;
}

.lado-lista button:hover {
  background: var(--bg);
}

.lado-lista button.active {
  background: color-mix(in srgb, var(--primary) 10%, transparent);
  color: var(--primary);
  font-weight: 600;
}

.lado-lista button:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: -2px;
}

.lado-inicial {
  flex: none;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--primary) 12%, transparent);
  color: var(--primary);
  font-size: 10px;
  font-weight: 700;
}

/* El nombre cede sitio al importe, que es lo que no puede cortarse. */
.lado-nombre {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lado-importe {
  flex: none;
  font-size: 11.5px;
  color: var(--text-light);
  font-variant-numeric: tabular-nums;
}

.lado-lista button.active .lado-importe {
  color: var(--primary);
}

.ventas-detalle {
  min-width: 0;
}

/* --- Estrecho: una columna y desplegable ---------------------------------- */
@media (max-width: 900px) {
  .ventas-cuerpo {
    grid-template-columns: minmax(0, 1fr);
  }

  .ventas-lado {
    border-right: 0;
    border-bottom: 1px solid var(--border);
    padding: 12px 16px;
    /* Aquí no hay lista, sólo el desplegable: el alto fijo de la columna dejaría una
       franja de 520 px con un control dentro. */
    height: auto;
    max-height: none;
    overflow: visible;
    scrollbar-gutter: auto;
  }

  .lado-etiqueta {
    padding: 0 0 6px;
  }

  .lado-select {
    display: block;
    width: 100%;
    /* 44 px: es un control que se toca con el dedo. */
    min-height: 44px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 13px;
  }

  .lado-lista {
    display: none;
  }
}

/* ==========================================================================
   EL SELECTOR DE SECCIÓN, DISTINTO EN CADA TAMAÑO

   No es el mismo control estirado tres veces: en cada ancho hay sitio para cosas
   distintas y conviene aprovecharlo.

     móvil     deslizador de una sección, con flechas y puntos
     tableta   control segmentado: las cuatro a la vez, compactas, en una cápsula
     pantalla  pestañas con subrayado, icono, nombre y contador

   El móvil está definido más abajo, en su corte de 640. Aquí van las otras dos.
   ========================================================================== */

/* --- Tableta: control segmentado (641–1024) ------------------------------- */
@media (min-width: 641px) and (max-width: 1024px) {
  .seccion-tabs {
    padding: 10px 16px;
    /* La cápsula ya separa el control de lo de abajo; la raya sobraba. */
    border-bottom: 1px solid var(--border);
  }

  .tabs-pista {
    gap: 2px;
    padding: 3px;
    background: var(--bg);
    border-radius: 10px;
  }

  .seccion-tabs button {
    flex: 1 1 0;
    justify-content: center;
    padding: 9px 8px;
    font-size: 13px;
    border-bottom: 0;
    margin-bottom: 0;
    border-radius: 8px;
  }

  .seccion-tabs button.active {
    background: var(--surface);
    color: var(--primary);
    font-weight: 650;
    box-shadow: var(--shadow);
  }

  /* En la cápsula el contador va en gris: con cuatro chapas azules seguidas no se
     distingue cuál es la sección elegida. */
  .tabs-pista .tab-badge {
    background: color-mix(in srgb, var(--text-light) 20%, transparent);
    color: var(--text);
  }

  .seccion-tabs button.active .tab-badge {
    background: var(--primary);
    color: #fff;
  }
}

/* --- Pantalla ancha: pestañas con subrayado (≥1025) ----------------------- */
@media (min-width: 1025px) {
  .seccion-tabs button {
    padding: 15px 22px;
    font-size: 14px;
  }

  /* El subrayado crece desde el centro al pasar por encima: dice qué se va a pulsar
     antes de pulsarlo, sin mover nada de sitio. */
  .seccion-tabs button::after {
    content: '';
    position: absolute;
    left: 50%;
    right: 50%;
    bottom: -1px;
    height: 2px;
    background: var(--primary);
    transition: left 0.18s ease, right 0.18s ease;
  }

  .seccion-tabs button {
    position: relative;
    border-bottom-color: transparent !important;
  }

  .seccion-tabs button:hover::after {
    left: 22px;
    right: 22px;
    background: var(--border);
  }

  .seccion-tabs button.active::after {
    left: 0;
    right: 0;
    background: var(--primary);
  }
}

@media (prefers-reduced-motion: reduce) {
  .seccion-tabs button::after {
    transition: none;
  }
}

.detalle-fallo {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 22px 10px;
  text-align: center;
  color: var(--danger);
}

.detalle-fallo p {
  font-size: 13px;
  color: var(--text-light);
}

.btn-reintentar {
  padding: 8px 18px;
  min-height: 40px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.btn-reintentar:hover {
  border-color: var(--primary);
  color: var(--primary);
}

/* --- El cruce al cambiar de vendedor -------------------------------------- */

.cambio-enter-active,
.cambio-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}

.cambio-enter-from {
  opacity: 0;
  /* Entra desde abajo, muy poco: lo justo para que se lea como que ha cambiado y no
     como que ha parpadeado. Más recorrido y ya parece que la página se mueve. */
  transform: translateY(6px);
}

.cambio-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

@media (prefers-reduced-motion: reduce) {
  .cambio-enter-active,
  .cambio-leave-active {
    transition: none;
  }

  .cambio-enter-from,
  .cambio-leave-to {
    transform: none;
  }
}

/* Las secciones se apilan igual que lo hacía `main`, para no perder la separación
   cuando una sección enseña dos bloques (el aviso de vacío y su tarjeta). */
.seccion-contenido {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.seccion-enter-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.seccion-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

@media (prefers-reduced-motion: reduce) {
  .seccion-enter-active {
    transition: none;
  }

  .seccion-enter-from {
    transform: none;
  }

  /* La regla general, por si se escapa alguna: quien pidió que no se mueva nada, que
     no se le mueva nada. */
  .tramo,
  .producto,
  .lado-lista button,
  .producto-flecha {
    transition: none;
  }
}

/* --- Paginación ----------------------------------------------------------- */

.fila-num {
  width: 1%;
  white-space: nowrap;
  color: var(--text-light);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
}

.paginacion {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 18px;
  padding: 12px 20px;
  border-top: 1px solid var(--border);
  font-size: 12.5px;
  color: var(--text-light);
}

.pag-cuenta {
  font-variant-numeric: tabular-nums;
}

.pag-cuantas {
  display: flex;
  align-items: center;
  gap: 6px;
  /* Empuja los pasos al otro extremo. */
  margin-left: auto;
}

.pag-cuantas select {
  min-height: 34px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
}

.pag-pasos {
  display: flex;
  align-items: center;
  gap: 4px;
}

.pag-pasos button {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  transition: border-color 0.14s ease, color 0.14s ease;
}

.pag-pasos button:hover:not(:disabled) {
  border-color: var(--primary);
  color: var(--primary);
}

.pag-pasos button:disabled {
  opacity: 0.4;
  cursor: default;
}

.pag-donde {
  padding: 0 6px;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 640px) {
  .paginacion {
    padding: 12px 16px;
  }

  /* En el móvil manda el paso de página; el "por página" cae debajo. */
  .pag-cuantas {
    margin-left: 0;
    order: 3;
  }

  .pag-pasos {
    margin-left: auto;
  }
}

.cabecera-derecha {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.elegir-mes {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 4px 0 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text-light);
  min-height: 36px;
}

.elegir-mes select {
  border: 0;
  background: none;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  min-height: 34px;
  padding-right: 4px;
  cursor: pointer;
}

.elegir-mes select:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
  border-radius: 6px;
}

/* --- Pedido contra factura ------------------------------------------------ */

.cotejo {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 5px;
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
  font-size: 11.5px;
  color: var(--text-light);
}

.cotejo b {
  color: var(--text);
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

.cotejo-flecha {
  opacity: 0.5;
}

/* La diferencia es lo que se mira, así que pesa más que el resto de la línea. */
.cotejo-dif {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--purple);
}

.dif-menos {
  color: var(--warning);
}

.cotejo-igual {
  color: var(--success);
  font-weight: 600;
}

/* Las cifras del producto dentro de la ventana de detalle. */
.cifras {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px 16px;
  margin-bottom: 16px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border);
}

.cifras dt {
  font-size: 11px;
  color: var(--text-light);
  line-height: 1.3;
}

.cifras dt small {
  display: block;
  font-size: 10px;
  opacity: 0.75;
}

.cifras dd {
  font-size: 18px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  margin-top: 2px;
}

.c-verde  { color: var(--success); }
.c-morado { color: var(--purple); }
.c-ambar  { color: #b45309; }
.c-rojo   { color: var(--danger); }

.detalle-paginas {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-light);
  font-variant-numeric: tabular-nums;
}

.detalle-paginas button {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
}

.detalle-paginas button:disabled {
  opacity: 0.4;
  cursor: default;
}

/*
 * Cuándo se calculó lo que se está viendo.
 *
 * Chapa, no texto suelto: el fondo translúcido la ata visualmente al botón de actualizar
 * que tiene al lado, y el punto verde dice de un vistazo que esto está vivo. Informa sin
 * competir con «Nueva Asignación», que es la acción de verdad de la cabecera.
 */
.frescura {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  height: 40px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.14);
  color: rgba(255, 255, 255, 0.92);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}

.frescura-punto {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--success-light);
  flex: none;
}

@media (max-width: 640px) {
  /* En el móvil la cabecera ya va apretada: la chapa baja a su propia línea, centrada. */
  .frescura {
    order: 3;
    flex: 1 1 100%;
    justify-content: center;
    height: 32px;
  }
}

/* ==========================================================================
   LOS TAMAÑOS, DE PEQUEÑO A GRANDE

   Los cortes no son números redondos por gusto: cada uno es el punto donde algo
   concreto deja de caber o empieza a sobrar sitio.

     ≤ 380   teléfono estrecho: una columna para todo
     ≤ 640   teléfono: el selector pasa a deslizador, las tablas ruedan
     ≤ 900   tableta de pie: dos columnas
     ≤ 1280  tableta apaisada y portátil pequeño: el diseño de siempre
     ≥ 1440  monitor grande: el contenido crece en vez de dejar los lados vacíos
     ≥ 1800  monitor muy ancho: tope, que una línea de texto larguísima no se lee

   Y aparte, la pantalla BAJA (teléfono tumbado), que no es cuestión de ancho.
   ========================================================================== */

:root {
  --ancho: 1200px;
}

/* --- Tableta de pie: 641–900 -------------------------------------------- */
@media (min-width: 641px) and (max-width: 900px) {
  .main-content {
    padding: 20px 16px;
  }

  .stats-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .vendedor-grid {
    /* Dos caben con holgura; tres se quedarían en 210 px y el nombre del producto
       no entra. */
    grid-template-columns: repeat(2, minmax(0, 1fr));
    padding: 16px;
  }

  .form-row {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

/* --- Portátil: 901–1280 -------------------------------------------------- */
@media (min-width: 901px) and (max-width: 1280px) {
  .main-content {
    padding: 24px 20px;
  }

  .vendedor-grid {
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  }
}

/* --- Monitor grande: desde 1440 ------------------------------------------ */
@media (min-width: 1440px) {
  :root {
    --ancho: 1440px;
  }

  .stats-grid {
    /* Las cuatro cifras en una fila: es un resumen, se lee de un vistazo o no sirve. */
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .vendedor-grid {
    gap: 20px;
    padding: 24px;
  }
}

/* --- Monitor muy ancho: desde 1800 --------------------------------------- */
@media (min-width: 1800px) {
  :root {
    /* Tope. Más ancho y una fila de tabla se vuelve imposible de seguir con la vista
       de un extremo al otro. */
    --ancho: 1680px;
  }

  .vendedor-grid {
    grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  }
}

/* --- Teléfono tumbado ----------------------------------------------------
   No es cuestión de ancho sino de ALTO: en apaisado quedan ~350 px de alto, y
   una cabecera de 72 px más el selector se comen la mitad de la pantalla. */
@media (max-height: 500px) and (orientation: landscape) {
  .app-header {
    position: static;
  }

  .header-content {
    flex-direction: row;
    align-items: center;
    height: auto;
    padding: 8px 0;
  }

  .header-title h1 {
    font-size: 15px;
  }

  .header-title .subtitle {
    display: none;
  }

  .main-content {
    padding: 12px;
    gap: 12px;
  }

  .seccion-tabs button {
    padding: 8px 10px;
  }
}

/* --- Imprimir ------------------------------------------------------------
   Alguien va a querer llevarse el resumen en papel al almacén. */
@media print {
  .app-header,
  .seccion-tabs,
  .tabs-puntos,
  .header-actions,
  .btn {
    display: none !important;
  }

  .card {
    box-shadow: none;
    border: 1px solid #ccc;
    break-inside: avoid;
  }

  .main-content {
    max-width: none;
    padding: 0;
  }
}
</style>
