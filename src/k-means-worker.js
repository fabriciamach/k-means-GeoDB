// centroid: { lat: number, lon: number, pop: number }
//Pop balanceada para ficar próximo de lat e lon
const calculateDistance = (city, centroid) => {
    const latDiff = city.lat - centroid.lat;
    const lonDiff = city.lon - centroid.lon;
    const popDiff = (city.pop / 1000000) - (centroid.pop / 1000000);

    return Math.sqrt(latDiff * latDiff + lonDiff * lonDiff + popDiff * popDiff);
};

self.onmessage = (e) => {
    const { startIdx, endIdx, centroids, sharedBuffer } = e.data;
    
    const data = new Float64Array(sharedBuffer);
    
    const partials = centroids.map(() => ({
        lat: 0,
        lon: 0,
        pop: 0,
        count: 0
    }));

    // Percorre o chunk de cidades para este worker
    for (let i = startIdx; i < endIdx; i++) {
        const base = i * 3;
        const city = {
            lat: data[base],
            lon: data[base + 1],
            pop: data[base + 2]
        };

        // Ignora dados zerados (caso a busca ainda não tenha preenchido tudo)
        if (city.lat === 0 && city.lon === 0) continue;

        let minDist = Infinity;
        let closestIdx = 0;

        // Encontra o centroide mais próximo
        centroids.forEach((centroid, idx) => {
            const dist = calculateDistance(city, centroid);
            if (dist < minDist) {
                minDist = dist;
                closestIdx = idx;
            }
        });

        // Acumula os valores para calcular a nova média
        partials[closestIdx].lat += city.lat;
        partials[closestIdx].lon += city.lon;
        partials[closestIdx].pop += city.pop;
        partials[closestIdx].count += 1;
    }

    // Retorna os resultados parciais 
    self.postMessage({ partials });
};