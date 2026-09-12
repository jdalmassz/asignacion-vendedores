# Asignación de vendedores — cómo corre

## Las dos piezas

| | Qué es | Puerto |
|---|---|---|
| `backend/` | Express 5. Lee productos y ventas de MySQL, pide pedidos a la API de PEDIDO, y **guarda lo suyo en MongoDB** | 4000 |
| `frontend/` | Vue + Vite, servido por nginx, que además reenvía `/api` al backend | 80 |

## Dónde se guardan los datos

**En MongoDB, no en ficheros.** Antes eran `asignaciones.json` y `cobros.json` escritos al
lado del código, y eso **se pierde entero en cada despliegue**: el contenedor se recrea
desde la imagen. Funcionaba en el portátil y habría borrado el trabajo de todos la primera
vez que se subiera.

Dos colecciones, en la base `asignacion_vendedores`:

- **`asignaciones`** — `{ vendedor, producto_id, producto_nombre, cantidad, fecha }`
- **`cobros`** — `{ folio, fecha }`, con el folio **único**

**Los productos, las ventas y el almacén salen de la API de Ventra**, no de MySQL. El
código leía la base `camaguey` en `192.168.1.217` —una dirección de la red local de la
sucursal— y eso desde el servidor no se alcanza: resumen, almacén y dashboard daban 500.

| Antes, en MySQL | Ahora, en Ventra |
|---|---|
| `goods` | `/axis/products` |
| `operations` | `/axis/sales` |
| `store` | `/axis/stock` |

Dos cosas que esto obliga y conviene saber:

- **Se cruza por código de producto**, no por el `GoodID` numérico: Ventra no publica ese
  número. Es más robusto, porque el código es el mismo en todas las sucursales.
- **`/axis/stock` ignora el parámetro `database`** y devuelve las diez sucursales. Se
  filtra por `VENTRA_SUCURSAL`; sin eso, el almacén de Camagüey saldría mezclado con el de
  La Habana y Santiago.

## Variables de entorno

```
MONGO_URL            mongodb://usuario:clave@procovar-mongo-ylchvv:27017/?authSource=admin
MONGO_DB             asignacion_vendedores
VENTRA_API_URL       http://10.188.2.2:3001/api/external-api
VENTRA_API_TOKEN     el token de Ventra (el mismo que usa analitics)
VENTRA_DB            camaguey
VENTRA_SUCURSAL      CAMAGUEY
PROCOVAR_API_BASE    https://pedidos.procovar.cloud/api
PROCOVAR_API_KEY     la clave de integración
PROCOVAR_SUCURSAL_ID
PORT                 4000 por defecto
```

El frontend necesita saber a dónde reenviar `/api`, porque el nombre del backend lo
genera el servidor con un sufijo:

```
BACKEND_HOST         asignacion-backend-jbveio
BACKEND_PORT         4000
```

Se sustituyen **al arrancar** (plantilla de nginx), así que cambiarlos no obliga a
reconstruir. El resto lo llama a `/api` y nginx lo reenvía. `VITE_API_URL` existe
por si algún día hay que apuntar a otro sitio, y **se aplica al construir**, no al arrancar.

## Traer los datos viejos

Una sola vez, y sólo si quedan ficheros JSON con datos:

```bash
cd backend
MONGO_URL="..." node migrar.js
```

Es repetible: correrlo dos veces no duplica nada. **No se ejecuta solo al arrancar** a
propósito — una migración que corre en cada despliegue es una que un día duplica todo.

## En el portátil

```bash
cd backend  && npm install && npm run dev     # http://localhost:4000
cd frontend && npm install && npm run dev     # http://localhost:8093
```

El frontend llama a `/api` y Vite lo reenvía al backend, igual que nginx en el servidor:
así el código es el mismo en los dos sitios y no hay que acordarse de cambiar nada al subir.

## Lo que se arregló al montarlo

- **Los datos ya no se pierden** en cada despliegue (era lo grave).
- **El id de una asignación ya no es `length + 1`.** Con eso, borrar la 3 de 5 hacía que la
  siguiente volviera a ser la 5: dos registros con el mismo id, y borrar uno borraba los dos.
- **El mes ya no está escrito a mano.** Había un `startsWith('2026-09')` incrustado: en
  octubre la pantalla se habría quedado vacía sin que nadie supiera por qué.
- **La dirección de la API ya no es `localhost:4000`**, que fuera del portátil hacía que el
  navegador del usuario hablara con su propio ordenador.
- **Marcar un cobro dos veces** deja una sola marca, por índice único y `upsert` — antes se
  comprobaba y luego se escribía, y entre las dos cosas caben dos peticiones a la vez.
- **Cualquier fallo contesta 500 con su motivo.** Antes un error dentro de un `async` dejaba
  la petición colgada y en pantalla se veía un spinner eterno.
