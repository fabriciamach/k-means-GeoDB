const CONFIG = {
    URL: 'https://wft-geo-db.p.rapidapi.com/v1/geo/cities',
    LIMIT: 10,
    API_PAGE_LIMIT: 10,
    TARGET_CITIES: 50,
    RATE_LIMIT_MS: 1500,
    MAX_RETRIES: 4,
    RETRY_429_EXTRA_MS: 1500,
    API_WORKERS: Math.max(2, Math.min(4, navigator.hardwareConcurrency || 4)),
    HEADERS: {
        'x-rapidapi-key': 'c378b7030fmsha3da3c2e2489efdp1c3c9ajsneb6338e3e930',
        'x-rapidapi-host': 'wft-geo-db.p.rapidapi.com'
    }
};

let state = {
    currentPage: 0,
    selectedCities: []
};

let currentTotalCities = CONFIG.TARGET_CITIES;
let sharedBuffer = new SharedArrayBuffer(currentTotalCities * 3 * 8);
let listaParaCache = [];

const modal = document.getElementById("window-confirm");

const calculateDistance = (city, centroid) => {
    const latDiff = city.lat - centroid.lat;
    const lonDiff = city.lon - centroid.lon;
    const popDiff = (city.pop / 1000000) - (centroid.pop / 1000000);

    return Math.sqrt(latDiff * latDiff + lonDiff * lonDiff + popDiff * popDiff);
};

// Ordenação por nome 
const buildUrl = (page) => `${CONFIG.URL}?offset=${page * CONFIG.LIMIT}&limit=${CONFIG.LIMIT}&sort=%2Bname`;

const formatPopulation = (num) => {
    if (!num && num !== 0) return "0";
    return new Intl.NumberFormat('pt-BR').format(num);
};

const toggleLoader = (show) => {
    const loader = document.getElementById('loader');
    if (loader) loader.classList.toggle('hidden', !show);
};

const setButtonsDisabled = (disabled) => {
    document.getElementById('run-kmeans-api')?.toggleAttribute('disabled', disabled);
    document.getElementById('run-kmeans-json')?.toggleAttribute('disabled', disabled);
};

const updateStatus = (message) => {
    const pageInfo = document.getElementById('page-info');
    if (pageInfo) pageInfo.textContent = message;
};

const setTotalCities = (total) => {
    currentTotalCities = total;
    sharedBuffer = new SharedArrayBuffer(currentTotalCities * 3 * 8);
};

const renderTable = (cities) => {
    const tbody = document.getElementById('table-body');
    if (!tbody) return;
    const cityList = cities || [];
    tbody.innerHTML = cityList.map(city => {
        const isSelected = state.selectedCities.some(c => String(c.id) === String(city.id));
        return `
            <tr>
                <td>${city.id}</td>
                <td>${city.city}</td>
                <td>${city.country}</td>
                <td>${formatPopulation(city.population)}</td>
                <td><input type="checkbox" class="city-checkbox" data-id="${city.id}" data-name="${city.city}" ${isSelected ? 'checked' : ''}/></td>
            </tr>`;
    }).join('');
};

const updateApp = async (newPage) => {
    if (newPage < 0) return;
    state.currentPage = newPage;
    toggleLoader(true);
    try {
        const response = await fetch(buildUrl(state.currentPage), { headers: CONFIG.HEADERS });

        if (!response.ok) {
            const errorDetail = await response.text();
            console.error(`Erro na API (${response.status}):`, errorDetail);
            const tbody = document.getElementById('table-body');
            if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:red;">Erro ${response.status}: Verifique sua quota/key na RapidAPI. (${errorDetail})</td></tr>`;
            toggleLoader(false);
            return;
        }

        const result = await response.json();
        renderTable(result.data);

        const pageInfo = document.getElementById('page-info');
        if (pageInfo) pageInfo.textContent = `Página: ${state.currentPage + 1}`;
    } catch (e) {
        console.error("Falha catastrófica na requisição:", e);
    }
    toggleLoader(false);
};

// Funcionamento Workers + K-Means

const normalizeCity = (city, idx) => ({
    id: city.id ?? idx,
    city: city.city || city.name || `Cidade ${idx + 1}`,
    country: city.country || city.countryCode || 'N/A',
    latitude: parseFloat(city.latitude ?? city.lat ?? 0),
    longitude: parseFloat(city.longitude ?? city.lon ?? 0),
    population: parseInt(city.population ?? city.pop ?? 0, 10) || 0
});

const loadCitiesFromJson = async (k) => {
    toggleLoader(true);
    setButtonsDisabled(true);
    updateStatus('Carregando JSON local...');

    try {
        const responseLocal = await fetch('cidades.json?v=' + Date.now());
        if (!responseLocal.ok) throw new Error('JSON local não encontrado');

        const raw = await responseLocal.json();
        const jsonTarget = Math.min(10000, raw.length);
        setTotalCities(jsonTarget);
        const cidades = raw
            .map((c, idx) => normalizeCity(c, idx))
            .filter(c => c.population > 0)
            .slice(0, currentTotalCities);

        listaParaCache = cidades;
        updateStatus(`JSON carregado: ${cidades.length}/${currentTotalCities}`);
        processAndRun(k, cidades);
    } catch (e) {
        console.error('Erro ao carregar JSON:', e);
        updateStatus('Falha ao carregar JSON local.');
        toggleLoader(false);
        setButtonsDisabled(false);
    }
};

const processAndRun = (k, cidades) => {
    preencherBuffer(cidades);
    window.cidadesCarregadas = cidades;
    runParallelKMeans(k, cidades);
};

const loadCitiesFromApi = (k) => {
    console.log("Iniciando busca via API (1 RPS)...");
    listaParaCache = [];
    setTotalCities(CONFIG.TARGET_CITIES);
    toggleLoader(true);
    setButtonsDisabled(true);
    updateStatus(`Baixando: 0/${currentTotalCities}`);

    const numWorkers = Math.max(1, k);
    const totalPages = Math.ceil(currentTotalCities / CONFIG.API_PAGE_LIMIT);
    const countsByWorker = Array.from({ length: numWorkers }, () => 0);
    const apiCities = Array.from({ length: currentTotalCities });
    let finishedWorkers = 0;

    const rateTimeBuffer = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT);
    const rateLockBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    new BigInt64Array(rateTimeBuffer)[0] = BigInt(Date.now());

    for (let i = 0; i < numWorkers; i++) {
        const fWorker = new Worker('fetch-worker.js');
        fWorker.postMessage({
            startPage: i,
            totalPages,
            step: numWorkers,
            count: currentTotalCities,
            workerIndex: i,
            config: {
                URL: CONFIG.URL,
                HEADERS: CONFIG.HEADERS,
                LIMIT: CONFIG.API_PAGE_LIMIT,
                RATE_LIMIT_MS: CONFIG.RATE_LIMIT_MS,
                MAX_RETRIES: CONFIG.MAX_RETRIES,
                RETRY_429_EXTRA_MS: CONFIG.RETRY_429_EXTRA_MS
            },
            sharedBuffer: sharedBuffer,
            rateTimeBuffer,
            rateLockBuffer
        });

        fWorker.onmessage = (e) => {
            if (e.data.type === 'LOG') {
                console.log(e.data.message);
            }
            if (e.data.type === 'PROGRESS') {
                countsByWorker[e.data.workerIndex] = e.data.currentCount;
                const total = countsByWorker.reduce((sum, val) => sum + val, 0);
                const percent = Math.round((total / currentTotalCities) * 100);
                console.log(`Progresso API: ${percent}% (${total}/${currentTotalCities})`);
                updateStatus(`Baixando: ${total}/${currentTotalCities}`);
            }
            if (e.data.type === 'DONE') {
                e.data.data.forEach((c) => {
                    const idx = c.index;
                    if (idx >= 0 && idx < currentTotalCities) {
                        apiCities[idx] = normalizeCity(c, idx);
                    }
                });
                finishedWorkers++;

                if (finishedWorkers === numWorkers) {
                    listaParaCache = apiCities.map((c, idx) => c || normalizeCity({}, idx));
                    console.log("--- BUSCA API CONCLUÍDA! ---");
                    processAndRun(k, listaParaCache);
                }
            }
            if (e.data.type === 'ERROR') {
                console.error('Erro no Worker:', e.data.message);
                updateStatus('Falha no download da API.');
                toggleLoader(false);
                setButtonsDisabled(false);
            }
        };
    }
};

const preencherBuffer = (cidades) => {
    console.log("Preenchendo SharedArrayBuffer com " + cidades.length + " cidades...");
    const view = new Float64Array(sharedBuffer);

    // Limpa o buffer antes de preencher
    view.fill(0);

    cidades.forEach((city, i) => {
        if (i >= currentTotalCities) return;
        const base = i * 3;

        const lat = parseFloat(city.latitude || city.lat || 0);
        const lon = parseFloat(city.longitude || city.lon || 0);
        const pop = parseInt(city.population || city.pop || 0);

        view[base] = lat;
        view[base + 1] = lon;
        view[base + 2] = pop;
    });
    console.log("Buffer preenchido com sucesso!");
};

const seedCentroidsFromData = (k) => {
    const dataView = new Float64Array(sharedBuffer);
    const available = [];
    for (let i = 0; i < currentTotalCities; i++) {
        const base = i * 3;
        const lat = dataView[base];
        const lon = dataView[base + 1];
        const pop = dataView[base + 2];
        if (lat === 0 && lon === 0) continue;
        available.push({ lat, lon, pop });
    }

    if (available.length === 0) {
        return Array.from({ length: k }, () => ({
            lat: (Math.random() * 180) - 90,
            lon: (Math.random() * 360) - 180,
            pop: Math.random() * 5000000
        }));
    }

    const centroids = [];
    const used = new Set();
    while (centroids.length < k) {
        const idx = Math.floor(Math.random() * available.length);
        if (used.has(idx)) continue;
        used.add(idx);
        centroids.push({ ...available[idx] });
    }
    return centroids;
};

const runParallelKMeans = (k, listaCidades) => {
    const numWorkers = 4;
    const chunk = Math.floor(currentTotalCities / numWorkers);

    let centroids = seedCentroidsFromData(k);

    const iterate = (currentCentroids, iteration) => {
        if (iteration > 10) {
            toggleLoader(false);
            setButtonsDisabled(false);
            console.log("=== RESULTADO DO AGRUPAMENTO ===");
            const cityGroups = Array.from({ length: k }, () => []);
            const dataView = new Float64Array(sharedBuffer);

            for (let i = 0; i < currentTotalCities; i++) {
                const base = i * 3;
                const lat = dataView[base];
                const lon = dataView[base + 1];
                const pop = dataView[base + 2];

                if (lat === 0 && lon === 0) continue;

                // Objeto temporário para calcular distância
                const cityObj = { lat, lon, pop };

                let minDist = Infinity;
                let groupIdx = 0;

                currentCentroids.forEach((c, idx) => {
                    // LAT + LON + POP
                    const d = calculateDistance(cityObj, c);
                    if (d < minDist) { minDist = d; groupIdx = idx; }
                });

                // Pega o nome correto da cidade do array global
                const cidadeInfo = window.cidadesCarregadas && window.cidadesCarregadas[i];
                const nome = cidadeInfo ? (cidadeInfo.city || cidadeInfo.name) : `Cidade #${i}`;
                cityGroups[groupIdx].push(nome);
            }

            // Exibe no console as cidades de cada cluster
            console.log("\n===== CIDADES POR CLUSTER K-MEANS =====");
            cityGroups.forEach((group, i) => {
                console.log(`\nCLUSTER ${i + 1} (${group.length} cidades):`);
                console.log(group.join(', '));
            });
            console.log("\n=========================================\n");

            // Renderiza no HTML
            const resultsDiv = document.getElementById('kmeans-results');
            if (resultsDiv) {
                let html = '<h2>Resultados do Agrupamento (K-Means)</h2>';
                cityGroups.forEach((group, i) => {
                    html += `
                        <div class="group-result">
                            <h3>Grupo ${i + 1} <small>(${group.length} cidades)</small></h3>
                            <div class="group-list">
                                ${group.slice(0, 50).join(', ')} 
                                ${group.length > 50 ? `... e mais ${group.length - 50}` : ''}
                            </div>
                        </div>
                    `;
                });
                resultsDiv.innerHTML = html;
                resultsDiv.scrollIntoView({ behavior: 'smooth' });
            }

            console.log("Agrupamento finalizado.");
            return;
        }

        let finished = 0;
        let globalPartials = Array.from({ length: k }, () => ({ lat: 0, lon: 0, pop: 0, count: 0 }));

        for (let i = 0; i < numWorkers; i++) {
            const kmWorker = new Worker('k-means-worker.js');

            kmWorker.onerror = (err) => {
                console.error(`Worker #${i} Error:`, err.message, err);
            };

            kmWorker.postMessage({
                startIdx: i * chunk,
                endIdx: i === numWorkers - 1 ? currentTotalCities : (i + 1) * chunk,
                centroids: currentCentroids,
                sharedBuffer: sharedBuffer
            });

            kmWorker.onmessage = (e) => {
                if (e.data.partials) {
                    e.data.partials.forEach((p, idx) => {
                        globalPartials[idx].lat += p.lat;
                        globalPartials[idx].lon += p.lon;
                        globalPartials[idx].pop += p.pop;
                        globalPartials[idx].count += p.count;
                    });
                }
                finished++;
                if (finished === numWorkers) {
                    const reseedPool = seedCentroidsFromData(k);
                    let reseedIdx = 0;
                    const nextCentroids = globalPartials.map(p => {
                        if (p.count) {
                            return {
                                lat: p.lat / p.count,
                                lon: p.lon / p.count,
                                pop: p.pop / p.count
                            };
                        }
                        const pick = reseedPool[reseedIdx % reseedPool.length];
                        reseedIdx++;
                        return { ...pick };
                    });
                    iterate(nextCentroids, iteration + 1);
                }
            };
        }
    };
    iterate(centroids, 1);
};

//Função para buscar cidades da API e salvar em JSON local, 
// é opcional para ver como fiz mas não é útil para usar como está atualmente, uma vez que já fiz o processo
const fetchAndSaveCitiesToJson = async () => {
    const apiEndpoint = CONFIG.URL;
    const headers = CONFIG.HEADERS;
    const limit = CONFIG.LIMIT; // Número de cidades por requisição
    const maxRequests = 10; // Limite de requisições para evitar sobrecarga

    let allCities = [];
    let currentPage = 0;

    try {
        while (currentPage < maxRequests) {
            const offset = currentPage * limit;
            const url = `${apiEndpoint}?offset=${offset}&limit=${limit}&sort=%2Bname`;

            console.log(`Buscando cidades na página ${currentPage + 1}...`);

            const response = await fetch(url, { headers });

            if (!response.ok) {
                console.error(`Erro ao buscar cidades: ${response.statusText}`);
                break;
            }

            const data = await response.json();
            if (data.data && data.data.length > 0) {
                allCities = allCities.concat(data.data);
            } else {
                console.log('Nenhuma cidade retornada pela API.');
                break;
            }

            currentPage++;
            await new Promise(resolve => setTimeout(resolve, CONFIG.RATE_LIMIT_MS)); // Respeitar limite de requisição
        }

        console.log(`Total de cidades buscadas: ${allCities.length}`);

        // Salvar no JSON
        const blob = new Blob([JSON.stringify(allCities, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = 'cidades.json';
        a.click();

        URL.revokeObjectURL(url);
        console.log('Arquivo cidades.json salvo com sucesso!');
    } catch (error) {
        console.error('Erro ao buscar ou salvar cidades:', error);
    }
};


// --- EVENTOS ---
document.getElementById('next-btn')?.addEventListener('click', () => updateApp(state.currentPage + 1));
document.getElementById('prev-btn')?.addEventListener('click', () => updateApp(state.currentPage - 1));

document.getElementById('choice-btn')?.addEventListener('click', () => {
    const display = document.getElementById('cities');
    if (display) display.textContent = state.selectedCities.map(c => c.name).join(', ') || "Nenhuma selecionada.";
    if (modal) modal.style.display = "block";
});

document.getElementById('run-kmeans-api')?.addEventListener('click', () => {
    const kValue = parseInt(document.getElementById('k-value').value) || 3;
    loadCitiesFromApi(kValue);
});

document.getElementById('run-kmeans-json')?.addEventListener('click', () => {
    const kValue = parseInt(document.getElementById('k-value').value) || 3;
    loadCitiesFromJson(kValue);
});

document.querySelector(".close")?.addEventListener('click', () => modal.style.display = "none");
window.onclick = (event) => { if (event.target == modal) modal.style.display = "none"; };

document.getElementById('fetch-save-btn')?.addEventListener('click', () => {
    console.log("Iniciando processo de busca e salvamento...");
    fetchAndSaveCitiesToJson(); 
});

updateApp(0);