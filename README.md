# Internes Mixed Turnier

Dies ist eine Node App, welche einen Turnierspielplan anzeigt. Das ganze läuft
in einem Docker Container, so das es einfach auf einen Cloudserver geladen
werden kann. Der Server zeigt einen QR-Code auf der Hauptseite an, bei dem man
sich anmelden kann. Beim Anmelden wird dem Client ein Webformular geschickt,
bei dem man sich anmelden kann. Dort gibt man Name und Team ein. Das Team wird
aus einer Dropdonwliste die vom Server erstellt wird gewählt. Der Server
verteilt dann bei der Anmeldung ein ID-Token an den Client, dieses wird im
localstorage des klienten gespeichert. Das Turnier wird gestartet indem auf dem
Server auf der Webseite der start button betätigt wird.

Der Server erstellt dann zufällige teams für jede spielrunde. Da zeigt der
server wieder einen qr-code für die runde an, bzw der client hat das bereits
auf seiner webseite. Dort wird angezeigt auf welchem feld man spielt, oder ob
man gerade pause hat. Man kann auch früher gehen und sich vom turnier abmelden,
oder später dazu kommen und sich noch nachmelden. 

Der Server speichert eine Liste der vergangenen Teams, um darauf zu achten das
spieler nicht zu oft miteinander spielen. Sicher nicht mehr wie 2 mal
nacheinander, und wenn möglich nicht mehr wie 4 mal am abend. Falls da keine
neuen teams gemacht werden können ohne diese constraints zu verletzen, dann
darf das trotzdem so sein. Die Teams werden in jeder runde neu gemischt. Es
gibt immer 6 Teams mit maximal 6 personen. Wenn mehr spieler da sind, haben die
übrigen einfach pause. Man hat nie mehr wie einmal pause hintereinander, und
nicht mehr wie einmal pause im ganzen turnier. Man kann eine pause auch
freiwillig eingeben, aber noch vor dem rundenstart. Man hat erst 2 pausen,
falls alle anderen schon mal pause hatten.

## Deployment auf einem Cloud-Server (mit HTTPS)

Die App läuft hinter **Caddy** als Reverse Proxy, der automatisch ein
kostenloses SSL-Zertifikat via Let's Encrypt holt und erneuert.

### Voraussetzungen

- Server mit Ubuntu 22.04+ (DigitalOcean, Linode, etc.)
- Docker + Docker Compose installiert
- Eine Domain, deren A-Record auf die Server-IP zeigt
- Ports 80 und 443 in der Firewall freigegeben

### Schritte

**1. Repo auf den Server klonen:**
```bash
git clone <repo-url> mixed-tournament
cd mixed-tournament
```

**2. `.env` Datei anlegen:**
```bash
cp .env.example .env
```

`.env` anpassen:
```
PORT=3000
BASE_URL=https://deine-domain.de
ADMIN_PASSWORD=sicheres-passwort
DB_PATH=./data/tournament.db
DOMAIN=deine-domain.de
```

**3. `Caddyfile` anpassen:**

Die Zeile `{$DOMAIN:deine-domain.de}` wird automatisch aus der `DOMAIN`
Umgebungsvariable gelesen. Alternativ direkt im `Caddyfile` ersetzen.

**4. App starten:**
```bash
docker compose up -d --build
```

Caddy holt beim ersten Start automatisch das SSL-Zertifikat. Die App ist
danach unter `https://deine-domain.de` erreichbar.

**Logs ansehen:**
```bash
docker compose logs -f
```

**App stoppen:**
```bash
docker compose down
```
