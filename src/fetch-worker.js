self.onmessage = async (e) => {
    const { startPage, totalPages, step, count, config, sharedBuffer, workerIndex, rateTimeBuffer, rateLockBuffer } = e.data;
    const view = new Float64Array(sharedBuffer);
    const citiesPerPage = config.LIMIT || 10;
    const fetchedCities = [];

    // Delay base para respeitar 1 req/s
    const BASE_DELAY = config.RATE_LIMIT_MS || 1100;
    const MAX_RETRIES = config.MAX_RETRIES || 4;
    const EXTRA_429 = config.RETRY_429_EXTRA_MS || 1500;
    const INITIAL_DELAY = (workerIndex || 0) * BASE_DELAY;

    const delay = (ms) => new Promise(r => setTimeout(r, ms));

    const rateTimeView = new BigInt64Array(rateTimeBuffer);
    const rateLockView = new Int32Array(rateLockBuffer);

    const acquireLock = () => {
        while (Atomics.compareExchange(rateLockView, 0, 0, 1) !== 0) {
            Atomics.wait(rateLockView, 0, 1, 50);
        }
    };

    const releaseLock = () => {
        Atomics.store(rateLockView, 0, 0);
        Atomics.notify(rateLockView, 0, 1);
    };

    const waitForRateSlot = async () => {
        acquireLock();
        const now = BigInt(Date.now());
        let next = rateTimeView[0];
        if (next < now) next = now;
        const waitMs = Number(next - now);
        rateTimeView[0] = next + BigInt(BASE_DELAY);
        releaseLock();
        if (waitMs > 0) await delay(waitMs);
    };

    const addGlobalDelay = (extraMs) => {
        acquireLock();
        rateTimeView[0] = rateTimeView[0] + BigInt(extraMs);
        releaseLock();
    };

    try {
        if (INITIAL_DELAY) await delay(INITIAL_DELAY);

        for (let page = startPage; page < totalPages; page += step) {
            const offset = page * citiesPerPage;
            if (offset >= count) break;
            const url = `${config.URL}?offset=${offset}&limit=${citiesPerPage}&sort=%2BcountryCode`;

            let sucesso = false;
            let tentativas = 0;
            let delayAtual = BASE_DELAY;

            while (!sucesso && tentativas < MAX_RETRIES) {
                try {
                    await waitForRateSlot();
                    self.postMessage({ type: 'LOG', message: `Worker ${workerIndex} -> ${url}` });
                    const response = await fetch(url, { headers: config.HEADERS });

                    if (response.status === 429) {
                        console.warn(`API Limitada (429) no offset ${offset}. Tentativa ${tentativas + 1}. Aguardando ${delayAtual + EXTRA_429}ms...`);
                        addGlobalDelay(BASE_DELAY + EXTRA_429);
                        await delay(delayAtual + EXTRA_429);
                        delayAtual *= 2; 
                        tentativas++;
                        continue;
                    }

                    if (!response.ok) throw new Error(`Erro HTTP: ${response.status}`);

                    const result = await response.json();
                    if (result && result.data) {
                        result.data.forEach((city, idx) => {
                            const currentIdx = offset + idx;
                            if (currentIdx >= count) return;

                            const baseIdx = currentIdx * 3;

                            view[baseIdx] = city.latitude || 0;
                            view[baseIdx + 1] = city.longitude || 0;
                            view[baseIdx + 2] = city.population || 0;

                            fetchedCities.push({
                                index: currentIdx,
                                id: city.id,
                                city: city.city,
                                country: city.country,
                                latitude: city.latitude,
                                longitude: city.longitude,
                                population: city.population
                            });
                        });
                        sucesso = true;
                        self.postMessage({ type: 'PROGRESS', currentCount: fetchedCities.length, workerIndex });
                    } else {
                        sucesso = true;
                    }
                } catch (err) {
                    console.error(`Erro na requisição offset ${offset}:`, err);
                    tentativas++;
                    await delay(delayAtual);
                }
            }
        }

        self.postMessage({ type: 'DONE', data: fetchedCities, workerIndex });

    } catch (error) {
        self.postMessage({ type: 'ERROR', message: error.message, workerIndex });
    }
};