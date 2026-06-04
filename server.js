const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { exec } = require('child_process');
const Throttle = require('throttle');

const PORT = process.env.PORT || 8100;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_PATH = path.join(__dirname, 'database.json');

// Telegram Configuration
let TG_TOKEN = '';
let TG_CHAT_ID = '';
let TG_API = '';
let TG_FILE_API = '';

const CREDENTIALS_PATH = path.join(__dirname, 'telegram_credentials.txt');

if (fs.existsSync(CREDENTIALS_PATH)) {
    const lines = fs.readFileSync(CREDENTIALS_PATH, 'utf-8').split(/\r?\n/);
    lines.forEach(line => {
        if (line.startsWith('TOKEN=')) TG_TOKEN = line.replace('TOKEN=', '').trim();
        if (line.startsWith('CHAT_ID=')) TG_CHAT_ID = line.replace('CHAT_ID=', '').trim();
    });

    TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;
    TG_FILE_API = `https://api.telegram.org/file/bot${TG_TOKEN}`;
} else {
    console.error("ERRORE: File telegram_credentials.txt mancante!");
    console.error("Crealo nella cartella root con le righe TOKEN=... e CHAT_ID=...");
    process.exit(1);
}

let db = { genres: {}, totalSize: 0 };
if (fs.existsSync(DB_PATH)) {
    try {
        db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
        if (!db.genres) db.genres = {};
    } catch (e) {
        console.error("Errore caricamento database", e);
    }
}

function saveDb() {
    let size = 0;
    for (const g in db.genres) {
        db.genres[g].forEach(t => size += t.size);
    }
    db.totalSize = size;
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function checkAdminAuth(req) {
    return req.headers['x-pin'] === '7777';
}

// Chiamate API Telegram generiche via https nativo
function tgApiCall(method, params = {}) {
    return new Promise((resolve, reject) => {
        const urlParams = new URLSearchParams(params).toString();
        const url = `${TG_API}/${method}?${urlParams}`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

// Ottiene l'URL diretto del file
async function getTgFileUrl(file_id) {
    const res = await tgApiCall('getFile', { file_id });
    if (res.ok) {
        return `${TG_FILE_API}/${res.result.file_path}`;
    }
    throw new Error('Telegram getFile fallito');
}

class RadioStation {
    constructor(genre) {
        this.genre = genre;
        this.clients = new Set();
        this.isPlaying = false;
        this.queue = [];
        this.history = [];
        this.lastPlayedDay = new Date().getDate();
    }

    reshuffle(tracks) {
        let shuffled = [...tracks];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }

        if (shuffled.length >= 10 && this.history.length > 0) {
            for (let i = 0; i < 5; i++) {
                if (this.history.find(h => h.file_id === shuffled[i].file_id)) {
                    let safeIndex = Math.floor(Math.random() * (shuffled.length / 2)) + Math.floor(shuffled.length / 2);
                    [shuffled[i], shuffled[safeIndex]] = [shuffled[safeIndex], shuffled[i]];
                }
            }
        } else if (shuffled.length > 1 && this.history.length > 0) {
            if (shuffled[0].file_id === this.history[this.history.length - 1].file_id) {
                [shuffled[0], shuffled[shuffled.length - 1]] = [shuffled[shuffled.length - 1], shuffled[0]];
            }
        }
        this.queue = shuffled;
    }

    start() {
        if (this.isPlaying) return;
        this.isPlaying = true;
        this.broadcast = new require('stream').PassThrough();
        this.broadcast.setMaxListeners(0);
        this.sseClients = new Set();
        this.playNext();
    }

    async playNext() {
        const genreTracks = db.genres[this.genre] || [];
        if (genreTracks.length === 0) {
            this.isPlaying = false;
            return;
        }

        const currentDay = new Date().getDate();
        this.queue = this.queue.filter(q => genreTracks.find(t => t.file_id === q.file_id));

        if (this.queue.length === 0 || currentDay !== this.lastPlayedDay) {
            this.reshuffle(genreTracks);
            this.lastPlayedDay = currentDay;
        }

        const trackToPlay = this.queue.shift();
        this.history.push(trackToPlay);
        if (this.history.length > 5) this.history.shift();

        this.currentTrack = trackToPlay.name;
        this.trackDuration = trackToPlay.duration || 180;
        this.trackStartedAt = Date.now();

        this.broadcastMetadata();

        try {
            const fileUrl = await getTgFileUrl(trackToPlay.file_id);

            https.get(fileUrl, (response) => {
                if (response.statusCode !== 200) {
                    console.error(`[${this.genre}] HTTP ${response.statusCode} file da TG`);
                    return this.playNext();
                }

                const byteRate = Math.max(1, Math.round(trackToPlay.size / this.trackDuration));
                const throttle = new Throttle(byteRate);

                response.pipe(throttle).pipe(this.broadcast, { end: false });

                throttle.on('end', () => this.playNext());
                throttle.on('error', (err) => {
                    console.error("Errore stream throttle:", err);
                    this.playNext();
                });
                response.on('error', (err) => {
                    console.error("Errore http stream:", err);
                    this.playNext();
                });
            }).on('error', (err) => {
                console.error("Errore http.get:", err);
                this.playNext();
            });

        } catch (e) {
            console.error(`[${this.genre}] Errore getTgFileUrl:`, e.message);
            this.playNext();
        }
    }

    addClient(req, res) {
        res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Transfer-Encoding': 'chunked',
            'Connection': 'keep-alive'
        });
        this.broadcast.pipe(res);
        this.clients.add(res);

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
            elapsed: 0
        });
        for (let res of this.sseClients) {
            res.write(`data: ${data}\n\n`);
        }
    }
}

const activeStations = new Map();

const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    if (pathname === '/api/genres' && req.method === 'GET') {
        const folders = Object.keys(db.genres);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(folders));
    }

    if (pathname === '/api/now-playing' && req.method === 'GET') {
        const genre = parsedUrl.searchParams.get('genre');
        if (!genre) {
            res.writeHead(400); return res.end();
        }
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no' // Prevents Nginx/HAProxy from buffering SSE
        });

        let station = activeStations.get(genre);
        if (!station) {
            station = new RadioStation(genre);
            activeStations.set(genre, station);
        }
        if (!station.sseClients) station.sseClients = new Set();
        station.sseClients.add(res);

        const elapsed = station.trackStartedAt ? Math.round((Date.now() - station.trackStartedAt) / 1000) : 0;
        res.write(`data: ${JSON.stringify({ track: station.currentTrack || 'Nessun brano', duration: station.trackDuration || 0, elapsed })}\n\n`);

        // Send a ping every 15s to keep the connection alive
        const keepAlive = setInterval(() => {
            res.write(': keepalive\n\n');
        }, 15000);

        req.on('close', () => {
            clearInterval(keepAlive);
            station.sseClients.delete(res);
        });
        return;
    }

    if (pathname.startsWith('/stream/')) {
        const genre = pathname.split('/')[2];
        if (!db.genres[genre]) {
            res.writeHead(404); return res.end('Genere non trovato');
        }
        if (!activeStations.has(genre)) {
            activeStations.set(genre, new RadioStation(genre));
        }
        const station = activeStations.get(genre);
        station.start();
        station.addClient(req, res);
        return;
    }

    if (pathname === '/api/tracks/download' && req.method === 'GET') {
        const pin = parsedUrl.searchParams.get('pin');
        if (pin !== '7777') { res.writeHead(401); return res.end('Non autorizzato'); }

        const genre = parsedUrl.searchParams.get('genre');
        const filename = parsedUrl.searchParams.get('filename');

        const track = (db.genres[genre] || []).find(t => t.name === filename);
        if (!track) { res.writeHead(404); return res.end('File non trovato in DB'); }

        getTgFileUrl(track.file_id).then(fileUrl => {
            https.get(fileUrl, (response) => {
                res.writeHead(200, {
                    'Content-Type': 'audio/mpeg',
                    'Content-Disposition': `attachment; filename="${filename}"`,
                    'Content-Length': track.size
                });
                response.pipe(res);
            });
        }).catch(e => {
            res.writeHead(500); res.end('Errore API Telegram');
        });
        return;
    }



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
                res.writeHead(400); return res.end('Bad Request');
            }
        });
        return;
    }

    if (pathname === '/api/admin/tracks' && req.method === 'GET') {
        if (!checkAdminAuth(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Non autorizzato' }));
        }

        const genres = [];
        for (const [genreName, tracks] of Object.entries(db.genres)) {
            let genreSize = 0;
            tracks.forEach(t => genreSize += t.size);
            genres.push({ name: genreName, size: genreSize, tracks: tracks });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ genres, totalSize: db.totalSize }));
        return;
    }

    if (pathname === '/api/genres' && req.method === 'POST') {
        if (!checkAdminAuth(req)) {
            res.writeHead(401); return res.end();
        }
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const safeName = data.name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
                if (!safeName) { res.writeHead(400); return res.end('Nome non valido'); }
                if (db.genres[safeName]) { res.writeHead(400); return res.end('Esiste gia'); }

                db.genres[safeName] = [];
                saveDb();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) { res.writeHead(400); res.end('Bad Request'); }
        });
        return;
    }

    if (pathname === '/api/genres' && req.method === 'DELETE') {
        if (!checkAdminAuth(req)) { res.writeHead(401); return res.end(); }
        const genre = parsedUrl.searchParams.get('genre');
        if (db.genres[genre]) {
            if (activeStations.has(genre)) {
                const station = activeStations.get(genre);
                if (station.broadcast) station.broadcast.end();
                for (let client of station.clients) client.end();
                if (station.sseClients) {
                    for (let sseClient of station.sseClients) sseClient.end();
                }
                activeStations.delete(genre);
            }
            delete db.genres[genre];
            saveDb();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true }));
        } else {
            res.writeHead(404); return res.end('Non trovato');
        }
    }

    if (pathname === '/api/tracks' && req.method === 'DELETE') {
        if (!checkAdminAuth(req)) { res.writeHead(401); return res.end(); }
        const genre = parsedUrl.searchParams.get('genre');
        const filename = parsedUrl.searchParams.get('filename');

        if (db.genres[genre]) {
            const index = db.genres[genre].findIndex(t => t.name === filename);
            if (index !== -1) {
                const track = db.genres[genre][index];
                tgApiCall('deleteMessage', { chat_id: TG_CHAT_ID, message_id: track.message_id }).catch(() => { });

                db.genres[genre].splice(index, 1);
                saveDb();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: true }));
            }
        }
        res.writeHead(404); return res.end('Non trovato');
    }

    if (pathname === '/api/upload' && req.method === 'POST') {
        if (!checkAdminAuth(req)) { res.writeHead(401); return res.end(); }

        const genre = parsedUrl.searchParams.get('genre');
        const filename = parsedUrl.searchParams.get('filename');
        if (!genre || !db.genres[genre] || !filename || !filename.toLowerCase().endsWith('.mp3')) {
            res.writeHead(400); return res.end('Parametri non validi');
        }

        const tempPath = path.join(os.tmpdir(), `sterzofm_${Date.now()}_${filename.replace(/[^a-zA-Z0-9.\-_]/g, '')}`);
        const writeStream = fs.createWriteStream(tempPath);
        req.pipe(writeStream);

        writeStream.on('error', () => {
            res.writeHead(500); res.end('Errore salvataggio locale');
        });

        writeStream.on('finish', () => {
            // Usa curl per caricare il file su Telegram
            const curlCmd = `curl -s -X POST "${TG_API}/sendAudio" ` +
                `-F "chat_id=${TG_CHAT_ID}" ` +
                `-F "audio=@${tempPath}" ` +
                `-F "caption=#${genre}"`;

            exec(curlCmd, (error, stdout, stderr) => {
                fs.unlink(tempPath, () => { }); // Elimina file temporaneo

                if (error) {
                    res.writeHead(500); return res.end('Errore curl upload');
                }

                try {
                    const tgRes = JSON.parse(stdout);
                    if (tgRes.ok && tgRes.result.audio) {
                        const audio = tgRes.result.audio;
                        db.genres[genre].push({
                            name: filename,
                            file_id: audio.file_id,
                            size: audio.file_size,
                            duration: audio.duration,
                            message_id: tgRes.result.message_id
                        });
                        saveDb();

                        const station = activeStations.get(genre);
                        if (station && station.queue) {
                            const randomIndex = Math.floor(Math.random() * (station.queue.length + 1));
                            const newTrack = db.genres[genre][db.genres[genre].length - 1];
                            station.queue.splice(randomIndex, 0, newTrack);
                        }

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: true }));
                    } else {
                        res.writeHead(500); return res.end('Telegram error: ' + (tgRes.description || 'Unknown'));
                    }
                } catch (e) {
                    res.writeHead(500); return res.end('Errore parse JSON telegram');
                }
            });
        });
        return;
    }

    let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
    const potentialGenre = pathname.substring(1);
    const isGenreDir = db.genres[potentialGenre] !== undefined;
    const isAdminRoute = pathname === '/admin';

    if (!fs.existsSync(filePath) && (isGenreDir || isAdminRoute)) {
        filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); return res.end('404 Not Found'); }
        const ext = path.extname(filePath);
        let contentType = 'text/html';
        if (ext === '.css') contentType = 'text/css';
        if (ext === '.js') contentType = 'application/javascript';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
});

server.listen(PORT, () => console.log(`Radio attiva sulla porta ${PORT}`));