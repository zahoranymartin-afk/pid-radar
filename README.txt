PID MAPA – PRAHA + STŘEDOČESKÝ KRAJ
======================================

Co potřebuješ:
1. Windows
2. Node.js (LTS) – zdarma
3. Internet

Spuštění:
1. Rozbal tento ZIP.
2. Otevři složku pid-mapa.
3. Klikni do adresního řádku Průzkumníka, napiš cmd a Enter.
4. Napiš:
   npm install
5. Potom:
   npm start
6. V prohlížeči otevři:
   http://localhost:3000

Mapa používá:
- Leaflet
- OpenStreetMap
- PID Open Data / GTFS Realtime
- vlastní Node.js server

Žádný placený Mapbox apod. není potřeba.

Poznámka:
Živý GTFS-RT endpoint může poskytovatel kdykoli změnit podmínky přístupu.
Pokud začne vracet 401/403, mapa zůstane funkční, ale živá vozidla se
nenačtou. V takovém případě je potřeba upravit zdroj dat podle aktuálních
podmínek PID/Golemio.

Licence/atribuce:
Data: PID Open Data
Mapa: © OpenStreetMap contributors
