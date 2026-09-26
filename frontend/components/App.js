'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import AppIcon from './AppIcon'
import Transition from './Transition'
import { API_URL } from '../lib/api'
import {
  afinesDe,
  avanceDe,
  hoyEnCuba,
  importeDe,
  inicialesDe,
  mesEnCurso,
  nombreCorto,
  nombreCortoVendedor,
  nombreDelMes,
  totalesDe,
  tramosDe,
} from '../lib/datos'

/**
 * Las secciones, en una lista.
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

const POR_PAGINA = [25, 50, 100, 0]
const POR_PAGINA_DETALLE = 10
const DETALLE_FRESCO_MS = 60 * 1000

export default function App() {
  // Estado de los datos
  const [vendedores, setVendedores] = useState([])
  const [resumen, setResumen] = useState([])
  /**
   * Líneas de pedidos cuyo nombre NO encaja con ningún producto de Ventra.
   *
   * El servidor no las suma en ninguna parte, así que sin este aviso no hay forma de
   * enterarse: la fila no existe y el pedido se ve «por despachar» en ninguna parte.
   */
  const [sinCasar, setSinCasar] = useState([])
  const [ventas, setVentas] = useState([])
  const [asignaciones, setAsignaciones] = useState([])
  const [almacen, setAlmacen] = useState([])
  const [totalesAlmacen, setTotalesAlmacen] = useState({ productos: 0, unidades: 0, valor: 0 })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // Vendedor seleccionado para filtrar
  const [vendedorSeleccionado, setVendedorSeleccionado] = useState('')

  // Filtro de fecha para ventas: 'hoy', 'mes', 'rango'
  const [filtroPreset, setFiltroPreset] = useState('mes')
  const [filtroFechaDesde, setFiltroFechaDesde] = useState('')
  const [filtroFechaHasta, setFiltroFechaHasta] = useState('')

  const [seccionActiva, setSeccionActiva] = useState('resumen')

  /**
   * El día de hoy y el mes de la cabecera se calculan al MONTAR, no al pintar.
   *
   * Next pinta la página en el servidor (o al construir, con `output: 'export'`) y el
   * navegador vuelve a pintarla: si el texto dependiera de `new Date()` en cada
   * render, el HTML guardado y el del navegador podrían no coincidir y React
   * protestaría. Vacío en el primer pintado y lleno enseguida.
   */
  const [fechaHoy, setFechaHoy] = useState('')
  const [mesCabecera, setMesCabecera] = useState('')

  const [filtroMes, setFiltroMes] = useState('')
  const [mesesDisponibles, setMesesDisponibles] = useState([])

  const [porPagina, setPorPagina] = useState(25)
  const [pagina, setPagina] = useState(1)

  // Formulario de nueva asignación
  const [nuevaAsignacion, setNuevaAsignacion] = useState({ producto: '', cantidad: 0, fecha: '' })
  const [vendedoresSeleccionados, setVendedoresSeleccionados] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [showCalendar, setShowCalendar] = useState(false)
  const [showCalRango, setShowCalRango] = useState(false)
  const [calObjetivo, setCalObjetivo] = useState('desde')
  const [calMonth, setCalMonth] = useState(new Date().getMonth())
  const [calYear, setCalYear] = useState(new Date().getFullYear())
  const [rangoTmpDesde, setRangoTmpDesde] = useState('')
  const [rangoTmpHasta, setRangoTmpHasta] = useState('')

  /**
   * Lo que se acaba de hacer, enseñado en pantalla.
   *
   * Guardar una asignación cerraba el formulario y punto: si el servidor contestaba
   * bien no había forma de saberlo, y si contestaba mal sólo un `alert`, que en el
   * móvil sale encima de todo y se cierra sin leerse. Esto es un aviso que se va solo,
   * dice QUÉ se guardó y CUÁNTAS veces, y no interrumpe.
   */
  const [nota, setNota] = useState(null)
  /** Cuánto lleva de la tanda de peticiones de `crearAsignacion`, o `null` si no hay. */
  const [guardando, setGuardando] = useState(null)
  const relojNota = useRef(null)
  /**
   * Corta el doble envío de verdad.
   *
   * `guardando` es estado y tarda un pintado en existir: dos Enter seguidos en el
   * mismo fotograma lo ven todavía en `null` y lanzarían la tanda dos veces. Un ref
   * se pone en el mismo instante.
   */
  const enviandoRef = useRef(false)

  const [cargandoAlmacen, setCargandoAlmacen] = useState(false)
  const [actualizado, setActualizado] = useState(null)
  const [ahora, setAhora] = useState(Date.now())

  // Detalle de pedidos en proceso
  const [detalleProceso, setDetalleProceso] = useState([])
  const [filaExpandida, setFilaExpandida] = useState(null)
  /** De qué vendedor y producto es el detalle que está abierto. */
  const [detalleDe, setDetalleDe] = useState(null)
  const [loadingDetalle, setLoadingDetalle] = useState(false)
  /** Qué falló al traer el detalle, para poder decirlo y ofrecer reintentar. */
  const [errorDetalle, setErrorDetalle] = useState(null)
  const [paginaDetalle, setPaginaDetalle] = useState(1)

  /**
   * Lo que un manejador guardado de una vez necesita saber del estado.
   *
   * El `EventSource` y los `addEventListener` se abren UNA vez, al montar, y viven
   * hasta que la pestaña se cierra: si leyeran el estado del render en el que se
   * crearon, seguirían viendo el de la primera carga (`mesElegido` vacío, sin
   * vendedores). Espejo actualizado en cada pintada.
   */
  const refEstado = useRef({ primeraRondaDeMes: true, primeraSeccion: true })
  useEffect(() => {
    refEstado.current = {
      mesElegido: filtroMes,
      showCalendar,
      showCalRango,
      showForm,
      filaExpandida,
      detalleProceso,
    }
  })

  const pistaSecciones = useRef(null)
  const detalleTraidoEn = useRef(0)
  const desplazamientoAnterior = useRef('')

  /* ------------------------------------------------------------------ datos */

  const cargarAsignaciones = useCallback(async () => {
    try {
      const mes = refEstado.current.mesElegido ? `?mes=${refEstado.current.mesElegido}` : ''
      const r = await axios.get(`${API_URL}/asignaciones${mes}`)
      // `|| []` y no a secas: si la respuesta no trae la lista -un proxy que devuelve
      // otra cosa, la API a medio desplegar- esto dejaba `asignaciones` en `undefined` y
      // el contador de la pestaña reventaba la pantalla ENTERA, no sólo esta sección.
      setAsignaciones(r.data?.asignaciones || [])
      setPagina(1)
    } catch (e) {
      console.error('Error al cargar asignaciones:', e)
    }
  }, [])

  const cargarMeses = useCallback(async () => {
    try {
      const r = await axios.get(`${API_URL}/asignaciones/meses`)
      setMesesDisponibles(r.data.meses || [])
      if (!refEstado.current.mesElegido) setFiltroMes(r.data.actual)
    } catch (e) {
      console.error('Error al cargar los meses:', e)
    }
  }, [])

  const cargarAlmacen = useCallback(async () => {
    setCargandoAlmacen(true)
    try {
      const r = await axios.get(`${API_URL}/almacen`)
      setAlmacen(r.data?.productos || [])
      setTotalesAlmacen(r.data?.totales || { productos: 0, unidades: 0, valor: 0 })
    } catch (e) {
      console.error('Error al cargar almacén:', e)
    } finally {
      setCargandoAlmacen(false)
    }
  }, [])

  const cargarResumen = useCallback(async () => {
    try {
      const r = await axios.get(`${API_URL}/resumen`)
      setResumen(r.data.resumen)
      setSinCasar(r.data.sin_casar || [])
    } catch (e) {
      console.error('Error al cargar resumen:', e)
    }
  }, [])

  const cargarEstado = useCallback(async () => {
    try {
      const r = await axios.get(`${API_URL}/eventos/estado`)
      const fechas = Object.values(r.data?.calculado || {}).filter(Boolean)

      // La más vieja de las tres: es la que manda para decir «esto es de hace…».
      setActualizado(fechas.length ? fechas.sort()[0] : null)
    } catch {
      setActualizado(null)
    }
  }, [])

  const cargarDatos = useCallback(async () => {
    setLoading(true)
    setError(null)
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
      const [rDashboard, rVendedores] = await Promise.all([
        axios.get(`${API_URL}/dashboard`),
        axios.get(`${API_URL}/vendedores`),
      ])
      void cargarAlmacen()
      const listaResumen = rDashboard.data?.resumen || []
      const listaVentas = rDashboard.data?.ventas || []
      setResumen(listaResumen)
      setSinCasar(rDashboard.data?.sin_casar || [])
      setVentas(listaVentas)
      /*
       * El panel siempre trae las del mes EN CURSO. Si estás mirando otro mes, esto te
       * cambiaría la lista debajo de las manos —y con el selector diciendo "Agosto"—, así
       * que en ese caso se vuelve a pedir el mes que elegiste.
       */
      if (!refEstado.current.mesElegido || refEstado.current.mesElegido === mesEnCurso()) {
        setAsignaciones(rDashboard.data?.asignaciones || [])
      } else {
        await cargarAsignaciones()
      }
      setVendedores(rVendedores.data?.vendedores || [])
      void cargarMeses()
      void cargarEstado()

      // Seleccionar primer vendedor por defecto en ventas
      const unicos = [...new Set(listaVentas.map((v) => v.vendedor))]
      if (unicos.length > 0) setVendedorSeleccionado(unicos[0])
    } catch (e) {
      setError('Error al cargar datos: ' + (e.message || e))
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [cargarAlmacen, cargarAsignaciones, cargarMeses, cargarEstado])

  /** Trae los pedidos sin despachar, con tope de 20 segundos y frescura de un minuto. */
  const traerDetalle = useCallback(async (forzar = false) => {
    const viejo = Date.now() - detalleTraidoEn.current > DETALLE_FRESCO_MS
    if (!forzar && refEstado.current.detalleProceso?.length > 0 && !viejo) return

    setLoadingDetalle(true)
    setErrorDetalle(null)
    try {
      const r = await axios.get(`${API_URL}/detalle-proceso`, { timeout: 20000 })
      setDetalleProceso(r.data.detalle || [])
      detalleTraidoEn.current = Date.now()
    } catch (e) {
      console.error('Error cargando detalle:', e)
      // Se dice qué pasó y se deja reintentar: un cartel eterno no informa de nada.
      setErrorDetalle(
        e.code === 'ECONNABORTED'
          ? 'El servidor tardó demasiado en responder.'
          : 'No se pudo cargar el detalle.'
      )
    } finally {
      setLoadingDetalle(false)
    }
  }, [])

  /* ------------------------------------------------------ pintadas que cambian */

  /**
   * El mes en curso en Cuba, igual que lo calcula el servidor, para la cabecera.
   *
   * Se calcula al montar por lo mismo que `fechaHoy`: el HTML construido y el del
   * navegador tienen que coincidir.
   */
  useEffect(() => {
    setMesCabecera(nombreDelMes(mesEnCurso()))
    // Hoy EN CUBA, no en UTC: `toISOString()` a las 20:30 de La Habana ya da mañana.
    const hoy = hoyEnCuba()
    setFechaHoy(hoy)
    setNuevaAsignacion((a) => (a.fecha ? a : { ...a, fecha: hoy }))
  }, [])

  /** «hace 2 minutos». Se recalcula solo porque `ahora` avanza cada 30 segundos. */
  useEffect(() => {
    const id = setInterval(() => setAhora(Date.now()), 30000)
    return () => clearInterval(id)
  }, [])

  /** Qué mes enseña la lista de asignaciones: al cambiar, se vuelve a pedir. */
  useEffect(() => {
    if (refEstado.current.primeraRondaDeMes) {
      refEstado.current.primeraRondaDeMes = false
      return undefined
    }
    void cargarAsignaciones()
    return undefined
  }, [filtroMes, cargarAsignaciones])

  /**
   * Traer la sección activa a la vista del deslizador.
   *
   * En el móvil la pista sólo enseña una sección a la vez. Sin esto la pista se queda
   * donde estaba: se entraba en Ventas y arriba seguía poniendo "Resumen" con el punto
   * de la cuarta encendido, o sea el rótulo diciendo una cosa y el contenido otra.
   */
  useEffect(() => {
    if (refEstado.current.primeraSeccion) {
      refEstado.current.primeraSeccion = false
      return undefined
    }
    const el = pistaSecciones.current?.querySelector('button.active')
    el?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
    return undefined
  }, [seccionActiva])

  /* ------------------------------------------------------------- las escuchas */

  /**
   * Los cambios llegan solos; esta pantalla no pregunta nada.
   *
   * Ahora el servidor mira una vez para todos y avisa por `/api/eventos`. El navegador
   * abre esa conexión y espera. `EventSource` reconecta solo si se cae la red o si el
   * backend se redespliega, así que no hay que vigilar nada.
   */
  useEffect(() => {
    /** Escape cierra. */
    const teclaDetalle = (e) => {
      if (e.key !== 'Escape') return
      if (refEstado.current.filaExpandida) setFilaExpandida(null)
      else if (refEstado.current.showForm) setShowForm(false)
    }

    /**
     * Al hacer clic fuera, los calendarios se cierran.
     *
     * Se mira `e.target` y no el nodo guardado: el nodo del render de montar ya no
     * existe en el DOM cuando React repinta.
     */
    const cerrarCalendarios = (e) => {
      const { showCalendar: abierto, showCalRango: rango } = refEstado.current
      if ((abierto || rango) && !e.target.closest?.('.calendar-group')) {
        setShowCalendar(false)
        setShowCalRango(false)
      }
    }

    document.addEventListener('click', cerrarCalendarios)
    window.addEventListener('keydown', teclaDetalle)

    void cargarDatos()

    let fuente = null
    try {
      fuente = new EventSource(`${API_URL}/eventos`)
    } catch (e) {
      // Sin eventos la pantalla sigue sirviendo: se ve lo que había al abrirla y el botón
      // de recargar está ahí. Peor sería quedarse en blanco.
      console.warn('No se pudieron escuchar los cambios:', e)
    }

    if (fuente) {
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
         * El aviso de «hay cambios» obligaba a pulsar algo para verlos, que es lo mismo
         * que recargar a mano. Si el servidor dice que cambió, se trae y se pinta.
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

    return () => {
      document.removeEventListener('click', cerrarCalendarios)
      window.removeEventListener('keydown', teclaDetalle)
      fuente?.close()
      document.body.style.overflow = desplazamientoAnterior.current
    }
  }, [cargarDatos, cargarAsignaciones, cargarResumen, cargarEstado])

  /**
   * Con el cajón abierto, la página de detrás no se mueve.
   *
   * Sin esto, al arrastrar dentro del cajón el dedo acaba moviendo la página de debajo:
   * el cajón se queda quieto y el fondo se va, que es exactamente la sensación de que
   * "no sale" o de que está roto. Se guarda lo que hubiera puesto antes en vez de dar
   * por hecho que era `visible`.
   */
  useEffect(() => {
    const abierto = filaExpandida || showForm
    if (abierto) {
      desplazamientoAnterior.current = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = desplazamientoAnterior.current
    }
  }, [filaExpandida, showForm])

  /* ------------------------------------------------------------- los cálculos */

  const indiceSeccion = SECCIONES.findIndex((s) => s.id === seccionActiva)

  const totalPaginas = porPagina === 0 ? 1 : Math.max(Math.ceil((asignaciones?.length || 0) / porPagina), 1)
  /* La página no puede quedarse fuera de rango cuando se borran filas: si estás en la 4
     y borras hasta que sólo quedan 3 páginas, sin esto verías una tabla vacía. */
  const paginaActual = Math.min(pagina, totalPaginas)
  const primeraDeLaPagina = porPagina === 0 ? 0 : (paginaActual - 1) * porPagina

  const asignacionesVisibles = useMemo(() => {
    const todas = asignaciones || []
    if (porPagina === 0) return todas
    const desde = (paginaActual - 1) * porPagina
    return todas.slice(desde, desde + porPagina)
  }, [asignaciones, porPagina, paginaActual])

  const haceCuanto = useMemo(() => {
    if (!actualizado) return null

    const m = Math.round((ahora - new Date(actualizado).getTime()) / 60000)

    if (m < 1) return 'ahora mismo'
    if (m === 1) return 'hace 1 minuto'
    if (m < 60) return `hace ${m} minutos`

    const h = Math.round(m / 60)

    return h === 1 ? 'hace 1 hora' : `hace ${h} horas`
  }, [actualizado, ahora])

  // Agrupar resumen por vendedor
  const resumenPorVendedor = useMemo(() => {
    const grouped = {}
    const vendidoMap = {}
    for (const v of ventas) {
      const key = `${v.vendedor}|${v.producto_id}`
      vendidoMap[key] = (vendidoMap[key] || 0) + (v.cantidad || 0)
    }
    for (const item of resumen) {
      if (!grouped[item.vendedor]) {
        grouped[item.vendedor] = { vendedor: item.vendedor, productos: {} }
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
        vendido: vendidoMap[`${item.vendedor}|${item.good_id}`] || 0,
      }
    }
    return Object.values(grouped)
      .sort((a, b) => a.vendedor.localeCompare(b.vendedor))
      .map((g) => ({
        ...g,
        productos: Object.values(g.productos).sort((a, b) => (a.producto_nombre || '').localeCompare(b.producto_nombre || '')),
      }))
  }, [resumen, ventas])

  // Ventas filtradas por fecha
  const ventasFiltradasPorFecha = useMemo(() => {
    if (filtroPreset === 'hoy') {
      return ventas.filter((v) => v.fecha === fechaHoy)
    }
    if (filtroPreset === 'rango') {
      if (!filtroFechaDesde && !filtroFechaHasta) return ventas
      return ventas.filter((v) => {
        if (!v.fecha) return false
        const f = v.fecha
        const desde = filtroFechaDesde
        const hasta = filtroFechaHasta
        if (desde && hasta) return f >= desde && f <= hasta
        if (desde) return f >= desde
        if (hasta) return f <= hasta
        return true
      })
    }
    return ventas.filter((v) => v.fecha && v.fecha.startsWith('2026-09'))
  }, [ventas, filtroPreset, fechaHoy, filtroFechaDesde, filtroFechaHasta])

  // Agrupar ventas por vendedor filtradas por fecha
  const ventasPorVendedorFiltrado = useMemo(() => {
    const grouped = {}
    for (const item of ventasFiltradasPorFecha) {
      if (!grouped[item.vendedor]) {
        grouped[item.vendedor] = { vendedor: item.vendedor, productos: {}, clientes: new Set() }
      }
      if (item.cliente) grouped[item.vendedor].clientes.add(item.cliente)
      const key = item.producto_nombre
      if (!grouped[item.vendedor].productos[key]) {
        grouped[item.vendedor].productos[key] = {
          producto_nombre: item.producto_nombre,
          precio: item.precio || 0,
          vendido: 0,
          total: 0,
          clientes: new Set(),
        }
      }
      grouped[item.vendedor].productos[key].vendido += item.cantidad
      grouped[item.vendedor].productos[key].total += item.total
      if (item.cliente) grouped[item.vendedor].productos[key].clientes.add(item.cliente)
    }
    return Object.values(grouped)
      .sort((a, b) => a.vendedor.localeCompare(b.vendedor))
      .map((g) => ({
        ...g,
        clientes: g.clientes.size,
        productos: Object.values(g.productos)
          .map((p) => ({ ...p, clientes: p.clientes.size }))
          .sort((a, b) => a.producto_nombre.localeCompare(b.producto_nombre)),
      }))
  }, [ventasFiltradasPorFecha])

  // Ventas filtradas por vendedor seleccionado
  const ventasFiltradas = useMemo(() => {
    if (!vendedorSeleccionado) return ventasPorVendedorFiltrado
    return ventasPorVendedorFiltrado.filter((v) => v.vendedor === vendedorSeleccionado)
  }, [ventasPorVendedorFiltrado, vendedorSeleccionado])

  // Matriz ventas "Todos": productos por fila, vendedores por columna
  const matrizVentasTodos = useMemo(() => {
    const listaVendedores = ventasPorVendedorFiltrado
    const productosMap = {}
    const clientesGlobales = {}
    for (const item of ventasFiltradasPorFecha) {
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
          clientes: setClientes.size,
        }
      }
    }
    for (const v of listaVendedores) {
      for (const p of v.productos) {
        productosMap[p.producto_nombre].porVendedor[v.vendedor] = {
          vendido: p.vendido,
          total: p.total,
          clientes: p.clientes,
        }
        productosMap[p.producto_nombre].cantidadTotal += p.vendido
        productosMap[p.producto_nombre].totalTotal += p.total
      }
    }
    return {
      vendedores: listaVendedores.map((v) => v.vendedor),
      filas: Object.values(productosMap).sort((a, b) => a.producto_nombre.localeCompare(b.producto_nombre)),
    }
  }, [ventasPorVendedorFiltrado, ventasFiltradasPorFecha])

  /**
   * Los vendedores de la lista, de más a menos vendido.
   *
   * Por orden alfabético el primero de la lista no dice nada; por importe, la lista
   * misma es el dato: quién vende y quién no se ve sin abrir a nadie.
   */
  const vendedoresPorImporte = useMemo(
    () => [...ventasPorVendedorFiltrado].sort((a, b) => importeDe(b) - importeDe(a)),
    [ventasPorVendedorFiltrado]
  )

  /** La suma de todos, para la fila "Todos" de la lista. */
  const totalTodosVendedores = useMemo(
    () => ventasPorVendedorFiltrado.reduce((t, v) => t + importeDe(v), 0),
    [ventasPorVendedorFiltrado]
  )

  const totalesGenerales = useMemo(() => {
    let totalAsignado = 0
    let totalEnProceso = 0
    let totalCobrado = 0
    let totalCompletada = 0
    let totalPendiente = 0
    for (const item of resumen) {
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
      pendiente: totalPendiente,
    }
  }, [resumen])

  // Total de ventas filtradas
  const totalVentasFiltrado = useMemo(() => {
    let total = 0
    for (const item of ventasPorVendedorFiltrado) {
      if (vendedorSeleccionado && item.vendedor !== vendedorSeleccionado) continue
      total += Object.values(item.productos).reduce((s, p) => s + p.total, 0)
    }
    return total
  }, [ventasPorVendedorFiltrado, vendedorSeleccionado])

  const totalVentasUnidades = useMemo(() => {
    let total = 0
    for (const item of ventasPorVendedorFiltrado) {
      if (vendedorSeleccionado && item.vendedor !== vendedorSeleccionado) continue
      total += Object.values(item.productos).reduce((s, p) => s + p.vendido, 0)
    }
    return total
  }, [ventasPorVendedorFiltrado, vendedorSeleccionado])

  function totalPorVendedorEnMatriz(vendedor) {
    const v = ventasPorVendedorFiltrado.find((x) => x.vendedor === vendedor)
    if (!v) return 0
    return Object.values(v.productos).reduce((s, p) => s + p.vendido, 0)
  }

  const totalClientesMatriz = useMemo(() => {
    const set = new Set()
    for (const item of ventasFiltradasPorFecha) {
      if (item.cliente) set.add(item.cliente)
    }
    return set.size
  }, [ventasFiltradasPorFecha])

  // Matriz de stock por producto y almacén
  const matrizAlmacen = useMemo(() => {
    const productos = {}
    for (const alm of almacen) {
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
      productos: Object.values(productos).sort((a, b) => a.nombre.localeCompare(b.nombre)),
    }
  }, [almacen])

  // Filtrar solo los productos disponibles en camaguey (sin contar FLORIDA, es otra sucursal)
  const productosFiltrados = useMemo(
    () =>
      matrizAlmacen.productos
        .map((p) => ({
          id: p.producto_id,
          name: p.nombre,
          stock: Object.entries(p.porAlmacen).reduce((s, [k, v]) => (k === 'FLORIDA' ? s : s + v), 0),
        }))
        .filter((p) => p.stock > 0),
    [matrizAlmacen]
  )

  const pedidosDelDetalle = useMemo(
    () => (detalleDe ? pedidosParaFila(detalleDe.vendedor, detalleDe.producto_id) : []),
    [detalleDe, detalleProceso]
  )

  /**
   * Las líneas sin casar que son de ESTE producto y de ESTE vendedor.
   *
   * El cajón dice «No queda ningún pedido por despachar»: si a la vez hay líneas
   * con su nombre que no se pudieron asociar a nada, decirlo ahí es lo que separa
   * «no hay nada» de «hay algo que no estoy mirando».
   */
  const sinCasarDeEste = useMemo(() => {
    if (!detalleDe) return []
    return afinesDe(sinCasar, detalleDe.producto_nombre).filter((l) =>
      (l.vendedores || []).includes(detalleDe.vendedor)
    )
  }, [sinCasar, detalleDe])

  const paginasDetalle = useMemo(
    () => Math.max(Math.ceil(pedidosDelDetalle.length / POR_PAGINA_DETALLE), 1),
    [pedidosDelDetalle]
  )

  /* Si se borra o cambia la lista, la página no puede quedarse fuera de rango. */
  const paginaDetalleActual = Math.min(paginaDetalle, paginasDetalle)

  const pedidosVisibles = useMemo(() => {
    const desde = (paginaDetalleActual - 1) * POR_PAGINA_DETALLE
    return pedidosDelDetalle.slice(desde, desde + POR_PAGINA_DETALLE)
  }, [pedidosDelDetalle, paginaDetalleActual])

  const calMonthName = useMemo(() => {
    const names = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
    return names[calMonth]
  }, [calMonth])

  const calDays = useMemo(() => {
    const first = new Date(calYear, calMonth, 1).getDay()
    const last = new Date(calYear, calMonth + 1, 0).getDate()
    const days = []
    for (let i = 0; i < first; i++) days.push(null)
    for (let i = 1; i <= last; i++) days.push(i)
    return days
  }, [calYear, calMonth])

  /* ---------------------------------------------------------------- las manos */

  /**
   * Cuántas cosas hay en cada sección, para el contador de la pestaña.
   *
   * `?? 0` en vez de `.length` a secas: este contador se pinta en la cabecera, o sea en
   * CADA render. Si una de las tres listas llega `undefined` -una respuesta que no trae
   * lo que se espera, la API a medio desplegar- aquí petaba el render y con él la
   * pantalla entera: no se veía la sección rota, se veía la página en blanco.
   */
  function cuentaSeccion(id) {
    if (id === 'asignaciones') return asignaciones?.length ?? 0
    if (id === 'almacen') return almacen?.length ?? 0
    if (id === 'ventas') return ventas?.length ?? 0
    return null
  }

  /** Pasa a la sección de al lado. No da la vuelta: en el extremo la flecha se apaga. */
  function cambiarSeccion(paso) {
    const i = indiceSeccion + paso
    if (i >= 0 && i < SECCIONES.length) setSeccionActiva(SECCIONES[i].id)
  }

  /**
   * Seleccionar / desmarcar todos.
   *
   * Los checks de la lista llevan `value={v.nombre}`, o sea TEXTO: Vue marca un
   * checkbox cuando su `value` está en el array del `v-model`, comparando con `===`.
   * Aquí se metían los OBJETOS ENTEROS de `vendedores`, que nunca son iguales a ese
   * texto, así que el contador subía a 14/14 y el botón pasaba a "Desmarcar Todos"…
   * pero NINGÚN check se marcaba. Y si se guardaba así, al servidor le llegaba
   * `"[object Object]"` como nombre de vendedor.
   *
   * Se guardan los nombres, que es lo que la lista y `crearAsignacion` esperan.
   */
  function toggleTodosVendedores() {
    const nombres = vendedores.map((v) => v.nombre)
    const marcados = vendedoresSeleccionados.filter((v) => typeof v === 'string')

    if (marcados.length === nombres.length) {
      setVendedoresSeleccionados([])
    } else {
      setVendedoresSeleccionados(nombres)
    }
  }

  function alternarVendedor(nombre) {
    setVendedoresSeleccionados((prev) =>
      prev.includes(nombre) ? prev.filter((n) => n !== nombre) : [...prev, nombre]
    )
  }

  function selectCalendarDay(day) {
    if (!day) return
    const m = String(calMonth + 1).padStart(2, '0')
    const d = String(day).padStart(2, '0')
    setNuevaAsignacion((a) => ({ ...a, fecha: `${calYear}-${m}-${d}` }))
    setShowCalendar(false)
  }

  function abrirCalAsignacion() {
    const f = nuevaAsignacion.fecha
    if (f) {
      const d = new Date(f + 'T00:00:00')
      setCalMonth(d.getMonth())
      setCalYear(d.getFullYear())
    }
    setShowCalendar((v) => !v)
  }

  function abrirCalRango() {
    if (!showCalRango) {
      if (filtroFechaDesde) {
        setRangoTmpDesde(filtroFechaDesde)
        const f = new Date(filtroFechaDesde)
        setCalYear(f.getFullYear())
        setCalMonth(f.getMonth())
        setCalObjetivo(filtroFechaHasta ? 'desde' : 'hasta')
      } else {
        setRangoTmpDesde('')
        setCalObjetivo('desde')
        const hoy = new Date()
        setCalYear(hoy.getFullYear())
        setCalMonth(hoy.getMonth())
      }
      setRangoTmpHasta(filtroFechaHasta)
      if (!filtroFechaDesde && !filtroFechaHasta) setCalObjetivo('desde')
    }
    setShowCalRango((v) => !v)
  }

  function seleccionarDiaRango(day) {
    if (!day) return
    const m = String(calMonth + 1).padStart(2, '0')
    const d = String(day).padStart(2, '0')
    const fecha = `${calYear}-${m}-${d}`
    if (calObjetivo === 'desde') {
      setRangoTmpDesde(fecha)
      setCalObjetivo('hasta')
    } else {
      let desde = rangoTmpDesde
      let hasta = fecha
      if (desde > fecha) {
        desde = fecha
        hasta = rangoTmpDesde
      }
      setFiltroFechaDesde(desde)
      setFiltroFechaHasta(hasta)
      setShowCalRango(false)
    }
  }

  function esDiaEnRango(fecha) {
    if (!rangoTmpDesde && !rangoTmpHasta) return false
    if (!rangoTmpHasta) return fecha === rangoTmpDesde
    return fecha >= rangoTmpDesde && fecha <= rangoTmpHasta
  }

  function prevMonth() {
    if (calMonth === 0) {
      setCalMonth(11)
      setCalYear((y) => y - 1)
    } else {
      setCalMonth((m) => m - 1)
    }
  }

  function nextMonth() {
    if (calMonth === 11) {
      setCalMonth(0)
      setCalYear((y) => y + 1)
    } else {
      setCalMonth((m) => m + 1)
    }
  }

  /**
   * Enseñar un aviso y olvidarse de él.
   *
   * Sólo uno a la vez: si llega otro, el anterior se sustituye y su reloj se cancela,
   * que es justo lo que pasa al guardar una tanda —éxito y luego el aviso del
   * producto— y no se quiere tener dos pegados encima.
   */
  function avisar(tipo, titulo, texto) {
    if (relojNota.current) clearTimeout(relojNota.current)
    const id = Date.now()
    setNota({ id, tipo, titulo, texto })
    // El error se queda más: es el que hay que leer entero.
    relojNota.current = setTimeout(
      () => setNota((n) => (n && n.id === id ? null : n)),
      tipo === 'ok' ? 6000 : 12000
    )
  }

  useEffect(() => () => clearTimeout(relojNota.current), [])

  /**
   * Guardar la tanda.
   *
   * Un POST por vendedor, y UNO MAL NO SE LLEVA POR DELANTE A LOS DEMÁS: antes el
   * `catch` estaba fuera del bucle, así que el primer fallo dejaba el resto sin
   * guardar y la única pista era un `alert` que casi nadie llegaba a leer. Ahora cada
   * vendedor se apunta a su sitio y al final se dice lo que salió y lo que no.
   *
   * Si falla alguna, el formulario NO se cierra: quedan seleccionados sólo los que
   * fallaron, para repetir y guardarlos sin tener que volver a marcarlos.
   */
  async function crearAsignacion() {
    if (guardando || enviandoRef.current) return

    if (vendedoresSeleccionados.length === 0 || !nuevaAsignacion.producto || !nuevaAsignacion.cantidad) {
      avisar('error', 'Faltan datos', 'Elige al menos un vendedor, un producto y una cantidad.')
      return
    }

    const producto = productosFiltrados.find((p) => p.id == nuevaAsignacion.producto)
    if (!producto) {
      // Silencio total: el botón estaba activo y al pulsarlo no pasaba NADA, porque el
      // producto ya no estaba en la lista (stock a cero) y esto se iba sin más.
      avisar('error', 'Producto no encontrado', 'Vuelve a elegir el producto en el desplegable.')
      return
    }

    const total = vendedoresSeleccionados.length
    const guardadas = []
    const fallidas = []
    let aviso = null

    setGuardando({ hechas: 0, total })
    enviandoRef.current = true
    try {
      let hechas = 0
      for (const vendedor of vendedoresSeleccionados) {
        try {
          const r = await axios.post(`${API_URL}/asignaciones`, {
            vendedor,
            producto_id: nuevaAsignacion.producto,
            producto_nombre: producto.name,
            cantidad: parseFloat(nuevaAsignacion.cantidad),
            fecha: nuevaAsignacion.fecha,
          })
          // El servidor avisa si el producto no casa con ninguno de Ventra: la asignación
          // se guarda pero NO va a salir en el resumen. Es el mismo aviso para todos los
          // vendedores del lote, así que con enseñarlo una vez basta.
          if (r.data?.aviso) aviso = r.data.aviso
          guardadas.push(vendedor)
        } catch (e) {
          fallidas.push({ vendedor, motivo: e.response?.data?.error || e.message })
        }
        hechas++
        setGuardando({ hechas, total })
      }

      const detalle = `${producto.name} · ${nuevaAsignacion.cantidad} c/u · ${nuevaAsignacion.fecha}`

      if (fallidas.length === 0) {
        setVendedoresSeleccionados([])
        setNuevaAsignacion({ producto: '', cantidad: 0, fecha: fechaHoy || hoyEnCuba() })
        setShowForm(false)
        avisar(aviso ? 'aviso' : 'ok', `${guardadas.length} de ${total} asignaciones guardadas`, aviso ? `${detalle}. ${aviso}` : detalle)
      } else if (guardadas.length === 0) {
        avisar('error', 'No se guardó ninguna asignación', fallidas[0].motivo)
      } else {
        // Se quedan SÓLO las que fallaron: pulsar otra vez las reintenta.
        setVendedoresSeleccionados(fallidas.map((f) => f.vendedor))
        avisar(
          'aviso',
          `Sólo ${guardadas.length} de ${total} guardadas`,
          `${fallidas.length} fallaron (${fallidas[0].vendedor}: ${fallidas[0].motivo}). Siguen marcadas: vuelve a pulsar para reintentarlas.`
        )
      }

      if (guardadas.length > 0) {
        await cargarResumen()
        await cargarAsignaciones()
      }
    } finally {
      enviandoRef.current = false
      setGuardando(null)
    }
  }

  async function eliminarAsignacion(id) {
    if (!confirm('¿Estás seguro de eliminar esta asignación?')) return

    try {
      await axios.delete(`${API_URL}/asignaciones/${id}`)
      await cargarResumen()
      await cargarAsignaciones()
      avisar('ok', 'Asignación eliminada', 'Ya no cuenta para este mes.')
    } catch (e) {
      avisar('error', 'No se pudo eliminar', e.response?.data?.error || e.message)
    }
  }

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
    if (filaExpandida === key) {
      setFilaExpandida(null)
      return
    }
    setFilaExpandida(key)
    setDetalleDe({ vendedor, producto_id, producto_nombre, prod })
    // Cada producto empieza por su primera página, no por donde se quedó el anterior.
    setPaginaDetalle(1)
    await traerDetalle()
  }

  function pedidosParaFila(vendedor, producto_id) {
    const entry = detalleProceso.find((d) => d.vendedor === vendedor && d.producto_id === producto_id)
    return entry ? entry.pedidos : []
  }

  function esFilaExpandida(vendedor, producto_id) {
    return filaExpandida === `${vendedor}|${producto_id}`
  }

  /**
   * Elegir vendedor.
   *
   * Ya no hace falta traer nada a la vista: en pantalla ancha los diez están en la
   * lista, y en estrecha el desplegable lo abre el propio teléfono.
   */
  function elegirVendedor(nombre) {
    setVendedorSeleccionado(nombre)
  }

  function cerrarDetalle() {
    setFilaExpandida(null)
  }

  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <div className="header-content">
          <div className="header-title">
            <span className="logo">
              <AppIcon name="box" size={28} />
            </span>
            <div>
              <h1>Asignación de Productos a Vendedores</h1>
              <p className="subtitle">{mesCabecera}</p>
            </div>
          </div>
          <div className="header-actions">
            <button onClick={() => setShowForm((v) => !v)} className="btn btn-primary btn-lg">
              {!showForm ? (
                <span>
                  <AppIcon name="plus" size={16} /> Nueva Asignación
                </span>
              ) : (
                <span>
                  <AppIcon name="x" size={16} /> Cancelar
                </span>
              )}
            </button>
            {/*
              La frescura va PEGADA al botón de actualizar, en una sola pieza.
              Suelta entre los dos botones quedaba apretada y sin alinear, como si se
              hubiera caído ahí. Aquí se lee como lo que es: el estado de ese botón.
            */}
            {haceCuanto && (
              <span className="frescura" title={`Calculado el ${actualizado}`}>
                <span className="frescura-punto" aria-hidden="true"></span>
                {haceCuanto}
              </span>
            )}
            <button className="btn btn-ghost ref-btn" onClick={cargarDatos} title="Actualizar datos">
              <AppIcon name="refresh" size={16} />
            </button>
          </div>
        </div>
      </header>

      {/* Loading */}
      {loading && (
        <div className="loading-overlay">
          <div className="spinner"></div>
          <p>Cargando datos...</p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="error-banner">
          <span className="error-icon">
            <AppIcon name="alert" size={16} />
          </span>{' '}
          {error}
          <button onClick={() => setError(null)}>
            <AppIcon name="x" size={16} />
          </button>
        </div>
      )}

      {/*
        * Lo que no se puede contar, dicho en voz alta.
        *
        * El servidor tira estas líneas porque su nombre no encaja con ningún producto
        * de Ventra: no suman en ninguna fila ni salen en el detalle, y el único síntoma
        * es que «No queda ningún pedido por despachar» con pedidos encima. Es el aviso
        * de siempre —no doy por hecho que el usuario se fije—, así que va arriba, fijo,
        * en ámbar, sin botón de cerrar.
        */}
      {sinCasar.length > 0 && (
        <div className="sin-casar" role="status">
          <span className="sin-casar-icono">
            <AppIcon name="alert" size={16} />
          </span>
          <div>
            <strong>
              {sinCasar.length} {sinCasar.length === 1 ? 'línea de pedido no casa' : 'líneas de pedidos no casan'}{' '}
              con ningún producto de Ventra
            </strong>
            <span> — no aparecen en ninguna fila ni en el detalle:</span>
            <ul>
              {sinCasar.slice(0, 5).map((s) => (
                <li key={s.producto}>
                  {s.producto}{' '}
                  <em>
                    · {s.pedidos} {s.pedidos === 1 ? 'pedido' : 'pedidos'} · {s.packs} packs
                  </em>
                </li>
              ))}
              {sinCasar.length > 5 && <li>…y {sinCasar.length - 5} más</li>}
            </ul>
          </div>
        </div>
      )}

      <main className="main-content">
        {/* Los totales y las secciones se quedan donde están. */}
        {/* Totales Generales */}
        {resumen.length > 0 && (
          <div className="stats-grid">
            <div className="stat-card stat-primary">
              <div className="stat-icon">
                <AppIcon name="box" size={26} />
              </div>
              <div className="stat-info">
                <span className="stat-label">Total Asignado</span>
                <span className="stat-value">{totalesGenerales.asignado}</span>
              </div>
            </div>
            <div className="stat-card stat-success">
              <div className="stat-icon">
                <AppIcon name="hourglass" size={26} />
              </div>
              <div className="stat-info">
                <span className="stat-label">En Proceso</span>
                <span className="stat-value">{totalesGenerales.en_proceso}</span>
              </div>
            </div>
            <div className="stat-card stat-warning">
              <div className="stat-icon">
                <AppIcon name="check" size={26} />
              </div>
              <div className="stat-info">
                <span className="stat-label">Completado</span>
                <span className="stat-value">{totalesGenerales.completada}</span>
              </div>
            </div>
            <div className="stat-card stat-purple">
              <div className="stat-icon">
                <AppIcon name="inbox" size={26} />
              </div>
              <div className="stat-info">
                <span className="stat-label">Pendiente</span>
                <span className="stat-value">{totalesGenerales.pendiente}</span>
              </div>
            </div>
          </div>
        )}

        {/* Tabs Asignaciones / Resumen */}
        <section className="card">
          {/* EL SELECTOR MANDA SOBRE LAS CUATRO SECCIONES.
               Antes sólo gobernaba Resumen y Asignaciones, y Almacén y Ventas iban apiladas
               debajo: la página era un scroll de cuatro bloques, uno detrás de otro, y en el
               móvil no se acababa nunca. Ahora se ve una a la vez.
               En pantalla ancha son pestañas de toda la vida; en el móvil, un deslizador con
               flechas, porque cuatro pestañas con icono y texto no caben en 360 px. */}
          <div className="seccion-tabs">
            <button
              className="tab-flecha"
              type="button"
              aria-label="Sección anterior"
              disabled={indiceSeccion === 0}
              onClick={() => cambiarSeccion(-1)}
            >
              <AppIcon name="chevronLeft" size={16} />
            </button>

            <div ref={pistaSecciones} className="tabs-pista">
              {SECCIONES.map((s) => (
                <button
                  key={s.id}
                  className={seccionActiva === s.id ? 'active' : undefined}
                  aria-current={seccionActiva === s.id ? 'page' : undefined}
                  type="button"
                  onClick={() => setSeccionActiva(s.id)}
                >
                  <AppIcon name={s.icono} size={14} /> {s.titulo}
                  {/* El contador dice si hay algo ahí dentro sin tener que entrar. */}
                  {cuentaSeccion(s.id) !== null && <span className="tab-badge">{cuentaSeccion(s.id)}</span>}
                </button>
              ))}
            </div>

            <button
              className="tab-flecha"
              type="button"
              aria-label="Sección siguiente"
              disabled={indiceSeccion === SECCIONES.length - 1}
              onClick={() => cambiarSeccion(1)}
            >
              <AppIcon name="chevronRight" size={16} />
            </button>
          </div>

          {/* Puntitos: en el móvil dicen en cuál de las dos estás, que con el deslizador
               no se ve de un vistazo. */}
          <div className="tabs-puntos">
            {SECCIONES.map((s) => (
              <span key={'p-' + s.id} className={seccionActiva === s.id ? 'activo' : undefined}></span>
            ))}
          </div>
        </section>

        {/*
          El cambio de sección también se acompaña.

          Las cuatro secciones miden cosas distintas -una rejilla de tarjetas, una tabla
          de treinta filas, una matriz de once columnas-, así que al cambiar de pestaña
          la página saltaba de un tamaño a otro en un fotograma. Aquí la salida es
          inmediata y sólo la entrada se atenúa: si la salida también durara, quedaría un
          hueco vacío entre las dos y la página encogería y volvería a crecer, que es
          peor que el salto.
        */}
        <Transition name="seccion" nodeKey={seccionActiva}>
          <div className="seccion-contenido">
            {/*
              Cada sección en su propia tarjeta, con su cabecera.

              Resumen y Asignaciones vivían DENTRO de la tarjeta del selector, así que la
              tabla arrancaba pegada a las pestañas, sin separación ni título, mientras
              Almacén y Ventas sí tenían la suya. Eran dos maneras distintas de enseñar lo
              mismo en la misma pantalla.
            */}
            {seccionActiva === 'resumen' && (
              <section className="card">
                <div className="card-header">
                  <h2>
                    <AppIcon name="clipboard" size={18} /> Resumen por Vendedor
                  </h2>
                  <span className="badge">
                    {resumenPorVendedor.length} {resumenPorVendedor.length === 1 ? 'vendedor' : 'vendedores'}
                  </span>
                </div>
                <div>
                  {resumenPorVendedor.length > 0 ? (
                    <div className="vendedor-grid">
                      {resumenPorVendedor.map((item) => (
                        <article key={item.vendedor} className="vendedor-card">
                          <header className="vendedor-header">
                            <span className="vendedor-avatar">{inicialesDe(item.vendedor)}</span>
                            <div className="vendedor-id">
                              <h3>{item.vendedor}</h3>
                              <p>
                                {totalesDe(item).completada} de {totalesDe(item).asignado} despachados
                              </p>
                            </div>
                            <span
                              className="vendedor-avance"
                              title={`${avanceDe(item)} por ciento de lo asignado ya salió del almacén`}
                            >
                              {avanceDe(item)}
                              <small>%</small>
                            </span>
                          </header>

                          <ul className="producto-lista">
                            {item.productos.map((prod) => {
                              const abierto = esFilaExpandida(item.vendedor, prod.producto_id)
                              const tramos = tramosDe(prod)
                              const diferencia = prod.completada - prod.sin_pedido - prod.pedido

                              return (
                                <li key={prod.producto_id} className={`producto${abierto ? ' abierto' : ''}`}>
                                  <button
                                    type="button"
                                    className="producto-cabeza"
                                    aria-expanded={abierto}
                                    onClick={() =>
                                      toggleDetalle(item.vendedor, prod.producto_id, prod.producto_nombre, prod)
                                    }
                                  >
                                    <span className="producto-nombre">{nombreCorto(prod.producto_nombre)}</span>
                                    <span className="producto-cifra">
                                      <b>{prod.completada}</b>
                                      <span className="de">/</span>
                                      {prod.asignado}
                                    </span>
                                    <AppIcon name="chevronRight" size={16} className="producto-flecha" />
                                  </button>

                                  <div
                                    className="barra"
                                    role="img"
                                    aria-label={`De ${prod.asignado} asignados: ${prod.completada} despachados, de ellos ${prod.cambiado} con factura distinta; ${prod.en_proceso} pedidos sin salir`}
                                  >
                                    <span className="tramo t-despachado" style={{ width: tramos.despachado }}></span>
                                    <span className="tramo t-exceso" style={{ width: tramos.salioDeMas }}></span>
                                    <span className="tramo t-libre" style={{ width: tramos.libre }}></span>
                                  </div>

                                  {/*
                                    Pedido contra factura, que es para lo que sirve esta pantalla:
                                    ver si se está llevando lo que se pidió. La diferencia se dice con
                                    signo, que un +210 y un -80 no significan lo mismo.
                                  */}
                                  {prod.pedido ? (
                                    <p className="cotejo">
                                      Pidieron <b>{prod.pedido}</b>
                                      <span className="cotejo-flecha">→</span>
                                      facturado <b>{prod.completada - prod.sin_pedido}</b>
                                      {diferencia ? (
                                        <span className={`cotejo-dif${diferencia < 0 ? ' dif-menos' : ''}`}>
                                          {diferencia > 0 ? '+' : ''}
                                          {diferencia}
                                        </span>
                                      ) : (
                                        <span className="cotejo-igual">clavado</span>
                                      )}
                                    </p>
                                  ) : null}

                                  {/*
                                    Tres cifras y para. Llegó a haber seis por producto -y dos de ellas
                                    diciendo lo mismo con distinto nombre-, y una fila con seis números
                                    no se lee: se descifra. Lo que importa de un vistazo es cuánto salió,
                                    cuánto se pasó y cuánto queda sin pedir. Lo demás -en proceso,
                                    cerrado sin factura, salió sin pedido, lo que cambió- está en el
                                    detalle, a un clic, que es donde hay sitio para explicarlo.
                                  */}
                                  <p className="marcas">
                                    <span className="marca m-despachado">
                                      Despachado <b>{prod.completada}</b>
                                    </span>
                                    {tramos.exceso ? (
                                      <span
                                        className="marca m-demas"
                                        title={`Vendió ${prod.completada} contra ${prod.asignado} asignados`}
                                      >
                                        Vendió de más <b>{tramos.exceso}</b>
                                      </span>
                                    ) : null}
                                    {prod.pendiente ? (
                                      <span className="marca m-libre" title="Asignado que todavía no ha sido despachado">
                                        Pendiente <b>{prod.pendiente}</b>
                                      </span>
                                    ) : null}
                                  </p>
                                </li>
                              )
                            })}
                          </ul>

                          {/*
                            El pie va pegado al fondo de la tarjeta.

                            Al igualar el alto de las tarjetas de una fila, a la del vendedor con un
                            solo producto le sobraban doscientos píxeles en blanco. Con el pie abajo
                            ese hueco deja de ser un vacío: cierra la tarjeta y repite los totales
                            del vendedor, que es lo que se compara entre uno y otro.
                          */}
                          <footer className="vendedor-pie">
                            <span>
                              <b>{totalesDe(item).asignado}</b> asignados
                            </span>
                            <span className="pie-despachado">
                              <b>{totalesDe(item).completada}</b> despachados
                            </span>
                            <span className="pie-proceso">
                              <b>{totalesDe(item).en_proceso}</b> en proceso
                            </span>
                            {totalesDe(item).pendiente > 0 && (
                              <span className="pie-pendiente">
                                Pendientes <b>{totalesDe(item).pendiente}</b>
                              </span>
                            )}
                            {totalesDe(item).exceso ? (
                              <span className="pie-exceso">
                                <b>{totalesDe(item).exceso}</b> vendidos de más
                              </span>
                            ) : null}
                          </footer>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className="empty-state">
                      <p>No hay resumen de asignaciones</p>
                    </div>
                  )}
                </div>
              </section>
            )}

            {seccionActiva === 'asignaciones' && (
              <section className="card">
                <div className="card-header">
                  <h2>
                    <AppIcon name="edit" size={18} /> Asignaciones
                  </h2>
                  <div className="cabecera-derecha">
                    <label className="elegir-mes">
                      <AppIcon name="calendar" size={15} />
                      <select
                        value={filtroMes}
                        onChange={(e) => setFiltroMes(e.target.value)}
                        aria-label="Mes de las asignaciones"
                      >
                        {mesesDisponibles.map((m) => (
                          <option key={m.mes} value={m.mes}>
                            {nombreDelMes(m.mes)}
                            {m.cuantas ? ` (${m.cuantas})` : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                    <span className="badge">
                      {asignaciones ? asignaciones.length : 0}{' '}
                      {(asignaciones ? asignaciones.length : 0) === 1 ? 'asignación' : 'asignaciones'}
                    </span>
                  </div>
                </div>
                <div>
                  {asignaciones && asignaciones.length > 0 && (
                    <div className="table-wrapper">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th className="fila-num">#</th>
                            <th>Fecha</th>
                            <th>Vendedor</th>
                            <th>Producto</th>
                            <th className="text-right">Cantidad</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {asignacionesVisibles.map((asig, i) => (
                            <tr key={asig.id}>
                              <td className="fila-num">{primeraDeLaPagina + i + 1}</td>
                              <td>{asig.fecha}</td>
                              <td>{asig.vendedor}</td>
                              <td>{asig.producto_nombre}</td>
                              <td className="text-right">{asig.cantidad}</td>
                              <td className="text-center">
                                <button
                                  onClick={() => eliminarAsignacion(asig.id)}
                                  className="btn-icon btn-danger"
                                  title="Eliminar"
                                >
                                  <AppIcon name="trash" size={16} />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* El pie sólo aparece cuando hay más de una página o más filas de las que
                       caben: con catorce asignaciones no pinta nada y estorba. */}
                  {asignaciones.length > POR_PAGINA[0] && (
                    <div className="paginacion">
                      <span className="pag-cuenta">
                        {porPagina === 0 ? (
                          <>Las {asignaciones.length}</>
                        ) : (
                          <>
                            {primeraDeLaPagina + 1}–{primeraDeLaPagina + asignacionesVisibles.length} de{' '}
                            {asignaciones.length}
                          </>
                        )}
                      </span>

                      <label className="pag-cuantas">
                        Por página
                        <select value={porPagina} onChange={(e) => setPorPagina(Number(e.target.value))}>
                          {POR_PAGINA.map((n) => (
                            <option key={n} value={n}>
                              {n === 0 ? 'Todas' : n}
                            </option>
                          ))}
                        </select>
                      </label>

                      {totalPaginas > 1 && (
                        <span className="pag-pasos">
                          <button
                            type="button"
                            disabled={paginaActual === 1}
                            aria-label="Página anterior"
                            onClick={() => setPagina(paginaActual - 1)}
                          >
                            <AppIcon name="chevronLeft" size={16} />
                          </button>
                          <span className="pag-donde">
                            {paginaActual} de {totalPaginas}
                          </span>
                          <button
                            type="button"
                            disabled={paginaActual === totalPaginas}
                            aria-label="Página siguiente"
                            onClick={() => setPagina(paginaActual + 1)}
                          >
                            <AppIcon name="chevronRight" size={16} />
                          </button>
                        </span>
                      )}
                    </div>
                  )}

                  {/*
                    Condición propia, no `v-else`.

                    El `v-else` tiene que ir pegado a su `v-if`, y al meter el pie de la
                    paginación entre los dos se rompió la pareja: Vue dejó de emparejarlos y el
                    "No hay asignaciones" salía SIEMPRE, debajo de las catorce filas.
                  */}
                  {!asignaciones || asignaciones.length === 0 ? (
                    <div className="empty-state">
                      <p>No hay asignaciones en {nombreDelMes(filtroMes)}</p>
                    </div>
                  ) : null}
                </div>
              </section>
            )}

            {/* Cuando la sección elegida no tiene nada que enseñar se dice, en vez de dejar la
                 pantalla en blanco: un hueco vacío no se distingue de algo roto. */}
            {(seccionActiva === 'almacen' && !almacen.length) ||
            (seccionActiva === 'ventas' && !ventas.length) ? (
              <section className="card seccion-vacia">
                <AppIcon name={seccionActiva === 'almacen' ? 'warehouse' : 'cart'} size={28} />
                <p>{seccionActiva === 'almacen' ? 'No hay stock que mostrar.' : 'No hay ventas registradas este mes.'}</p>
              </section>
            ) : null}

            {/* Stock en Almacén */}
            {seccionActiva === 'almacen' && almacen.length > 0 && (
              <section className="card">
                <div className="card-header">
                  <h2>
                    <AppIcon name="warehouse" size={18} /> Stock en Almacén
                  </h2>
                  <span className="badge">{totalesAlmacen.productos} productos</span>
                </div>
                <div className="table-wrapper table-almacen">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Producto</th>
                        <th className="text-right">Precio</th>
                        {almacen.map((a) => (
                          <th key={a.almacen} className="text-right">
                            {a.almacen}
                          </th>
                        ))}
                        <th className="text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {matrizAlmacen.productos.map((item) => (
                        <tr key={item.producto_id}>
                          <td>{item.nombre}</td>
                          {/*
                            El precio sale de la última venta, no de la ficha: Ventra no guarda
                            precio en el producto. Si esa venta es vieja se dice de cuándo es, en
                            vez de esconder el número: saber que el KAPITAL INDUSTRIAL se vendió a
                            18 en febrero de 2025 es más útil que un "sin precio" que se lee como
                            que no vale nada.
                          */}
                          <td className={`text-right${!item.precio ? ' sin-precio' : ''}`}>
                            {item.precio ? (
                              <>
                                ${item.precio.toFixed(2)}
                                {item.precio_viejo ? (
                                  <span
                                    className="precio-viejo"
                                    title={`Último precio conocido, de una venta del ${item.precio_fecha}`}
                                  >
                                    {item.precio_fecha}
                                  </span>
                                ) : null}
                              </>
                            ) : (
                              <>nunca se ha vendido</>
                            )}
                          </td>
                          {/* El cero se apaga: en una tabla de diez almacenes, si todos los
                               números pesan lo mismo hay que leerlos uno a uno para ver dónde
                               hay mercancía de verdad. */}
                          {almacen.map((a) => (
                            <td
                              key={a.almacen}
                              className={`text-right stock-val${!item.porAlmacen[a.almacen] ? ' stock-cero' : ''}`}
                            >
                              {item.porAlmacen[a.almacen] || 0}
                            </td>
                          ))}
                          <td className="text-right stock-val stock-total">{item.stock}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* Ventas Registradas */}
            {seccionActiva === 'ventas' && ventas.length > 0 && (
              <section className="card">
                <div className="card-header">
                  <h2>
                    <AppIcon name="cart" size={18} /> Ventas Registradas
                  </h2>
                  <span className="badge success">${totalVentasFiltrado.toFixed(2)}</span>
                </div>

                {/* Filtro de fecha */}
                <div className="filtro-fecha">
                  <span className="filtro-modo">
                    <button className={filtroPreset === 'hoy' ? 'active' : undefined} onClick={() => setFiltroPreset('hoy')}>
                      Hoy
                    </button>
                    <button className={filtroPreset === 'mes' ? 'active' : undefined} onClick={() => setFiltroPreset('mes')}>
                      Mes
                    </button>
                    <button className={filtroPreset === 'rango' ? 'active' : undefined} onClick={() => setFiltroPreset('rango')}>
                      Rango
                    </button>
                  </span>
                  {filtroPreset === 'rango' && (
                    <div className="filtro-rango">
                      <div className="calendar-group">
                        <div className="calendar-input-wrapper" onClick={abrirCalRango}>
                          <span className="cal-display">
                            <AppIcon name="calendar" size={16} />{' '}
                            {filtroFechaDesde
                              ? `${filtroFechaDesde} — ${filtroFechaHasta || filtroFechaDesde}`
                              : 'Elegir fechas'}
                          </span>
                        </div>
                        {showCalRango && (
                          <div className="calendar-popup" onClick={(e) => e.stopPropagation()}>
                            <div className="cal-header">
                              <button type="button" onClick={prevMonth} className="cal-nav">
                                {'<'}
                              </button>
                              <span className="cal-title">
                                {calMonthName} {calYear}
                              </span>
                              <button type="button" onClick={nextMonth} className="cal-nav">
                                {'>'}
                              </button>
                            </div>
                            <p className="cal-hint">
                              {calObjetivo === 'desde' ? 'Elige el día inicial' : 'Elige el día final'}
                            </p>
                            <div className="cal-weekdays">
                              <span>Lu</span>
                              <span>Ma</span>
                              <span>Mi</span>
                              <span>Ju</span>
                              <span>Vi</span>
                              <span>Sa</span>
                              <span>Do</span>
                            </div>
                            <div className="cal-grid">
                              {calDays.map((day, idx) => (
                                <button
                                  key={idx}
                                  type="button"
                                  className={`cal-day${!day ? ' empty' : ''}${
                                    day && esDiaEnRango(`${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
                                      ? ' selected'
                                      : ''
                                  }`}
                                  onClick={() => seleccionarDiaRango(day)}
                                  disabled={!day}
                                >
                                  {day}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/*
                  Elegir vendedor.

                  Antes era una fila de fichas. Con diez vendedores se partía en dos filas y
                  empujaba la tabla; puesta en una sola línea había que arrastrarla para ver
                  los últimos. Ninguna de las dos sirve cuando la lista crece.

                  En pantalla ancha va como lista a un lado: caben los diez a la vez, cada uno
                  con su importe, y la lista por sí sola ya dice quién vende y quién no. En
                  pantalla estrecha, un desplegable del propio teléfono: una línea, sin
                  arrastrar, y da igual que sean diez que cuarenta.
                */}
                <div className="ventas-cuerpo">
                  <div className="ventas-lado">
                    <label className="lado-etiqueta" htmlFor="elegir-vendedor">
                      Vendedor
                    </label>

                    <select
                      id="elegir-vendedor"
                      className="lado-select"
                      value={vendedorSeleccionado}
                      onChange={(e) => elegirVendedor(e.target.value)}
                    >
                      <option value="">Todos los vendedores</option>
                      {vendedoresPorImporte.map((v) => (
                        <option key={v.vendedor} value={v.vendedor}>
                          {v.vendedor} — ${importeDe(v).toFixed(2)}
                        </option>
                      ))}
                    </select>

                    <ul className="lado-lista">
                      <li>
                        <button
                          type="button"
                          className={!vendedorSeleccionado ? 'active' : undefined}
                          onClick={() => elegirVendedor('')}
                        >
                          <AppIcon name="users" size={14} />
                          <span className="lado-nombre">Todos</span>
                          <span className="lado-importe">${totalTodosVendedores.toFixed(2)}</span>
                        </button>
                      </li>
                      {vendedoresPorImporte.map((v) => (
                        <li key={v.vendedor}>
                          <button
                            type="button"
                            className={vendedorSeleccionado === v.vendedor ? 'active' : undefined}
                            title={v.vendedor}
                            onClick={() => elegirVendedor(v.vendedor)}
                          >
                            <span className="lado-inicial">{inicialesDe(v.vendedor)}</span>
                            <span className="lado-nombre">{nombreCortoVendedor(v.vendedor)}</span>
                            <span className="lado-importe">${importeDe(v).toFixed(2)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="ventas-detalle">
                    {/*
                      Al cambiar de vendedor el contenido se cruza en vez de aparecer de golpe.

                      Sin esto, pasar de "Todos" -una matriz de once columnas- a un vendedor con
                      tres productos es un parpadeo seco: desaparece un bloque grande y aparece
                      otro pequeño en el mismo fotograma, y la vista tiene que volver a buscar
                      dónde está todo. Con el cruce el ojo sigue el cambio.
                    */}
                    <Transition name="cambio" mode="out-in" nodeKey={vendedorSeleccionado || 'todos'}>
                      <div>
                        {/* Matriz cuando está "Todos" */}
                        {!vendedorSeleccionado && (
                          <div className="matriz-ventas">
                            <table className="mini-table">
                              <thead>
                                <tr>
                                  <th>Producto</th>
                                  {matrizVentasTodos.vendedores.map((v) => (
                                    <th key={v} className="text-right">
                                      {v.split(' ')[0]} {v.split(' ').slice(-1)[0]}
                                    </th>
                                  ))}
                                  <th className="text-right">Total</th>
                                  <th className="text-right">Clientes</th>
                                </tr>
                              </thead>
                              <tbody>
                                {matrizVentasTodos.filas.map((prod) => (
                                  <tr key={prod.producto_nombre}>
                                    <td>{prod.producto_nombre.replace('CERVEZA ', '').replace('MALTA ', '')}</td>
                                    {matrizVentasTodos.vendedores.map((v) => (
                                      <td key={v} className="text-right">
                                        {prod.porVendedor[v] ? prod.porVendedor[v].vendido : 0}
                                        {prod.porVendedor[v] && prod.porVendedor[v].clientes ? (
                                          <span className="clientes-mini">
                                            <AppIcon name="users" size={12} /> {prod.porVendedor[v].clientes}
                                          </span>
                                        ) : null}
                                      </td>
                                    ))}
                                    <td className="text-right total-val">{prod.cantidadTotal}</td>
                                    <td className="text-right clientes-total">
                                      <AppIcon name="users" size={13} /> {prod.clientes}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                              <tfoot>
                                <tr>
                                  <td>
                                    <strong>Total</strong>
                                  </td>
                                  {matrizVentasTodos.vendedores.map((v) => (
                                    <td key={v} className="text-right">
                                      <strong>{totalPorVendedorEnMatriz(v)}</strong>
                                    </td>
                                  ))}
                                  <td className="text-right total-val">
                                    <strong>{totalVentasUnidades}</strong>
                                  </td>
                                  <td className="text-right clientes-total">
                                    <strong>
                                      <AppIcon name="users" size={13} /> {totalClientesMatriz}
                                    </strong>
                                  </td>
                                </tr>
                              </tfoot>
                            </table>
                          </div>
                        )}

                        {/* Ventas del vendedor seleccionado */}
                        {vendedorSeleccionado &&
                          ventasFiltradas.map((item) => (
                            <div key={item.vendedor} className="venta-card">
                              <div className="venta-header">
                                <span className="vendedor-avatar">{inicialesDe(item.vendedor)}</span>
                                <h3>{item.vendedor}</h3>
                                <span className="venta-clientes">
                                  <AppIcon name="users" size={14} /> {item.clientes}{' '}
                                  {item.clientes === 1 ? 'cliente' : 'clientes'}
                                </span>
                                <span className="venta-total">
                                  ${Object.values(item.productos)
                                    .reduce((s, p) => s + p.total, 0)
                                    .toFixed(2)}
                                </span>
                              </div>
                              {/* En una pantalla de 390 px estas cinco columnas no caben y la de Total
                                   quedaba cortada por el borde, sin forma de llegar a ella. */}
                              <div className="table-wrapper">
                                <table className="mini-table tabla-vendedor">
                                  <thead>
                                    <tr>
                                      <th>Producto</th>
                                      <th className="text-right">Precio</th>
                                      <th className="text-right">Cantidad</th>
                                      <th className="text-right">Clientes</th>
                                      <th className="text-right">Total</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {Object.values(item.productos).map((prod) => (
                                      <tr key={prod.producto_nombre}>
                                        <td>{prod.producto_nombre.replace('CERVEZA ', '').replace('MALTA ', '')}</td>
                                        <td className="text-right">${prod.precio.toFixed(2)}</td>
                                        <td className="text-right">{prod.vendido}</td>
                                        <td className="text-right">
                                          <AppIcon name="users" size={13} /> {prod.clientes}
                                        </td>
                                        <td className="text-right total-val">${prod.total.toFixed(2)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          ))}

                        {vendedorSeleccionado && ventasFiltradas.length === 0 && (
                          <div className="empty-state">
                            <span className="empty-icon">
                              <AppIcon name="inbox" size={40} />
                            </span>
                            <p>No hay ventas para este vendedor</p>
                          </div>
                        )}
                      </div>
                    </Transition>
                  </div>
                </div>
              </section>
            )}

          </div>
        </Transition>
      </main>

      {/*
        Nueva asignación: ventana en escritorio, cajón en el móvil.

        Estaba dentro del flujo de la página: al abrirlo, el bloque crecía y empujaba
        hacia abajo los totales, las pestañas y la tabla entera. Elegir nueve vendedores
        obligaba a mirar cómo se movía todo lo demás, y al cerrarlo la página volvía a
        dar el salto en sentido contrario. Un formulario que se abre no puede reordenar
        la pantalla que hay detrás.
      */}
      <Transition name="ventana" nodeKey={showForm ? 'form' : null}>
        {showForm && (
          <div className="capa capa-desde-boton" onClick={(e) => e.target === e.currentTarget && setShowForm(false)}>
            <div className="hoja hoja-ancha" role="dialog" aria-modal="true" aria-labelledby="titulo-form">
              <span className="hoja-asa" aria-hidden="true"></span>
              <header className="hoja-cabeza">
                <div className="hoja-quien">
                  <p id="titulo-form">Nueva Asignación</p>
                  <p className="hoja-vendedor">{nombreDelMes(mesEnCurso())}</p>
                </div>
                <button type="button" className="hoja-cerrar" aria-label="Cerrar" onClick={() => setShowForm(false)}>
                  <AppIcon name="x" size={18} />
                </button>
              </header>

              <div className="hoja-cuerpo">
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    void crearAsignacion()
                  }}
                >
                  <div className="form-row">
                    <div className="form-group">
                      <label>Producto</label>
                      <select
                        value={nuevaAsignacion.producto}
                        onChange={(e) => setNuevaAsignacion((a) => ({ ...a, producto: e.target.value }))}
                        required
                      >
                        <option value="">-- Seleccionar --</option>
                        {productosFiltrados.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} (stock: {p.stock})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="form-group">
                      <label>Cantidad</label>
                      <input
                        type="number"
                        value={nuevaAsignacion.cantidad}
                        onChange={(e) => setNuevaAsignacion((a) => ({ ...a, cantidad: e.target.value }))}
                        min="1"
                        placeholder="0"
                        required
                      />
                    </div>
                    <div className="form-group calendar-group">
                      <label>Fecha</label>
                      <div className="calendar-input-wrapper" onClick={abrirCalAsignacion}>
                        <span className="cal-display">
                          <AppIcon name="calendar" size={16} /> {nuevaAsignacion.fecha}
                        </span>
                      </div>
                      {showCalendar && (
                        <div className="calendar-popup" onClick={(e) => e.stopPropagation()}>
                          <div className="cal-header">
                            <button type="button" onClick={prevMonth} className="cal-nav">
                              {'<'}
                            </button>
                            <span className="cal-title">
                              {calMonthName} {calYear}
                            </span>
                            <button type="button" onClick={nextMonth} className="cal-nav">
                              {'>'}
                            </button>
                          </div>
                          <div className="cal-weekdays">
                            <span>Lu</span>
                            <span>Ma</span>
                            <span>Mi</span>
                            <span>Ju</span>
                            <span>Vi</span>
                            <span>Sa</span>
                            <span>Do</span>
                          </div>
                          <div className="cal-grid">
                            {calDays.map((day, idx) => (
                              <button
                                key={idx}
                                type="button"
                                className={`cal-day${!day ? ' empty' : ''}${
                                  day && nuevaAsignacion.fecha ===
                                  `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
                                    ? ' selected'
                                    : ''
                                }`}
                                onClick={() => selectCalendarDay(day)}
                                disabled={!day}
                              >
                                {day}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="form-group">
                    <label>
                      Vendedores ({vendedoresSeleccionados.length}/{vendedores.length})
                    </label>
                    {/*
                      `btn-suave` es blanco sobre transparente: estaba hecho para la cabecera
                      morada. Aquí el fondo es blanco, así que este botón llevaba todo este
                      tiempo siendo invisible: ocupaba su sitio y no se veía.
                    */}
                    <button type="button" className="btn btn-suave btn-sm" onClick={toggleTodosVendedores}>
                      {vendedoresSeleccionados.length === vendedores.length ? 'Desmarcar Todos' : 'Seleccionar Todos'}
                    </button>
                    <div className="vendedores-checklist">
                      {vendedores.map((v) => (
                        <label key={v.id} className="vendedor-check">
                          <input
                            type="checkbox"
                            checked={vendedoresSeleccionados.includes(v.nombre)}
                            onChange={() => alternarVendedor(v.nombre)}
                          />
                          <span>{v.nombre}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <button
                    type="submit"
                    className="btn btn-success btn-block"
                    disabled={vendedoresSeleccionados.length === 0 || !!guardando}
                  >
                    {guardando ? (
                      <>
                        <span className="spinner spinner-chico" aria-hidden="true"></span>
                        Guardando {guardando.hechas}/{guardando.total}…
                      </>
                    ) : (
                      <>
                        <AppIcon name="save" size={16} /> Guardar Asignación ({vendedoresSeleccionados.length}{' '}
                        vendedor{vendedoresSeleccionados.length !== 1 ? 'es' : ''})
                      </>
                    )}
                  </button>
                </form>
              </div>
            </div>
          </div>
        )}
      </Transition>

      {/* El detalle de una fila: ventana en escritorio, cajón en móvil. Fuera de la
          rejilla, para que abrirlo no mueva de sitio a los demás vendedores. */}
      <Transition name="ventana" nodeKey={filaExpandida || null}>
        {filaExpandida && detalleDe && (
          <div className="capa" onClick={(e) => e.target === e.currentTarget && cerrarDetalle()}>
            <div className="hoja" role="dialog" aria-modal="true" aria-labelledby="hoja-titulo">
              {/* El asa sólo se ve en el móvil: es lo que dice que esto es un cajón y
                   que se cierra tirando hacia abajo. */}
              <span className="hoja-asa" aria-hidden="true"></span>
              <header className="hoja-cabeza">
                <div className="hoja-quien">
                  <p id="hoja-titulo">{nombreCorto(detalleDe.producto_nombre)}</p>
                  <p className="hoja-vendedor">{detalleDe.vendedor}</p>
                </div>
                <button type="button" className="hoja-cerrar" aria-label="Cerrar" onClick={cerrarDetalle}>
                  <AppIcon name="x" size={18} />
                </button>
              </header>

              <div className="hoja-cuerpo">
                {/*
                  Aquí sí caben todas las cifras, porque hay sitio para decir qué es cada
                  una. En la tarjeta sólo van tres; seis números seguidos sin explicación no
                  se leen.
                */}
                {detalleDe.prod && (
                  <dl className="cifras">
                    <div>
                      <dt>Asignado</dt>
                      <dd>{detalleDe.prod.asignado}</dd>
                    </div>
                    <div>
                      <dt>
                        Despachado <small>facturas de Ventra</small>
                      </dt>
                      <dd className="c-verde">{detalleDe.prod.completada}</dd>
                    </div>
                    {detalleDe.prod.en_proceso ? (
                      <div>
                        <dt>
                          En proceso <small>pedido y sin facturar</small>
                        </dt>
                        <dd className="c-ambar">{detalleDe.prod.en_proceso}</dd>
                      </div>
                    ) : null}
                    {detalleDe.prod.cerrado_sin_factura ? (
                      <div>
                        <dt>
                          Cerrado sin factura <small>no va a salir solo</small>
                        </dt>
                        <dd className="c-rojo">{detalleDe.prod.cerrado_sin_factura}</dd>
                      </div>
                    ) : null}
                  </dl>
                )}

                {loadingDetalle ? (
                  <p className="detalle-aviso">Cargando…</p>
                ) : errorDetalle ? (
                  <div className="detalle-fallo">
                    <AppIcon name="alert" size={18} />
                    <p>{errorDetalle}</p>
                    <button type="button" className="btn-reintentar" onClick={() => traerDetalle(true)}>
                      Reintentar
                    </button>
                  </div>
                ) : pedidosDelDetalle.length === 0 ? (
                  <>
                    <p className="detalle-aviso">No queda ningún pedido por despachar de este producto</p>
                    {sinCasarDeEste.length > 0 && (
                      <div className="detalle-sincasar" role="status">
                        <AppIcon name="alert" size={15} />
                        <div>
                          <strong>Pero sí hay líneas suyas que no se pudieron asociar:</strong> su nombre no encaja con
                          ningún producto de Ventra, así que no se están contando en ningún sitio.
                          <ul>
                            {sinCasarDeEste.map((l) => (
                              <li key={l.producto}>
                                {l.producto}{' '}
                                <em>
                                  · {l.pedidos} {l.pedidos === 1 ? 'pedido' : 'pedidos'} · {l.packs} packs
                                </em>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="detalle-titulo">Pedidos sin despachar ({pedidosDelDetalle.length})</div>
                    <ul className="pedido-lista">
                      {pedidosVisibles.map((ped, idx) => (
                        <li key={idx} className="pedido">
                          <span className="pedido-folio">{ped.folio}</span>
                          <span className="pedido-cliente">{ped.cliente_nombre || 'Sin cliente'}</span>
                          <span className="pedido-packs">{ped.packs}</span>
                          <span className="pedido-fecha">{ped.fecha ? ped.fecha.split('T')[0] : '—'}</span>
                          <span className="pedido-estado">
                            {ped.factura_estado === 'cambiado' ? (
                              <span
                                className="sello s-cambiado"
                                title={
                                  ped.factura
                                    ? `Factura ${ped.factura}: se facturó algo distinto de lo pedido`
                                    : 'Se facturó algo distinto de lo pedido'
                                }
                              >
                                Facturó y cambió
                              </span>
                            ) : ped.facturado ? (
                              <span className="sello s-facturado" title={ped.factura ? `Factura ${ped.factura}` : 'Facturado'}>
                                Facturado
                              </span>
                            ) : null}
                            {ped.cerrado_sin_factura ? (
                              <span
                                className="sello s-cerrado"
                                title="PEDIDO lo dio por completado y Ventra nunca lo facturó"
                              >
                                Cerrado sin factura
                              </span>
                            ) : (
                              <span className="sello s-proceso">Sin factura</span>
                            )}
                            {ped.cobrado_vendedor ? (
                              <span
                                className="sello s-cobrado"
                                title="El vendedor lo declaró cobrado. Es otra cosa que estar facturado."
                              >
                                Cobrado
                              </span>
                            ) : null}
                            {ped.cobrado_manual ? (
                              <span className="sello s-manual" title="Marcado a mano desde esta aplicación">
                                Marcado
                              </span>
                            ) : null}
                          </span>
                        </li>
                      ))}
                    </ul>

                    {/* Sólo cuando hay más de una página: con ocho pedidos estorba. */}
                    {paginasDetalle > 1 && (
                      <div className="detalle-paginas">
                        <button
                          type="button"
                          disabled={paginaDetalleActual === 1}
                          aria-label="Anterior"
                          onClick={() => setPaginaDetalle(paginaDetalleActual - 1)}
                        >
                          <AppIcon name="chevronLeft" size={15} />
                        </button>
                        <span>
                          {paginaDetalleActual} de {paginasDetalle}
                        </span>
                        <button
                          type="button"
                          disabled={paginaDetalleActual === paginasDetalle}
                          aria-label="Siguiente"
                          onClick={() => setPaginaDetalle(paginaDetalleActual + 1)}
                        >
                          <AppIcon name="chevronRight" size={15} />
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </Transition>

      {/*
        El aviso de lo que se hizo. Fuera de las ventanas y con z-index por encima de
        todas: tiene que verse también con el formulario abierto, que es justo cuando
        más dudas quedan («¿se guardó?»).
      */}
      {nota && (
        <div className={`nota nota-${nota.tipo}`} role="status" aria-live="polite">
          <span className="nota-icono">
            <AppIcon name={nota.tipo === 'ok' ? 'check' : 'alert'} size={18} />
          </span>
          <div className="nota-texto">
            <strong>{nota.titulo}</strong>
            {nota.texto && <span>{nota.texto}</span>}
          </div>
          <button type="button" className="nota-cerrar" aria-label="Cerrar aviso" onClick={() => setNota(null)}>
            <AppIcon name="x" size={16} />
          </button>
        </div>
      )}

    </div>
  )
}
