"""Worker de conversion de rasters.

Corre en su propio contenedor, separado de la API. Convertir una escena de
gigapixeles a COG ocupa CPU durante minutos; hacerlo dentro del proceso que
atiende la web dejaria el visor lento para todo el equipo justo cuando mas
se necesita.

Toma trabajos de la tabla `rasters` con FOR UPDATE SKIP LOCKED, de modo que
anadir mas workers en el futuro no requiere ningun cambio.
"""
import asyncio
import logging
import os
import signal

from . import config, db
from .routers.rasters import procesar_raster

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("trabajador")

ESPERA_SIN_TRABAJO = 3          # segundos entre sondeos cuando la cola esta vacia
LIMITE_ATASCO_HORAS = 6         # tras esto, un trabajo se da por caido y se reintenta

_parar = asyncio.Event()


async def _recuperar_atascados() -> None:
    """Devuelve a la cola lo que quedo a medias por un reinicio.

    Sin esto, un contenedor que se reinicia a mitad de una conversion deja la
    capa marcada 'procesando' para siempre y nadie sabe por que no aparece.
    """
    recuperados = await db.pool().fetch(
        """
        UPDATE rasters
           SET estado = 'pendiente', procesando_desde = NULL
         WHERE estado = 'procesando'
           AND (procesando_desde IS NULL
                OR procesando_desde < now() - ($1 || ' hours')::interval)
        RETURNING id, nombre
        """,
        str(LIMITE_ATASCO_HORAS),
    )
    for fila in recuperados:
        log.warning("Recuperado trabajo atascado: #%s %s", fila["id"], fila["nombre"])


async def _tomar_trabajo():
    """Reclama un trabajo pendiente de forma atomica."""
    return await db.pool().fetchrow(
        """
        UPDATE rasters
           SET estado = 'procesando', procesando_desde = now()
         WHERE id = (
               SELECT id FROM rasters
                WHERE estado = 'pendiente'
                ORDER BY id
                FOR UPDATE SKIP LOCKED
                LIMIT 1)
        RETURNING id, nombre, origen, destino
        """
    )


async def _atender(trabajo) -> None:
    id_raster = trabajo["id"]
    origen, destino = trabajo["origen"], trabajo["destino"]
    log.info("Convirtiendo #%s %s", id_raster, trabajo["nombre"])

    if not origen or not os.path.exists(origen):
        await db.pool().execute(
            "UPDATE rasters SET estado='error', mensaje=$2 WHERE id=$1",
            id_raster, "El archivo de origen ya no esta en el servidor.")
        log.error("#%s sin archivo de origen (%s)", id_raster, origen)
        return

    tamano_mb = os.path.getsize(origen) / 1024 / 1024
    inicio = asyncio.get_event_loop().time()
    await procesar_raster(id_raster, origen, destino)
    duracion = asyncio.get_event_loop().time() - inicio

    estado = await db.pool().fetchval("SELECT estado FROM rasters WHERE id=$1", id_raster)
    log.info("#%s termino en %s -> %.0f s (%.0f MB)", id_raster, estado, duracion, tamano_mb)


async def _limpiar_subidas_abandonadas() -> None:
    """Borra los parciales que nadie retomo, para no llenar el disco."""
    abandonadas = await db.pool().fetch(
        """
        DELETE FROM subidas
         WHERE actualizado_en < now() - ($1 || ' hours')::interval
        RETURNING id, archivo
        """,
        str(config.HORAS_SUBIDA_ABANDONADA),
    )
    for fila in abandonadas:
        ruta = os.path.join(config.DIR_PARCIALES, f"{fila['id']}.part")
        if os.path.exists(ruta):
            try:
                os.remove(ruta)
                log.info("Subida abandonada eliminada: %s", fila["archivo"])
            except OSError:
                pass


async def principal() -> None:
    for carpeta in (config.DIR_RASTERS, config.DIR_ENTRADA, config.DIR_PARCIALES):
        os.makedirs(carpeta, exist_ok=True)

    await db.iniciar()
    log.info("Worker listo. Vigilando la cola de conversion.")
    await _recuperar_atascados()

    ciclos = 0
    while not _parar.is_set():
        try:
            trabajo = await _tomar_trabajo()
            if trabajo:
                await _atender(trabajo)
                continue

            ciclos += 1
            # Cada ~10 minutos de calma, tareas de mantenimiento.
            if ciclos % (600 // ESPERA_SIN_TRABAJO) == 0:
                await _limpiar_subidas_abandonadas()
                await _recuperar_atascados()

            try:
                await asyncio.wait_for(_parar.wait(), timeout=ESPERA_SIN_TRABAJO)
            except asyncio.TimeoutError:
                pass
        except Exception:
            log.exception("Fallo en el ciclo del worker; se reintenta")
            await asyncio.sleep(5)

    await db.cerrar()
    log.info("Worker detenido.")


if __name__ == "__main__":
    bucle = asyncio.new_event_loop()
    asyncio.set_event_loop(bucle)
    for senal in (signal.SIGTERM, signal.SIGINT):
        bucle.add_signal_handler(senal, _parar.set)
    bucle.run_until_complete(principal())
