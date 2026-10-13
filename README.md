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
