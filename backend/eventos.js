/**
 * Que los cambios lleguen solos a las pantallas abiertas.
 *
 * # Qué había antes
 *
 * Cada navegador pedía `/api/dashboard` **cada 30 segundos** y comparaba el resultado
 * consigo mismo para ver si algo había cambiado. Con cinco pestañas abiertas eran diez
 * consultas por minuto a PEDIDO y a Ventra por la VPN para, casi siempre, recibir lo
 * mismo. Y aun así había que recargar: el aviso decía «hay cambios», no los traía.
 *
 * # Cómo funciona ahora
 *
 * El navegador **no pregunta nunca**. Abre una conexión a `/api/eventos` y se queda
 * escuchando (SSE: es HTTP normal, lo reabre el propio navegador si se corta, y no hace
 * falta WebSocket ni nada que Traefik tenga que aprender).
 *
 * Quien mira si algo cambió es el SERVIDOR, una vez para todos: un vigilante recalcula el
 * panel cada minuto, le saca una huella y **sólo si la huella cambió** avisa. Un latido,
 * no N.
 *
 * # Por qué Redis en medio
 *
 * Por dos cosas. La primera, para que el día que haya dos copias del backend el aviso
 * llegue a las pantallas conectadas a LAS DOS: se publica en un canal y cada copia se lo
 * pasa a sus propios oyentes. La segunda, porque el vigilante coge un cerrojo con caducidad
 * antes de recalcular, así que con dos copias no se duplica el trabajo contra Ventra.
 *
 * Si Redis no está, esto sigue funcionando en local —una sola copia, avisos directos—.
 * Vale más un aviso que no cruza máquinas que una pantalla muerta.
 */
import { createClient } from 'redis';

const URL = process.env.REDIS_URL || '';
const CANAL = 'asignacion:cambios';
/** Con prefijo propio: se comparte el Redis de la casa, no se invade. */
const CERROJO = 'asignacion:vigilante';

/** Las respuestas HTTP que están escuchando en ESTA copia del backend. */
const oyentes = new Set();

let publicador = null;
let suscriptor = null;

export function redisListo() {
  return Boolean(publicador?.isOpen);
}

export async function arrancarEventos() {
  if (!URL) {
    console.log('[eventos] sin REDIS_URL: los avisos no cruzan entre copias del backend');

    return;
  }

  try {
    publicador = createClient({ url: URL });
    suscriptor = publicador.duplicate();

    // Que un corte de Redis no tumbe el proceso: el cliente reconecta solo.
    for (const c of [publicador, suscriptor]) {
      c.on('error', (e) => console.warn('[eventos] redis:', e.message));
    }

    await publicador.connect();
    await suscriptor.connect();
    await suscriptor.subscribe(CANAL, (mensaje) => repartir(mensaje));

    console.log('[eventos] conectado a Redis; avisos por el canal', CANAL);
  } catch (e) {
    console.warn('[eventos] no se pudo conectar a Redis:', e.message);
    publicador = null;
    suscriptor = null;
  }
}

/** Manda el aviso a las pantallas de esta copia. */
function repartir(mensaje) {
  for (const res of oyentes) {
    try {
      res.write(`data: ${mensaje}\n\n`);
    } catch {
      oyentes.delete(res);
    }
  }
}

/**
 * Avisar de que algo cambió.
 *
 * `que` dice QUÉ cambió —`asignaciones`, `panel`— para que la pantalla recargue sólo eso
 * en vez de todo. Sin Redis se reparte en el sitio, que es lo correcto con una sola copia.
 */
export async function avisar(que, detalle = {}) {
  const mensaje = JSON.stringify({ que, ...detalle, cuando: new Date().toISOString() });

  if (publicador?.isOpen) {
    try {
      await publicador.publish(CANAL, mensaje);

      return;
    } catch (e) {
      console.warn('[eventos] no se pudo publicar:', e.message);
    }
  }

  repartir(mensaje);
}

/**
 * El cerrojo del vigilante.
 *
 * `NX` con caducidad: lo coge uno solo y se suelta solo si el proceso se muere. Sin Redis
 * devuelve `true` —una sola copia, no hay con quién competir—.
 */
export async function puedoVigilar(segundos) {
  if (!publicador?.isOpen) return true;

  try {
    return (await publicador.set(CERROJO, String(process.pid), { NX: true, EX: segundos })) === 'OK';
  } catch {
    return true;
  }
}

/** Engancha una pantalla. Devuelve la función para soltarla. */
export function escuchar(req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx delante: sin esto guarda la respuesta y no llega nada hasta que se cierra.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  // El primer aviso dice que la conexión está viva, para no quedarse mirando una pantalla
  // en blanco sin saber si funciona.
  res.write(`data: ${JSON.stringify({ que: 'conectado' })}\n\n`);

  oyentes.add(res);

  /*
   * Un `:` cada 25 segundos.
   *
   * Es un comentario de SSE: el navegador lo ignora. Existe para que ni Traefik ni nginx
   * den la conexión por muerta y la corten a los 30 o 60 segundos de silencio, que es lo
   * que pasa cuando de verdad no cambia nada en un rato.
   */
  const latido = setInterval(() => {
    try {
      res.write(': sigo aquí\n\n');
    } catch {
      clearInterval(latido);
    }
  }, 25000);

  const soltar = () => {
    clearInterval(latido);
    oyentes.delete(res);
  };

  req.on('close', soltar);

  return soltar;
}

export function cuantosEscuchan() {
  return oyentes.size;
}
