const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8100; // Si adatta automaticamente ad Alwaysdata
const TRACKS_DIR = path.join(__dirname, 'tracks');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Assicurati che la cartella dei brani esista
if (!fs.existsSync(TRACKS_DIR)) fs.mkdirSync(TRACKS_DIR);

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
        
        const fd = fs.openSync(filePath, 'r');
        let offset = 0;
        
        // 128 kbps = 16000 byte al secondo. Spediamo 1600 byte ogni 100ms per massima fluidità.
        const chunkSize = 1600; 
        const intervalTime = 100;

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
    const url = req.url;

    // API per ottenere la lista dei generi disponibili (basato sulle cartelle esistenti)
    if (url === '/api/genres') {
        const folders = fs.readdirSync(TRACKS_DIR).filter(f => fs.statSync(path.join(TRACKS_DIR, f)).isDirectory());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(folders));
    }

    // Endpoint di Streaming per Web Player, VLC e MPV (es: /stream/trance)
    if (url.startsWith('/stream/')) {
        const genre = url.split('/')[2];
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

    // Servizio File Statici del Frontend
    let filePath = path.join(PUBLIC_DIR, url === '/' ? 'index.html' : url);
    
    // Gestione rotte dinamiche dei generi (es: sterzofm.alwaysdata.net/trance)
    // Se l'utente digita una rotta che corrisponde a una cartella di un genere, gli serviamo index.html
    const potentialGenre = url.substring(1);
    if (!fs.existsSync(filePath) && fs.existsSync(path.join(TRACKS_DIR, potentialGenre))) {
        filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    // Lettura e invio dei file statici (HTML, CSS, JS)
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