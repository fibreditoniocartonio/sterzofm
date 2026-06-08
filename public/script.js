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
let openGenres = new Set();
let nowPlayingInterval = null;
let audioMotion = null;
let trackHistory = [];
let eventSource = null;
let currentTrackDuration = 0;
let currentTrackElapsed = 0;

// Formatta i byte in MB o GB in modo leggibile
function formatSize(bytes) {
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) {
        const gb = mb / 1024;
        return Number.isInteger(gb) ? `${gb} GB` : `${gb.toFixed(2)} GB`;
    }
    return `${mb.toFixed(1)} MB`;
}

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

    genres.sort((a, b) => a.localeCompare(b));

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
    const totalTrackCount = data.totalTrackCount || 0;
    document.getElementById('space-usage-text').innerText = `${totalTrackCount} brani — ${formatSize(totalSize)}`;

    if (genres.length === 0) {
        adminGenresList.innerHTML = "<p style='color:#666; padding: 10px;'>Nessun genere creato. Usane uno sopra per cominciare.</p>";
        return;
    }

    genres.sort((a, b) => a.name.localeCompare(b.name));

    genres.forEach(genreObj => {
        const genre = genreObj.name;
        const tracks = genreObj.tracks || [];

        const genreBox = document.createElement('div');
        genreBox.className = 'admin-genre-box' + (openGenres.has(genre) ? '' : ' collapsed');

        // Header
        const header = document.createElement('div');
        header.className = 'admin-genre-header';
        header.onclick = (e) => {
            // Evita il toggle se si clicca sui pulsanti o link nell'header
            if (e.target.tagName === 'BUTTON' || e.target.tagName === 'A') return;
            genreBox.classList.toggle('collapsed');
            if (genreBox.classList.contains('collapsed')) {
                openGenres.delete(genre);
            } else {
                openGenres.add(genre);
            }
        };

        const title = document.createElement('span');
        title.className = 'admin-genre-title';
        title.innerText = `/${genre} (${genreObj.trackCount || tracks.length} brani — ${formatSize(genreObj.size)})`;

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'admin-genre-actions';
        actionsDiv.style.display = 'flex';
        actionsDiv.style.gap = '10px';
        actionsDiv.style.alignItems = 'center';

        const downloadGenreBtn = document.createElement('a');
        downloadGenreBtn.className = 'download-genre-btn';
        downloadGenreBtn.innerText = 'Download Massivo';
        downloadGenreBtn.href = 'javascript:void(0)';
        downloadGenreBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (tracks.length === 0) return alert("Nessun brano in questo genere.");
            if (!confirm(`Vuoi scaricare i ${tracks.length} brani di "${genre}"? Verranno scaricati in sequenza.`)) return;

            let delay = 0;
            tracks.forEach(trackObj => {
                setTimeout(() => {
                    const a = document.createElement('a');
                    a.href = `/api/tracks/download?genre=${encodeURIComponent(genre)}&filename=${encodeURIComponent(trackObj.name)}&pin=${encodeURIComponent(getPin())}`;
                    a.download = trackObj.name;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                }, delay);
                delay += 500;
            });
        };

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
        fileInput.multiple = true;
        fileInput.style.display = 'none';
        fileInput.onchange = (e) => handleMultipleUploads(genre, Array.from(e.target.files), statusSpan, tracks);

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

            tracks.sort((a, b) => a.name.localeCompare(b.name));

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

// Upload Multiplo (Con Avanzamento e Gestione Sequenziale)
async function handleMultipleUploads(genre, files, statusSpan, existingTracks = []) {
    if (!files || files.length === 0) return;

    const existingNames = new Set(existingTracks.map(t => t.name));

    const validFiles = files.filter(f => f.name.toLowerCase().endsWith('.mp3') && !existingNames.has(f.name));
    const skippedCount = files.length - validFiles.length;

    if (validFiles.length === 0) {
        statusSpan.style.color = '#ff3366';
        statusSpan.innerText = skippedCount > 0 ? "Tutti i file selezionati erano già presenti." : "Solo file MP3 ammessi!";
        return;
    }

    let successCount = 0;
    statusSpan.style.color = '#00ff66';

    for (let i = 0; i < validFiles.length; i++) {
        const file = validFiles[i];

        let attempts = 0;
        let success = false;

        while (attempts < 3 && !success) {
            statusSpan.innerText = `Caricamento ${i + 1}/${validFiles.length}: ${file.name} ${attempts > 0 ? `(Tentativo ${attempts + 1}/3)` : '(0%)'}`;
            try {
                await uploadSingleFile(genre, file, (percent) => {
                    statusSpan.innerText = `Caricamento ${i + 1}/${validFiles.length}: ${file.name} (${percent}%)`;
                });
                successCount++;
                success = true;
            } catch (e) {
                attempts++;
                console.error(`Errore caricamento ${file.name} (Tentativo ${attempts})`, e);
                if (attempts < 3) {
                    statusSpan.style.color = '#ffaa00';
                    statusSpan.innerText = `Errore su ${file.name}. Riprovo tra poco...`;
                    await new Promise(r => setTimeout(r, 3000));
                    statusSpan.style.color = '#00ff66';
                } else {
                    statusSpan.style.color = '#ff3366';
                    statusSpan.innerText = `Fallito ${file.name}. Continuo col prossimo...`;
                    await new Promise(r => setTimeout(r, 2000));
                    statusSpan.style.color = '#00ff66';
                }
            }
        }
    }

    statusSpan.innerText = `${successCount} caricati` + (skippedCount > 0 ? `, ${skippedCount} saltati (già presenti)!` : ` con successo!`);
    setTimeout(() => {
        loadAdminDashboard();
    }, 1500);
}

function uploadSingleFile(genre, file, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const url = `/api/upload?genre=${encodeURIComponent(genre)}&filename=${encodeURIComponent(file.name)}`;

        xhr.open('POST', url, true);
        xhr.setRequestHeader('X-PIN', getPin());
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');

        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                const percent = Math.round((e.loaded / e.total) * 100);
                onProgress(percent);
            }
        });

        xhr.addEventListener('load', () => {
            if (xhr.status === 200) resolve();
            else reject(new Error(xhr.statusText));
        });

        xhr.addEventListener('error', () => reject(new Error('Network error')));

        xhr.send(file);
    });
}

// 2c. GESTIONE DEL TESTO SCORREVOLE (MARQUEE) RESIZE E FULLSCREEN
function adjustMarquee() {
    const wrapper = document.getElementById('now-playing-title-wrapper');
    const title = document.getElementById('now-playing-title');
    if (!wrapper || !title) return;

    const text = title.innerText;
    if (text === "Connessione in corso..." || text === "Nessun brano in riproduzione") {
        title.classList.remove('scrolling-text');
        title.style.removeProperty('--overflow');
        return;
    }

    // Rimuovi temporaneamente la classe per misurare le dimensioni reali
    title.classList.remove('scrolling-text');
    title.style.removeProperty('--overflow');

    const scrollWidth = title.scrollWidth;
    const clientWidth = wrapper.clientWidth;

    if (scrollWidth > clientWidth) {
        const overflow = scrollWidth - clientWidth;
        title.style.setProperty('--overflow', `-${overflow + 20}px`);
        title.classList.add('scrolling-text');
    }
}

// Ricalcolo del marquee al resize della finestra o al cambio di fullscreen
window.addEventListener('resize', adjustMarquee);
document.addEventListener('fullscreenchange', adjustMarquee);

// 3. LOGICA PLAYER AUDIO + VISUALIZER CON AUDIOMOTION (SOLO WEB CLIENT)

function startNowPlayingPolling(genreName) {
    stopNowPlayingPolling(); // Pulisce connessioni precedenti

    // Connessione in tempo reale, zero overhead
    eventSource = new EventSource(`/api/now-playing?genre=${encodeURIComponent(genreName)}`);

    let initialTrack = true;

    eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);

        currentTrackDuration = data.duration;
        currentTrackElapsed = data.elapsed; // Ricevuto solo al primo avvio o al cambio traccia

        const cleanTitle = data.track ? data.track.replace(/\.[^/.]+$/, "") : 'Nessun brano in riproduzione';
        const title = document.getElementById('now-playing-title');

        if (title && title.innerText !== cleanTitle) {
            title.innerText = cleanTitle;
            setTimeout(adjustMarquee, 50);

            if (!initialTrack && data.track) {
                console.log("Track changed, preemptively reloading stream to reset decoder...");
                const audio = document.getElementById('radio-audio');
                if (audio) {
                    audio.src = `/stream/${encodeURIComponent(genreName)}?t=${Date.now()}`;
                    audio.load();
                    audio.play().catch(() => {});
                }
            }
        }
        initialTrack = false;
    };

    eventSource.onerror = () => {
        console.error("Connessione SSE persa, tento il riavvio...");
    };

    // Il timer locale aggiorna solo la UI (nessuna chiamata HTTP!)
    nowPlayingInterval = setInterval(() => {
        if (currentTrackDuration > 0 && currentTrackElapsed < currentTrackDuration) {
            currentTrackElapsed++;
        }
        updateTimeUI(currentTrackElapsed, currentTrackDuration);
    }, 1000);
}

function updateTimeUI(elapsed, duration) {
    const elapsedMin = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const elapsedSec = (elapsed % 60).toString().padStart(2, '0');
    const durationMin = Math.floor(duration / 60).toString().padStart(2, '0');
    const durationSec = (duration % 60).toString().padStart(2, '0');

    const timeElem = document.getElementById('now-playing-time');
    if (timeElem) timeElem.innerText = `${elapsedMin}:${elapsedSec} / ${durationMin}:${durationSec}`;
}

function stopNowPlayingPolling() {
    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }
    if (nowPlayingInterval) {
        clearInterval(nowPlayingInterval);
        nowPlayingInterval = null;
    }
}

function setupPlayer(genreName) {
    const audio = document.getElementById('radio-audio');
    const fullscreenBtn = document.getElementById('fullscreen-btn');
    const fullscreenWrapper = document.getElementById('visualizer-fullscreen-wrapper');
    const copyBtn = document.getElementById('copy-stream-btn');

    if (copyBtn) {
        const copyIcon = copyBtn.querySelector('.copy-icon');
        const checkIcon = copyBtn.querySelector('.check-icon');
        if (copyIcon && checkIcon) {
            copyIcon.classList.remove('hidden');
            checkIcon.classList.add('hidden');
            copyBtn.style.borderColor = '';
            copyBtn.style.color = '';
        }

        copyBtn.onclick = () => {
            const streamUrl = `${window.location.origin}/stream/${encodeURIComponent(genreName)}`;

            const handleSuccess = () => {
                if (copyIcon && checkIcon) {
                    copyIcon.classList.add('hidden');
                    checkIcon.classList.remove('hidden');
                    copyBtn.style.borderColor = '#00ff66';
                    copyBtn.style.color = '#00ff66';

                    setTimeout(() => {
                        copyIcon.classList.remove('hidden');
                        checkIcon.classList.add('hidden');
                        copyBtn.style.borderColor = '';
                        copyBtn.style.color = '';
                    }, 2000);
                }
            };

            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(streamUrl).then(handleSuccess).catch(err => {
                    console.error("Errore durante la copia:", err);
                });
            } else {
                // Fallback for environments without secure context
                const textArea = document.createElement("textarea");
                textArea.value = streamUrl;
                document.body.appendChild(textArea);
                textArea.select();
                try {
                    document.execCommand('copy');
                    handleSuccess();
                } catch (err) {
                    console.error('Errore fallback copia:', err);
                }
                document.body.removeChild(textArea);
            }
        };
    }

    // Imposta la sorgente con cache-buster per evitare audio stantio dalla cache del browser
    audio.src = `/stream/${genreName}?t=${Date.now()}`;
    document.getElementById('now-playing-title').innerText = "Connessione in corso...";
    document.getElementById('now-playing-time').innerText = "00:00 / 00:00";

    // Auto-reconnect in caso di errore stream (es. NotSupportedError dopo corruzione)
    audio.removeEventListener('error', audio._errorHandler);
    audio._errorHandler = () => {
        console.warn('Errore audio decodifica, ricaricamento istantaneo...');
        audio.src = `/stream/${encodeURIComponent(genreName)}?t=${Date.now()}`;
        audio.load();
        audio.play().catch(() => {});
    };
    audio.addEventListener('error', audio._errorHandler);

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