const http = require('http');
const fs = require('fs');
const path = require('path');
const { Throttle } = require('throttle');
const archiver = require('archiver');
const fsPromises = fs.promises;

const PORT = process.env.PORT || 8100; // Si adatta automaticamente ad Alwaysdata
const TRACKS_DIR = path.join(__dirname, 'tracks');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Assicurati che la cartella dei brani esista
if (!fs.existsSync(TRACKS_DIR)) fs.mkdirSync(TRACKS_DIR);

// Analizza l'header del primo frame MP3 per rilevare il bitrate (evita false corrispondenze saltando ID3v2)
function getMp3Bitrate(filePath) {
    try {
        const fd = fs.openSync(filePath, 'r');
        const headerBuffer = Buffer.alloc(10);
        fs.readSync(fd, headerBuffer, 0, 10, 0);

        let startOffset = 0;
        if (headerBuffer.toString('utf8', 0, 3) === 'ID3') {
            const size = ((headerBuffer[6] & 0x7F) << 21) |
                ((headerBuffer[7] & 0x7F) << 14) |
                ((headerBuffer[8] & 0x7F) << 7) |
                (headerBuffer[9] & 0x7F);
            startOffset = size + 10;
        }

        const scanBuffer = Buffer.alloc(8192);
        const bytesRead = fs.readSync(fd, scanBuffer, 0, 8192, startOffset);
        fs.closeSync(fd);

        let i = 0;
        while (i < bytesRead - 4) {
            if (scanBuffer[i] === 0xFF && (scanBuffer[i + 1] & 0xE0) === 0xE0) {
                const mpegVersion = (scanBuffer[i + 1] & 0x18) >> 3;
                const layer = (scanBuffer[i + 1] & 0x06) >> 1;
                const bitrateIndex = (scanBuffer[i + 2] & 0xF0) >> 4;

                if (layer === 1 && bitrateIndex > 0 && bitrateIndex < 15) {
                    if (mpegVersion === 3) {
                        const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
                        return bitrates[bitrateIndex];
                    } else if (mpegVersion === 2 || mpegVersion === 0) {
                        const bitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
                        return bitrates[bitrateIndex];
                    }
                }
            }
            i++;
        }
    } catch (e) {
        console.error("Errore nel rilevamento del bitrate MP3:", e);
    }
    return 128; // Fallback predefinito
}

function checkAdminAuth(req) {
    return req.headers['x-pin'] === '7777';
}

// Classe per gestire la "Radio" di ogni singolo genere
class RadioStation {
    constructor(genre) {
        this.genre = genre;
        this.clients = new Set();
        this.isPlaying = false;

        // Nuove variabili per lo shuffle
        this.queue = [];                   // La coda dei brani da riprodurre
        this.history = [];                 // Memoria delle ultime 5 canzoni suonate
        this.lastPlayedDay = new Date().getDate(); // Giorno corrente per il reset di mezzanotte
    }

    // Metodo per mescolare l'array (Algoritmo Fisher-Yates super leggero)
    reshuffle(files) {
        let shuffled = [...files];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }

        // Logica Anti-Ripetizione: Evita che le ultime 5 canzoni suonate finiscano all'inizio della nuova coda
        if (shuffled.length >= 10 && this.history.length > 0) {
            for (let i = 0; i < 5; i++) {
                if (this.history.includes(shuffled[i])) {
                    // Prende la canzone incriminata e la scambia con una a caso nella SECONDA METÀ della coda
                    let safeIndex = Math.floor(Math.random() * (shuffled.length / 2)) + Math.floor(shuffled.length / 2);
                    [shuffled[i], shuffled[safeIndex]] = [shuffled[safeIndex], shuffled[i]];
                }
            }
        } else if (shuffled.length > 1 && this.history.length > 0) {
            // Se ci sono poche canzoni, assicuriamoci almeno che la primissima non sia l'ultimissima appena suonata
            if (shuffled[0] === this.history[this.history.length - 1]) {
                [shuffled[0], shuffled[shuffled.length - 1]] = [shuffled[shuffled.length - 1], shuffled[0]];
            }
        }

        this.queue = shuffled;
    }

    start() {
        if (this.isPlaying) return;
        this.isPlaying = true;
        // Creiamo un canale di broadcast unico
        this.broadcast = new require('stream').PassThrough();
        this.broadcast.setMaxListeners(0); // Evita warning per troppi listener
        this.sseClients = new Set(); // Per il punto 2 (SSE)
        this.playNext();
    }

    playNext() {
        const genreDir = path.join(TRACKS_DIR, this.genre);
        if (!fs.existsSync(genreDir)) {
            this.isPlaying = false;
            return;
        }

        const files = fs.readdirSync(genreDir).filter(f => f.endsWith('.mp3'));
        if (files.length === 0) {
            this.queue = [];
            setTimeout(() => this.playNext(), 5000);
            return;
        }

        const currentDay = new Date().getDate();
        this.queue = this.queue.filter(f => files.includes(f));

        if (this.queue.length === 0 || currentDay !== this.lastPlayedDay) {
            this.reshuffle(files);
            this.lastPlayedDay = currentDay;
        }

        const trackToPlay = this.queue.shift();
        this.history.push(trackToPlay);
        if (this.history.length > 5) this.history.shift();

        const filePath = path.join(genreDir, trackToPlay);
        const bitrate = getMp3Bitrate(filePath); // Usa la tua funzione (es. 128)

        this.currentTrack = trackToPlay;
        this.trackStartedAt = Date.now();
        const fileSize = fs.statSync(filePath).size;
        this.trackDuration = Math.round(fileSize / ((bitrate * 1000) / 8));

        // Invia i metadati a tutti i client connessi via SSE
        this.broadcastMetadata();

        // 1. Legge il file
        const fileStream = fs.createReadStream(filePath);
        fileStream.on('error', (err) => {
            console.error(`[${this.genre}] Errore lettura file (forse eliminato?):`, err.message);
            this.playNext(); // Salta alla prossima
        });
        // 2. Regola la velocità di lettura in base al bitrate (byte al secondo)
        const throttle = new Throttle((bitrate * 1000) / 8);

        // Collega (pipe) i pezzi
        fileStream.pipe(throttle).pipe(this.broadcast, { end: false });

        throttle.on('end', () => {
            this.playNext(); // Quando finisce, passa alla prossima
        });

        throttle.on('error', (err) => {
            console.error("Errore stream:", err);
            this.playNext();
        });
    }

    addClient(req, res) {
        res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Transfer-Encoding': 'chunked',
            'Connection': 'keep-alive'
        });

        // Collega il client al canale di broadcast
        this.broadcast.pipe(res);
        this.clients.add(res);

        // Pulizia Memoria (Memory Leaks)
        const cleanup = () => {
            this.broadcast.unpipe(res);
            this.clients.delete(res);
            res.end();
        };

        req.on('close', cleanup);
        res.on('error', cleanup);
    }

    broadcastMetadata() {
        if (!this.sseClients) return;
        const data = JSON.stringify({
            track: this.currentTrack,
            duration: this.trackDuration,
            elapsed: 0 // Il client calcolerà l'avanzamento
        });
        for (let res of this.sseClients) {
            res.write(`data: ${data}\n\n`);
        }
    }
}

// Mappa per tenere traccia delle radio attive
const activeStations = new Map();

// Creazione del Server HTTP nativo
const server = http.createServer((req, res) => {
    // Analizziamo URL e pathname con l'oggetto standard URL
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // --- API PUBBLICHE / GENERALI ---

    // API per ottenere la lista dei generi disponibili (basato sulle cartelle esistenti)
    if (pathname === '/api/genres' && req.method === 'GET') {
        const folders = fs.readdirSync(TRACKS_DIR).filter(f => fs.statSync(path.join(TRACKS_DIR, f)).isDirectory());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(folders));
    }

    // API per ottenere info sul brano attualmente in riproduzione
    if (pathname === '/api/now-playing' && req.method === 'GET') {
        const genre = parsedUrl.searchParams.get('genre');
        if (!genre) {
            res.writeHead(400);
            return res.end();
        }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        let station = activeStations.get(genre);
        if (!station) {
            station = new RadioStation(genre);
            activeStations.set(genre, station);
        }

        if (!station.sseClients) station.sseClients = new Set();
        station.sseClients.add(res);

        // Invia subito lo stato attuale al client appena connesso
        const elapsed = station.trackStartedAt ? Math.round((Date.now() - station.trackStartedAt) / 1000) : 0;
        res.write(`data: ${JSON.stringify({ track: station.currentTrack || 'Nessun brano', duration: station.trackDuration || 0, elapsed })}\n\n`);

        req.on('close', () => {
            station.sseClients.delete(res);
        });
        return;
    }

    // Endpoint di Streaming per Web Player, VLC e MPV (es: /stream/trance)
    if (pathname.startsWith('/stream/')) {
        const genre = pathname.split('/')[2];
        const genreDir = path.join(TRACKS_DIR, genre);

        if (!fs.existsSync(genreDir) || !fs.statSync(genreDir).isDirectory()) {
            res.writeHead(404);
            return res.end('Genere non trovato');
        }

        if (!activeStations.has(genre)) {
            activeStations.set(genre, new RadioStation(genre));
        }

        const station = activeStations.get(genre);
        station.start();
        station.addClient(req, res);
        return;
    }

    // --- API DI AMMINISTRAZIONE (CON VERIFICA PIN) ---

    // Download di un singolo brano (con PIN passato come parametro della query)
    if (pathname === '/api/tracks/download' && req.method === 'GET') {
        const pin = parsedUrl.searchParams.get('pin');
        if (pin !== '7777') {
            res.writeHead(401);
            return res.end('Non autorizzato');
        }
        const genre = path.basename(parsedUrl.searchParams.get('genre') || '');
        const filename = path.basename(parsedUrl.searchParams.get('filename') || '');
        if (!genre || !filename) {
            res.writeHead(400);
            return res.end('Parametri mancanti');
        }
        const filePath = path.join(TRACKS_DIR, genre, filename);
        if (fs.existsSync(filePath)) {
            const stat = fs.statSync(filePath);
            res.writeHead(200, {
                'Content-Type': 'audio/mpeg',
                'Content-Disposition': `attachment; filename="${filename}"`,
                'Content-Length': stat.size
            });
            fs.createReadStream(filePath).pipe(res);
        } else {
            res.writeHead(404);
            return res.end('File non trovato');
        }
        return;
    }

    // Download dell'intero genere compresso (ZIP su Linux, TAR su Windows)
    if (pathname === '/api/genres/download' && req.method === 'GET') {
        const pin = parsedUrl.searchParams.get('pin');
        if (pin !== '7777') {
            res.writeHead(401);
            return res.end('Non autorizzato');
        }
        const genre = path.basename(parsedUrl.searchParams.get('genre') || '');
        const genreDir = path.join(TRACKS_DIR, genre);

        if (fs.existsSync(genreDir)) {
            res.writeHead(200, {
                'Content-Type': 'application/zip',
                'Content-Disposition': `attachment; filename="${genre}.zip"`
            });

            const archive = archiver('zip', { zlib: { level: 5 } }); // Compressione media, non blocca la CPU

            archive.on('error', (err) => {
                res.status(500).send({ error: err.message });
            });

            // Connette l'output di archiver direttamente alla risposta HTTP
            archive.pipe(res);
            archive.directory(genreDir, false);
            archive.finalize();
        } else {
            res.writeHead(404);
            return res.end('Genere non trovato');
        }
        return;
    }

    // Verifica del PIN
    if (pathname === '/api/admin/verify' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (data.pin === '7777') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: true }));
                } else {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: 'PIN errato' }));
                }
            } catch (e) {
                res.writeHead(400);
                return res.end('Bad Request');
            }
        });
        return;
    }

    // Lista canzoni per ciascun genere (dashboard admin)
    if (pathname === '/api/admin/tracks' && req.method === 'GET') {
        if (!checkAdminAuth(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Non autorizzato' }));
        }

        (async () => {
            try {
                const genres = [];
                let totalSize = 0;

                // Usiamo fsPromises invece di fs
                const items = await fsPromises.readdir(TRACKS_DIR, { withFileTypes: true });
                const folders = items.filter(dirent => dirent.isDirectory()).map(dirent => dirent.name);

                for (const genreName of folders) {
                    const genreDir = path.join(TRACKS_DIR, genreName);
                    const files = await fsPromises.readdir(genreDir);
                    const mp3Files = files.filter(f => f.endsWith('.mp3'));

                    const tracks = [];
                    let genreSize = 0;

                    // Promise.all velocizza la lettura dei file in parallelo
                    const statPromises = mp3Files.map(async (file) => {
                        const filePath = path.join(genreDir, file);
                        const stat = await fsPromises.stat(filePath);
                        return { name: file, size: stat.size };
                    });

                    const resolvedTracks = await Promise.all(statPromises);
                    resolvedTracks.forEach(t => genreSize += t.size);

                    genres.push({ name: genreName, size: genreSize, tracks: resolvedTracks });
                    totalSize += genreSize;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ genres, totalSize }));
            } catch (e) {
                console.error(e);
                res.writeHead(500);
                res.end('Errore interno del server');
            }
        })();
        return;
    }

    // Creazione nuovo genere
    if (pathname === '/api/genres' && req.method === 'POST') {
        if (!checkAdminAuth(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Non autorizzato' }));
        }

        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const safeName = data.name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
                if (!safeName) {
                    res.writeHead(400);
                    return res.end('Nome genere non valido');
                }
                const genreDir = path.join(TRACKS_DIR, safeName);
                if (!fs.existsSync(genreDir)) {
                    fs.mkdirSync(genreDir);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: true }));
                } else {
                    res.writeHead(400);
                    return res.end('Il genere esiste gia');
                }
            } catch (e) {
                res.writeHead(400);
                return res.end('Bad Request');
            }
        });
        return;
    }

    // Eliminazione di un genere
    if (pathname === '/api/genres' && req.method === 'DELETE') {
        if (!checkAdminAuth(req)) {
            res.writeHead(401);
            return res.end('Non autorizzato');
        }
        const genre = path.basename(parsedUrl.searchParams.get('genre') || '');
        if (!genre) {
            res.writeHead(400);
            return res.end('Genere mancante');
        }
        const genreDir = path.join(TRACKS_DIR, genre);
        if (fs.existsSync(genreDir) && fs.statSync(genreDir).isDirectory()) {
            // Ferma la stazione radio attiva del genere per rilasciare i file descriptor
            if (activeStations.has(genre)) {
                const station = activeStations.get(genre);
                // Chiude lo stream audio principale
                if (station.broadcast) station.broadcast.end();
                for (let client of station.clients) {
                    client.end();
                }
                // Chiude le connessioni dei metadati (SSE)
                if (station.sseClients) {
                    for (let sseClient of station.sseClients) {
                        sseClient.end();
                    }
                }
                activeStations.delete(genre);
            }
            fs.rmSync(genreDir, { recursive: true, force: true });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true }));
        } else {
            res.writeHead(404);
            return res.end('Genere non trovato');
        }
    }

    // Eliminazione di un brano (traccia)
    if (pathname === '/api/tracks' && req.method === 'DELETE') {
        if (!checkAdminAuth(req)) {
            res.writeHead(401);
            return res.end('Non autorizzato');
        }
        const genre = path.basename(parsedUrl.searchParams.get('genre') || '');
        const filename = path.basename(parsedUrl.searchParams.get('filename') || '');
        if (!genre || !filename) {
            res.writeHead(400);
            return res.end('Parametri mancanti');
        }
        const trackPath = path.join(TRACKS_DIR, genre, filename);
        if (fs.existsSync(trackPath)) {
            fs.unlinkSync(trackPath);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true }));
        } else {
            res.writeHead(404);
            return res.end('Traccia non trovata');
        }
    }

    // Upload binario di file MP3 (senza multipart parsing pesante!)
    if (pathname === '/api/upload' && req.method === 'POST') {
        if (!checkAdminAuth(req)) {
            res.writeHead(401);
            return res.end('Non autorizzato');
        }
        const genre = path.basename(parsedUrl.searchParams.get('genre') || '');
        const filename = path.basename(parsedUrl.searchParams.get('filename') || '');
        if (!genre || !filename || !filename.toLowerCase().endsWith('.mp3')) {
            res.writeHead(400);
            return res.end('Parametri non validi');
        }

        const genreDir = path.join(TRACKS_DIR, genre);
        if (!fs.existsSync(genreDir) || !fs.statSync(genreDir).isDirectory()) {
            res.writeHead(404);
            return res.end('Genere non trovato');
        }

        const targetPath = path.join(genreDir, filename);
        const writeStream = fs.createWriteStream(targetPath);

        req.pipe(writeStream);

        writeStream.on('error', (err) => {
            res.writeHead(500);
            res.end('Errore durante la scrittura del file');
        });

        writeStream.on('finish', () => {
            // Recupera l'istanza della radio di questo genere
            const station = activeStations.get(genre);
            if (station && station.queue) {
                // Genera una posizione casuale nella coda attuale per inserire la nuova canzone
                const randomIndex = Math.floor(Math.random() * (station.queue.length + 1));
                station.queue.splice(randomIndex, 0, filename);
                console.log(`[${genre}] Canzone nuova '${filename}' inserita nella coda alla posizione ${randomIndex}`);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        });
        return;
    }

    // --- GESTIONE DEI FILE STATICI E DEL ROUTING SPA ---

    let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

    // Se l'utente digita una rotta corrispondente a un genere o /admin, gli serviamo index.html (SPA)
    const potentialGenre = pathname.substring(1);
    const isGenreDir = fs.existsSync(path.join(TRACKS_DIR, potentialGenre)) && fs.statSync(path.join(TRACKS_DIR, potentialGenre)).isDirectory();
    const isAdminRoute = pathname === '/admin';

    if (!fs.existsSync(filePath) && (isGenreDir || isAdminRoute)) {
        filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    // Lettura dei file statici
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            return res.end('404 Not Found');
        }
        const ext = path.extname(filePath);
        let contentType = 'text/html';
        if (ext === '.css') contentType = 'text/css';
        if (ext === '.js') contentType = 'application/javascript';

        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
});

server.listen(PORT, () => {
    console.log(`Radio attiva sulla porta ${PORT}`);
});