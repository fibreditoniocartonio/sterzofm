const homeView = document.getElementById('home-view');
const playerView = document.getElementById('player-view');
const adminView = document.getElementById('admin-view');

const loginContainer = document.getElementById('login-container');
const dashboardContainer = document.getElementById('dashboard-container');
const pinInput = document.getElementById('pin-input');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const newGenreInput = document.getElementById('new-genre-input');
const createGenreBtn = document.getElementById('create-genre-btn');
const genreError = document.getElementById('genre-error');
const adminGenresList = document.getElementById('admin-genres-list');

// Variabili globali player
let nowPlayingInterval = null;
let audioMotion = null;

// 1. GESTIONE ROUTING CLIENT-SIDE (UNIFICATO)
function route() {
    const path = window.location.pathname;
    const hash = window.location.hash;
    const cleanGenre = path.substring(1);

    // Nasconde tutte le viste
    homeView.classList.add('hidden');
    playerView.classList.add('hidden');
    adminView.classList.add('hidden');

    // Ferma il polling dei metadati ad ogni cambio rotta
    stopNowPlayingPolling();

    // Se lasciamo la pagina del player, fermiamo l'audio per evitare riproduzioni orfane
    const audio = document.getElementById('radio-audio');
    if (audio && (hash === '#admin' || path === '/admin' || !cleanGenre || cleanGenre === "index.html")) {
        audio.pause();
        audio.src = '';
    }

    if (hash === '#admin' || path === '/admin') {
        adminView.classList.remove('hidden');
        setupAdmin();
    } else if (cleanGenre && cleanGenre !== "index.html" && cleanGenre !== "") {
        playerView.classList.remove('hidden');
        document.getElementById('current-genre').innerText = decodeURIComponent(cleanGenre);
        setupPlayer(decodeURIComponent(cleanGenre));
    } else {
        homeView.classList.remove('hidden');
        loadGenres();
    }
}

window.addEventListener('hashchange', route);
route(); // Avvio iniziale del router

// 2. CARICAMENTO DINAMICO DEI GENERI NELLA HOME
async function loadGenres() {
    const res = await fetch('/api/genres');
    const genres = await res.json();
    const container = document.getElementById('genres-container');
    container.innerHTML = ""; // Pulisce prima di caricare

    if (genres.length === 0) {
        container.innerHTML = "<p style='color:#666'>Nessun genere creato. Accedi all'area riservata per aggiungerne uno.</p>";
        return;
    }

    genres.forEach(g => {
        const div = document.createElement('div');
        div.className = 'genre-card';
        div.innerText = g;
        div.onclick = () => window.location.href = `/${g}`;
        container.appendChild(div);
    });
}

// 2b. LOGICA DELL'AREA RISERVATA (ADMIN)
function getPin() {
    return sessionStorage.getItem('admin_pin') || '';
}

async function setupAdmin() {
    const pin = getPin();
    if (!pin) {
        showLogin();
        return;
    }

    // Verifica il PIN con il server
    try {
        const res = await fetch('/api/admin/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin })
        });
        if (res.ok) {
            showDashboard();
        } else {
            sessionStorage.removeItem('admin_pin');
            showLogin();
        }
    } catch (e) {
        showLogin();
    }
}

function showLogin() {
    loginContainer.classList.remove('hidden');
    dashboardContainer.classList.add('hidden');
    loginError.innerText = '';
    pinInput.value = '';
    pinInput.focus();
}

function showDashboard() {
    loginContainer.classList.add('hidden');
    dashboardContainer.classList.remove('hidden');
    loadAdminDashboard();
}

// Click login
loginBtn.onclick = async () => {
    const pin = pinInput.value.trim();
    if (!pin) {
        loginError.innerText = "Inserisci il PIN";
        return;
    }

    try {
        const res = await fetch('/api/admin/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin })
        });
        const data = await res.json();

        if (res.ok && data.success) {
            sessionStorage.setItem('admin_pin', pin);
            showDashboard();
        } else {
            loginError.innerText = data.error || "PIN errato";
        }
    } catch (e) {
        loginError.innerText = "Errore di connessione al server";
    }
};

// Invio con tasto Enter sul PIN
pinInput.onkeydown = (e) => {
    if (e.key === 'Enter') loginBtn.click();
};

// Caricamento Dati Dashboard
async function loadAdminDashboard() {
    try {
        const res = await fetch('/api/admin/tracks', {
            headers: { 'X-PIN': getPin() }
        });

        if (res.status === 401) {
            sessionStorage.removeItem('admin_pin');
            showLogin();
            return;
        }

        const data = await res.json();
        renderAdminDashboard(data);
    } catch (e) {
        adminGenresList.innerHTML = "<p class='error-msg'>Errore nel caricamento dei dati.</p>";
    }
}

// Rendering Dashboard
function renderAdminDashboard(data) {
    adminGenresList.innerHTML = '';
    const genres = data.genres || [];
    const totalSize = data.totalSize || 0;

    // Calcolo dello spazio occupato su Alwaysdata (limite 1 GB = 1024 MB)
    const totalSizeMB = (totalSize / (1024 * 1024)).toFixed(1);
    const limitMB = 1024;
    const percent = Math.min(((totalSize / (1024 * 1024 * 1024)) * 100), 100).toFixed(1);

    // Aggiorna gli indicatori dello spazio su disco
    document.getElementById('space-usage-text').innerText = `${totalSizeMB} MB / ${limitMB} MB (${percent}%)`;
    document.getElementById('space-usage-bar').style.width = `${percent}%`;

    if (genres.length === 0) {
        adminGenresList.innerHTML = "<p style='color:#666; padding: 10px;'>Nessun genere creato. Usane uno sopra per cominciare.</p>";
        return;
    }

    genres.forEach(genreObj => {
        const genre = genreObj.name;
        const genreSizeMB = (genreObj.size / (1024 * 1024)).toFixed(1);
        const tracks = genreObj.tracks || [];

        const genreBox = document.createElement('div');
        genreBox.className = 'admin-genre-box collapsed'; // Inizia chiuso di default

        // Header
        const header = document.createElement('div');
        header.className = 'admin-genre-header';
        header.onclick = (e) => {
            // Evita il toggle se si clicca sui pulsanti o link nell'header
            if (e.target.tagName === 'BUTTON' || e.target.tagName === 'A') return;
            genreBox.classList.toggle('collapsed');
        };

        const title = document.createElement('span');
        title.className = 'admin-genre-title';
        title.innerText = `/${genre} (${genreSizeMB} MB)`;

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'admin-genre-actions';
        actionsDiv.style.display = 'flex';
        actionsDiv.style.gap = '10px';
        actionsDiv.style.alignItems = 'center';

        const downloadGenreBtn = document.createElement('a');
        downloadGenreBtn.className = 'download-genre-btn';
        downloadGenreBtn.innerText = 'Scarica ZIP';
        downloadGenreBtn.href = `/api/genres/download?genre=${encodeURIComponent(genre)}&pin=${encodeURIComponent(getPin())}`;
        downloadGenreBtn.onclick = (e) => e.stopPropagation(); // Evita il toggle del collasso

        const delGenreBtn = document.createElement('button');
        delGenreBtn.className = 'delete-genre-btn';
        delGenreBtn.innerText = 'Elimina Genere';
        delGenreBtn.onclick = (e) => {
            e.stopPropagation(); // Evita il toggle del collasso
            handleDeleteGenre(genre);
        };

        actionsDiv.appendChild(downloadGenreBtn);
        actionsDiv.appendChild(delGenreBtn);
        header.appendChild(title);
        header.appendChild(actionsDiv);
        genreBox.appendChild(header);

        // Body
        const body = document.createElement('div');
        body.className = 'admin-genre-body';

        // Sezione Upload
        const uploadSec = document.createElement('div');
        uploadSec.className = 'upload-section';

        const uploadLabel = document.createElement('label');
        uploadLabel.className = 'upload-btn-label';
        uploadLabel.innerText = 'Carica MP3';

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'audio/mpeg';
        fileInput.style.display = 'none';
        fileInput.onchange = (e) => handleUpload(genre, e.target.files[0], statusSpan);

        const statusSpan = document.createElement('span');
        statusSpan.className = 'upload-status';
        statusSpan.id = `status-${genre}`;

        uploadLabel.appendChild(fileInput);
        uploadSec.appendChild(uploadLabel);
        uploadSec.appendChild(statusSpan);
        body.appendChild(uploadSec);

        // Lista Tracce
        const trackList = document.createElement('ul');
        trackList.className = 'admin-track-list';

        if (tracks.length === 0) {
            const emptyLi = document.createElement('li');
            emptyLi.innerHTML = "<span style='color:#555; font-style:italic;'>Nessuna traccia. Carica file MP3.</span>";
            trackList.appendChild(emptyLi);
        } else {
            // Trova i 5 brani più pesanti del genere per colorarli in rosso
            const heaviestTracks = [...tracks]
                .sort((a, b) => b.size - a.size)
                .slice(0, 5);

            tracks.forEach(trackObj => {
                const track = trackObj.name;
                const trackSizeMB = (trackObj.size / (1024 * 1024)).toFixed(1);
                const isHeavy = heaviestTracks.some(t => t.name === track && t.size === trackObj.size);

                const li = document.createElement('li');

                const trackName = document.createElement('span');
                trackName.className = 'track-name';
                trackName.innerText = track;

                const trackActions = document.createElement('div');
                trackActions.className = 'track-actions';

                const sizeSpan = document.createElement('span');
                sizeSpan.className = 'track-size';
                sizeSpan.innerText = `${trackSizeMB} MB`;
                if (isHeavy) {
                    sizeSpan.classList.add('heavy-track');
                }

                const downloadTrackBtn = document.createElement('a');
                downloadTrackBtn.className = 'download-track-btn';
                downloadTrackBtn.innerText = '⬇';
                downloadTrackBtn.title = 'Scarica brano';
                downloadTrackBtn.href = `/api/tracks/download?genre=${encodeURIComponent(genre)}&filename=${encodeURIComponent(track)}&pin=${encodeURIComponent(getPin())}`;

                const delTrackBtn = document.createElement('button');
                delTrackBtn.className = 'delete-track-btn';
                delTrackBtn.innerText = '✕';
                delTrackBtn.onclick = () => handleDeleteTrack(genre, track);

                trackActions.appendChild(sizeSpan);
                trackActions.appendChild(downloadTrackBtn);
                trackActions.appendChild(delTrackBtn);
                li.appendChild(trackName);
                li.appendChild(trackActions);
                trackList.appendChild(li);
            });
        }

        body.appendChild(trackList);
        genreBox.appendChild(body);
        adminGenresList.appendChild(genreBox);
    });
}

// Crea Genere
createGenreBtn.onclick = async () => {
    const name = newGenreInput.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!name) {
        genreError.innerText = "Nome genere non valido (usa solo lettere e numeri)";
        return;
    }

    genreError.innerText = '';
    try {
        const res = await fetch('/api/genres', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-PIN': getPin()
            },
            body: JSON.stringify({ name })
        });

        if (res.ok) {
            newGenreInput.value = '';
            loadAdminDashboard();
        } else {
            const errText = await res.text();
            genreError.innerText = errText || "Errore durante la creazione";
        }
    } catch (e) {
        genreError.innerText = "Errore di connessione";
    }
};

// Elimina Genere
async function handleDeleteGenre(genre) {
    if (!confirm(`Sei sicuro di voler eliminare il genere "${genre}" e TUTTI i suoi brani?`)) return;

    try {
        const res = await fetch(`/api/genres?genre=${encodeURIComponent(genre)}`, {
            method: 'DELETE',
            headers: { 'X-PIN': getPin() }
        });
        if (res.ok) {
            loadAdminDashboard();
        } else {
            alert("Errore nell'eliminazione del genere");
        }
    } catch (e) {
        alert("Errore di rete");
    }
}

// Elimina Traccia
async function handleDeleteTrack(genre, filename) {
    if (!confirm(`Vuoi eliminare la traccia "${filename}" da "${genre}"?`)) return;

    try {
        const res = await fetch(`/api/tracks?genre=${encodeURIComponent(genre)}&filename=${encodeURIComponent(filename)}`, {
            method: 'DELETE',
            headers: { 'X-PIN': getPin() }
        });
        if (res.ok) {
            loadAdminDashboard();
        } else {
            alert("Errore nell'eliminazione della traccia");
        }
    } catch (e) {
        alert("Errore di rete");
    }
}

// Upload Traccia Binario (Con Avanzamento Percentuale)
function handleUpload(genre, file, statusSpan) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.mp3')) {
        statusSpan.style.color = '#ff3366';
        statusSpan.innerText = "Solo file MP3 ammessi!";
        return;
    }

    statusSpan.style.color = '#00ff66';
    statusSpan.innerText = "Inizio caricamento...";

    const xhr = new XMLHttpRequest();
    const url = `/api/upload?genre=${encodeURIComponent(genre)}&filename=${encodeURIComponent(file.name)}`;

    xhr.open('POST', url, true);
    xhr.setRequestHeader('X-PIN', getPin());
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
            const percent = Math.round((e.loaded / e.total) * 100);
            statusSpan.innerText = `Caricamento: ${percent}%`;
        }
    });

    xhr.addEventListener('load', () => {
        if (xhr.status === 200) {
            statusSpan.innerText = "Caricato con successo!";
            setTimeout(() => {
                loadAdminDashboard();
            }, 1000);
        } else {
            statusSpan.style.color = '#ff3366';
            statusSpan.innerText = `Errore: ${xhr.statusText || 'fallito'}`;
        }
    });

    xhr.addEventListener('error', () => {
        statusSpan.style.color = '#ff3366';
        statusSpan.innerText = "Errore di connessione!";
    });

    xhr.send(file);
}

// 3. LOGICA PLAYER AUDIO + VISUALIZER CON AUDIOMOTION (SOLO WEB CLIENT)

function startNowPlayingPolling(genreName) {
    if (nowPlayingInterval) clearInterval(nowPlayingInterval);

    async function tick() {
        try {
            const res = await fetch(`/api/now-playing?genre=${encodeURIComponent(genreName)}`);
            if (res.ok) {
                const data = await res.json();

                // Formatta il minutaggio trascorso in mm:ss
                const elapsedMin = Math.floor(data.elapsed / 60).toString().padStart(2, '0');
                const elapsedSec = (data.elapsed % 60).toString().padStart(2, '0');

                // Formatta la durata totale in mm:ss
                const durationMin = Math.floor(data.duration / 60).toString().padStart(2, '0');
                const durationSec = (data.duration % 60).toString().padStart(2, '0');

                // Rimuove l'estensione del file per un titolo pulito
                const cleanTitle = data.track ? data.track.replace(/\.[^/.]+$/, "") : 'Nessun brano in riproduzione';

                document.getElementById('now-playing-title').innerText = cleanTitle;
                document.getElementById('now-playing-time').innerText = `${elapsedMin}:${elapsedSec} / ${durationMin}:${durationSec}`;
            }
        } catch (e) {
            console.error("Errore nel recupero now-playing:", e);
        }
    }

    tick(); // Esegui subito al caricamento
    nowPlayingInterval = setInterval(tick, 1000);
}

function stopNowPlayingPolling() {
    if (nowPlayingInterval) {
        clearInterval(nowPlayingInterval);
        nowPlayingInterval = null;
    }
}

function setupPlayer(genreName) {
    const audio = document.getElementById('radio-audio');
    const fullscreenBtn = document.getElementById('fullscreen-btn');
    const fullscreenWrapper = document.getElementById('visualizer-fullscreen-wrapper');

    // Imposta la sorgente e resetta i metadati
    audio.src = `/stream/${genreName}`;
    document.getElementById('now-playing-title').innerText = "Connessione in corso...";
    document.getElementById('now-playing-time').innerText = "00:00 / 00:00";

    // Avvia il polling periodico dei metadati
    startNowPlayingPolling(genreName);

    // Inizializza audioMotion una sola volta per non creare duplicati
    if (!audioMotion) {
        audioMotion = new AudioMotionAnalyzer(
            document.getElementById('visualizer-container'),
            {
                source: audio,
                height: 300,
                ansiColors: true,
                mode: 5,
                barSpace: 2,
                ledFormat: 'row',
                showScaleX: false,
                showScaleY: false,
                showPeaks: true,
                overlay: true,
                bgAlpha: 0,
                gradient: 'prism'
            }
        );
    }

    // Pulsante fullscreen (icona SVG in basso a destra del visualizer)
    fullscreenBtn.onclick = () => {
        if (!document.fullscreenElement) {
            fullscreenWrapper.requestFullscreen().catch(err => {
                console.error(`Errore Fullscreen: ${err.message}`);
            });
        } else {
            document.exitFullscreen();
        }
    };

    // Auto-play immediato: carica e riproduce senza che l'utente debba cliccare nulla
    audio.load();
    audio.play().catch(() => {
        // Alcuni browser bloccano l'autoplay senza interazione utente.
        // In quel caso aspettiamo il primo click sulla pagina per avviare.
        const startOnInteraction = () => {
            audio.play().then(() => {
                if (audioMotion && audioMotion.audioCtx) audioMotion.audioCtx.resume();
            });
            document.removeEventListener('click', startOnInteraction);
        };
        document.addEventListener('click', startOnInteraction, { once: true });
    });
}