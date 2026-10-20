# Nuvio Lite — TizenBrew module

Backport ES5 de Nuvio para Samsung TV Tizen 3.0 (2017, Chromium M47), empaquetado como módulo de [TizenBrew](https://github.com/reisxd/TizenBrew).

## Arquitectura

- **TV**: esta app (web, ES5, liviana) — solo dibuja y reproduce (AVPlay).
- **Bridge**: `nuvio-bridge` corriendo en la LAN (MacBook Air) en `http://192.168.3.11:7070` — hace el trabajo pesado (catálogos TMDB, addons/streams, proxy de video/subtítulos, cuenta).

## Instalación (en TizenBrew)

1. TizenBrew → Modules → **Add GitHub** → `iluisda/nuvio-lite-tizenbrew`
2. Lanzar **Nuvio Lite**.

## Requisitos

- Bridge encendido en la LAN (Air, puerto 7070).
- TizenBrew instalado en la TV.

## UI (rediseño)

La interfaz sigue el lenguaje visual de Nuvio TV (tokens tomados de su `bundle.css`):

- Fondo `#0d0d0d`, superficie `#1a1a1a`, tarjeta `#222`, borde `#333`.
- Texto `#fff` / `#b3b3b3` / `#808080`; foco blanco (`0 0 0 3px #fff`) y `#303030` de fondo.
- Pósters 212×318 con radio 22px, tarjetas de carpeta 16:9.
- Barra lateral de 144px con logo, Inicio / Mi biblioteca / Buscar (se abre con IZQUIERDA desde la primera columna).
- Home con hero cinematográfico: al enfocar una tarjeta se carga su `backdrop`, logo y sinopsis desde `/api/meta`; al bajar de la primera fila el hero se atenúa y las filas suben.
- Detalle con logo, metadatos, acciones y episodios; fuentes, colecciones, carpetas y buscador con el mismo estilo.

Sin variables CSS, `grid`, `gap` ni `aspect-ratio`: el motor de la TV no los soporta. Todo el layout usa `inline-block`/`table`, `calc()` y gradientes.

### Mi biblioteca (guardados, sincronizada con la cuenta)

- Vive en la cuenta Nuvio (`sync_pull_library` / `sync_push_library` vía bridge) y se cachea en `localStorage` (`nuvio.lite.library.v1`) para arrancar sin red.
- Botón `+ Mi biblioteca` en el detalle de películas y series; alterna guardado/quitado y empuja la lista al bridge.
- La vista `Mi biblioteca` lista los títulos guardados en grilla de 7 columnas, con el mismo foco que las filas.
- Al abrir la vista se hace pull de la cuenta: lo guardado en el desktop aparece en la tele.

### Vistos (sincronizado con la cuenta)

- `sync_pull_watched_items` / `sync_push_watched_items` / `sync_delete_watched_items` vía bridge; cache local en `nuvio.lite.watched.v1`.
- Películas: botón `Marcar visto` en el detalle. Series: tecla **AZUL** del mando marca/desmarca el episodio enfocado.
- Badge `✓` en pósters y `✓ Visto` en episodios. La fila “Seguir viendo” filtra lo ya visto.

### TV en vivo y deportes

- Filas `channel` / `sport` / `tv` de los addons (FrostView, Sports Streams, NexoTV) se abren directo en el player, sin pasar por TMDB.
- Zapping: **ARRIBA/ABAJO** cambia de canal mientras reproduce; **BACK** vuelve al home.
- HLS: el bridge reescribe playlists (`&hls=1`) y la app usa `hls.js` 0.14 (ES5, compatible con M47). Si el canal entrega MP4 directo, va por `<video>` normal.

### Auto-next, subtítulos y ajustes

- Al terminar un episodio aparece “Siguiente episodio” con cuenta de 5 s; **OK** reproduce ya, **ATRÁS** cancela.
- Subtítulos: idioma preferido (pt-BR por defecto), tamaño Normal/Grande/Muy grande; se auto-selecciona una pista del addon si coincide.
- Vista **Ajustes** (engranaje del rail): subtítulos, tamaño, auto-next, sincronizar biblioteca.

### Ver todo / paginación

- Cada fila de catálogo termina en una tarjeta **Ver todo** que abre la grilla completa con scroll y páginas nuevas (`skip`).
- Las carpetas (incluidas las colecciones de AIOMetadata) cargan más items al llegar al final de la grilla.

### Endpoints nuevos del bridge

- `/api/meta/:type/:id` acepta `channel`, `sport`, `tv`, `collection` y hace fallback al `meta` del addon.
- `/api/streams/:type/:id` usa el tipo nativo para canales/deportes (sin conversión a IMDb).
- `/api/proxy?...&hls=1` reescribe playlists HLS (segmentos, claves y variantes) por el proxy.
- `/me/library` (GET/POST) y `/me/watched` (GET/POST) contra los RPC de sync de la cuenta.

