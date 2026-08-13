"""Pool de conexiones a PostGIS."""
import asyncpg

from . import config

_pool: asyncpg.Pool | None = None


async def iniciar() -> None:
    global _pool
    # min_size bajo: la VPS es pequena y el equipo es reducido.
    _pool = await asyncpg.create_pool(
        config.DATABASE_URL,
        min_size=1,
        max_size=8,
        command_timeout=60,
    )


async def cerrar() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("El pool no esta iniciado")
    return _pool
