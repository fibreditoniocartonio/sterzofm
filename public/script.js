const path = window.location.pathname;
const genre = path.substring(1); // Estrae il nome del genere dall'URL

const homeView = document.getElementById('home-view');
const playerView = document.getElementById('player-view');

// 1. GESTIONE ROUTING CLIENT-SIDE
if (genre && genre !== "index.html") {
    // Siamo dentro la pagina di un genere
    homeView.classList.add('hidden');
    playerView.classList.remove('hidden');
    document.getElementById('current-genre').innerText = genre;
    setupPlayer(genre);
} else {
    // Siamo nella Home Page
    loadGenres();
}

// 2. CARICAMENTO DINAMICO DEI GENERI NELLA HOME
async function loadGenres() {
    const res = await fetch('/api/genres');
    const genres = await res.json();
    const container = document.getElementById('genres-container');
    
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