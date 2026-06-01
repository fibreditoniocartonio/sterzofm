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

// 1. GESTIONE ROUTING CLIENT-SIDE (UNIFICATO)
function route() {
    const path = window.location.pathname;
    const hash = window.location.hash;
    const cleanGenre = path.substring(1);

    // Nasconde tutte le viste
    homeView.classList.add('hidden');
    playerView.classList.add('hidden');
    adminView.classList.add('hidden');

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
    
    if(genres.length === 0) {
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
    const genres = Object.keys(data);
    
    if (genres.length === 0) {
        adminGenresList.innerHTML = "<p style='color:#666; padding: 10px;'>Nessun genere creato. Usane uno sopra per cominciare.</p>";
        return;
    }
    
    genres.forEach(genre => {
        const tracks = data[genre];
        
        const genreBox = document.createElement('div');
        genreBox.className = 'admin-genre-box';
        
        // Header
        const header = document.createElement('div');
        header.className = 'admin-genre-header';
        
        const title = document.createElement('span');
        title.className = 'admin-genre-title';
        title.innerText = `/${genre}`;
        
        const delGenreBtn = document.createElement('button');
        delGenreBtn.className = 'delete-genre-btn';
        delGenreBtn.innerText = 'Elimina Genere';
        delGenreBtn.onclick = () => handleDeleteGenre(genre);
        
        header.appendChild(title);
        header.appendChild(delGenreBtn);
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
            tracks.forEach(track => {
                const li = document.createElement('li');
                
                const trackName = document.createElement('span');
                trackName.className = 'track-name';
                trackName.innerText = track;
                
                const delTrackBtn = document.createElement('button');
                delTrackBtn.className = 'delete-track-btn';
                delTrackBtn.innerText = '✕';
                delTrackBtn.onclick = () => handleDeleteTrack(genre, track);
                
                li.appendChild(trackName);
                li.appendChild(delTrackBtn);
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

// 3. LOGICA PLAYER AUDIO + VISUALIZER (SOLO WEB CLIENT)
function setupPlayer(genreName) {
    const audio = document.getElementById('radio-audio');
    const playBtn = document.getElementById('play-btn');
    const canvas = document.getElementById('visualizer');
    const ctx = canvas.getContext('2d');
    
    // Imposta la sorgente sul nostro stream di rete nativo
    audio.src = `/stream/${genreName}`;

    let audioCtx, analyser, source;

    playBtn.onclick = () => {
        if (!audioCtx) {
            // Inizializza l'AudioContext del browser al primo click (obbligatorio per policy)
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            analyser = audioCtx.createAnalyser();
            source = audioCtx.createMediaElementSource(audio);
            
            source.connect(analyser);
            analyser.connect(audioCtx.destination);
            
            analyser.fftSize = 64; // Numero di barre del visualizer (basso = leggero)
            const bufferLength = analyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);

            // Funzione di disegno loop del visualizer spettrometro
            function draw() {
                requestAnimationFrame(draw);
                analyser.getByteFrequencyData(dataArray);

                ctx.fillStyle = '#141419';
                ctx.fillRect(0, 0, canvas.width, canvas.height);

                const barWidth = (canvas.width / bufferLength) * 1.5;
                let barHeight;
                let x = 0;

                for (let i = 0; i < bufferLength; i++) {
                    barHeight = dataArray[i] / 1.5;
                    ctx.fillStyle = `rgb(${barHeight + 100}, 0, 127)`;
                    ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
                    x += barWidth + 2;
                }
            }
            draw();
        }

        if (audio.paused) {
            // Ricarica lo stream per agganciarsi al momento "esatto" della diretta ed evitare buffering accumulati
            audio.load(); 
            audio.play();
            playBtn.innerText = "ZITTO";
        } else {
            audio.pause();
            playBtn.innerText = "ENTRA NEL FLUSSO";
        }
    };
}