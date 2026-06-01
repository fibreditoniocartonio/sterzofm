const http = require('http');
const fs = require('fs');
const path = require('path');

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
            if (scanBuffer[i] === 0xFF && (scanBuffer[i+1] & 0xE0) === 0xE0) {
                const mpegVersion = (scanBuffer[i+1] & 0x18) >> 3;
                const layer = (scanBuffer[i+1] & 0x06) >> 1;
                const bitrateIndex = (scanBuffer[i+2] & 0xF0) >> 4;
                
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
    }

    start() {
        if (this.isPlaying) return;
        this.isPlaying = true;
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
            // Se non ci sono canzoni, ricontrolla ogni 5 secondi
            setTimeout(() => this.playNext(), 5000);
            return;
        }

        // Sceglie una canzone casuale dal genere
        const randomFile = files[Math.floor(Math.random() * files.length)];
        const filePath = path.join(genreDir, randomFile);
        
        // Rileva il bitrate dinamico dell'MP3
        const bitrate = getMp3Bitrate(filePath);

        // Tracciamento canzone corrente per l'API now-playing
        this.currentTrack = randomFile;
        this.trackStartedAt = Date.now();
        const fileSize = fs.statSync(filePath).size;
        // durata stimata: dimensione / (bitrate kbps → byte/s)
        this.trackDuration = Math.round(fileSize / ((bitrate * 1000) / 8));
        
        const fd = fs.openSync(filePath, 'r');
        let offset = 0;
        
        const intervalTime = 100;
        // bitrate (kbps) * 1000 = bits/s. / 8 = bytes/s. * (intervalTime/1000) = bytes per chunk.
        const chunkSize = Math.round((bitrate * 1000) / 8 * (intervalTime / 1000));

        this.loopInterval = setInterval(() => {
            const buffer = Buffer.alloc(chunkSize);
            let bytesRead = 0;

            try {
                bytesRead = fs.readSync(fd, buffer, 0, chunkSize, offset);
            } catch (e) {
                bytesRead = 0;
            }

            if (bytesRead === 0) {
                clearInterval(this.loopInterval);
                fs.closeSync(fd);
                this.playNext(); // Passa alla prossima canzone
                return;
            }

            offset += bytesRead;
            const dataChunk = buffer.subarray(0, bytesRead);

            // Invia il blocco audio a tutti i client connessi (Web, VLC, MPV)
            for (let client of this.clients) {
                client.write(dataChunk);
            }
        }, intervalTime);
    }

    addClient(res) {
        res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Transfer-Encoding': 'chunked',
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        this.clients.add(res);
    }

    removeClient(res) {
        this.clients.delete(res);
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
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Specifica un genere' }));
        }
        const station = activeStations.get(genre);
        if (!station || !station.currentTrack) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ track: 'Nessun brano in riproduzione', elapsed: 0, duration: 0 }));
        }
        const elapsed = Math.round((Date.now() - station.trackStartedAt) / 1000);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            track: station.currentTrack,
            elapsed: Math.min(elapsed, station.trackDuration),
            duration: station.trackDuration
        }));
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
        station.addClient(res);

        req.on('close', () => {
            station.removeClient(res);
        });
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
        if (!genre) {
            res.writeHead(400);
            return res.end('Genere mancante');
        }
        const genreDir = path.join(TRACKS_DIR, genre);
        if (fs.existsSync(genreDir) && fs.statSync(genreDir).isDirectory()) {
            const isWin = process.platform === 'win32';
            const cmd = isWin ? 'tar' : 'zip';
            // Su Windows tar comprime, su Linux zip comprime. Useremo '.' in entrambi per evitare wildcards.
            const args = isWin ? ['-cf', '-', '.'] : ['-r', '-', '.'];
            const contentType = isWin ? 'application/x-tar' : 'application/zip';
            const ext = isWin ? 'tar' : 'zip';

            res.writeHead(200, {
                'Content-Type': contentType,
                'Content-Disposition': `attachment; filename="${genre}.${ext}"`
            });

            const { spawn } = require('child_process');
            const packer = spawn(cmd, args, { cwd: genreDir });

            packer.stdout.pipe(res);
            
            packer.stderr.on('data', (data) => {
                console.error(`Errore di compressione: ${data}`);
            });

            packer.on('close', (code) => {
                if (code !== 0) {
                    console.error(`Packer chiuso con codice ${code}`);
                }
            });

            req.on('close', () => {
                packer.kill();
            });
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

        const genres = [];
        let totalSize = 0;
        try {
            const folders = fs.readdirSync(TRACKS_DIR).filter(f => fs.statSync(path.join(TRACKS_DIR, f)).isDirectory());
            for (const genreName of folders) {
                const genreDir = path.join(TRACKS_DIR, genreName);
                const files = fs.readdirSync(genreDir).filter(f => f.endsWith('.mp3'));
                
                const tracks = [];
                let genreSize = 0;
                for (const file of files) {
                    const filePath = path.join(genreDir, file);
                    const stat = fs.statSync(filePath);
                    tracks.push({ name: file, size: stat.size });
                    genreSize += stat.size;
                }
                
                genres.push({ name: genreName, size: genreSize, tracks });
                totalSize += genreSize;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ genres, totalSize }));
        } catch (e) {
            res.writeHead(500);
            return res.end('Errore interno del server');
        }
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
                if (station.loopInterval) clearInterval(station.loopInterval);
                for (let client of station.clients) {
                    client.end();
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