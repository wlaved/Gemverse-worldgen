import { createNoise2D, createNoise3D } from 'https://cdn.skypack.dev/simplex-noise';

// --- Constants ---
const CHUNK_SIZE = 32;

// --- Block Registry Vars ---
const MAX_BLOCK_ID = 0xFFF;
const ENGINE_IDS = 256;
let reg = new Map();
let rev = new Array(MAX_BLOCK_ID + 1);
let nextID = ENGINE_IDS;
let BLOCK = {};

// --- World Generation Vars ---
let noise = {};
let worldParams = {};

// --- Helper Functions ---
function seededRandom(s) { return function() { s = Math.sin(s) * 10000; return s - Math.floor(s); } }
function xxh64(a, b) {
    let s = BigInt(a), t = BigInt(b), m = 0x9e3779b97f4a7c15n;
    s ^= t; s *= m; s ^= s >> 32n; s *= m; s ^= s >> 29n;
    return Number(s & 0xffffffffn);
}

// --- Block Registry Functions ---
function initBlockRegistry(seed64) {
    reg.clear();
    rev.fill(null);
    BLOCK = {};
    const staples = ['AIR','STONE','DIRT','GRASS','SAND','WATER','LAVA','BASALT','OBSIDIAN','WOOD','LEAVES','GOLD_ORE','GEM_ORE','MUSHROOM_STEM','MUSHROOM_GLOW'];
    staples.forEach((name,i)=>{
        BLOCK[name] = i;
        const rec = {
            name,
            baseH: (Math.abs(seed64+i)*17) % 360 / 360,
            baseS: 0.5,
            baseL: 0.5,
            emissive: (name.includes('GLOW') || name.includes('LAVA') || name.includes('GEM')) ? 1 : 0,
            transparent: (name.includes('WATER') || name.includes('LEAVES')) ? 1 : 0,
            roughness: 0.8
        };
        reg.set(name,i);
        rev[i]=rec;
    });
    nextID = ENGINE_IDS;
}

function registerBlock(hash32) {
    let id = reg.get(hash32);
    if(id !== undefined) return id;

    id = (nextID > MAX_BLOCK_ID) ? (hash32 & 0x3FF) + ENGINE_IDS : nextID++;
    const seed = hash32;
    rev[id] = {
        name:'block_'+id,
        baseH: (seed*17)%360/360,
        baseS: 0.4+(seed*19)%100/250,
        baseL: 0.3+(seed*23)%100/200,
        emissive: (seed & 0xF) < 2 ? 1:0,
        transparent: (seed & 0xF) === 3 ? 1:0,
        roughness: 0.2+(seed*29)%100/125
    };
    reg.set(hash32,id);
    return id;
}

function packBlock(id,aux=0){ return (id&0xFFF)|(aux<<12); }
function unpackBlock(packed){ return {id:packed&0xFFF, aux:(packed>>12)&0xF}; }

// --- Rarity Logic ---
function getDepthKm(x,y,z,bounds){ return Math.max(0, Math.min(bounds-Math.abs(x), bounds-Math.abs(y), bounds-Math.abs(z))) / 1000; }
function rarityAt(depthKm,optKm,sigmaKm){ const d=(depthKm-optKm)/sigmaKm; return Math.exp(-0.5*d*d); }
function chooseBlockWithDepth(blockHash, depthKm, rarityTable, randFunc){
  const base = rarityTable.baseChance(blockHash);
  const ramp = rarityAt(depthKm, rarityTable.optimalKm, rarityTable.sigmaKm);
  return (randFunc() < base * ramp) ? registerBlock(blockHash) : reg.get('STONE');
}

// --- Worm Carver ---
function carveWorms(chunkX,chunkY,chunkZ,seed){
    const out=new Uint8Array(32*32*32).fill(0);
    const rand=(a)=>{let s=seed+a; s=(s>>16)^(s*0x85ebca6b); return (s&0xffff)/0x10000;};
    const worms=3+Math.floor(rand(0)*3);
    for(let w=0;w<worms;w++){
        let x=rand(w+1)*32|0, y=rand(w+2)*32|0, z=rand(w+3)*32|0;
        const steps=30+rand(w+4)*30|0, rad=2.5+rand(w+5)*2;
        for(let s=0;s<steps;s++){
            const dx=(rand(s+1000)-0.5)*0.8, dy=(rand(s+2000)-0.5)*0.2, dz=(rand(s+3000)-0.5)*0.8;
            x=Math.max(0,Math.min(31,x+dx)); y=Math.max(0,Math.min(31,y+dy)); z=Math.max(0,Math.min(31,z+dz));
            const r2=rad*rad, r=Math.ceil(rad);
            for(let ox=-r;ox<=r;ox++)for(let oy=-r;oy<=r;oy++)for(let oz=-r;oz<=r;oz++){
                if(ox*ox+oy*oy+oz*oz>r2) continue;
                const bx=(x+ox)|0, by=(y+oy)|0, bz=(z+dz)|0;
                if(bx<0||bx>=32||by<0||by>=32||bz<0||bz>=32) continue;
                out[((by*CHUNK_SIZE)|bz)*CHUNK_SIZE|bx]=1;
            }
        }
    }
    return out;
}

// --- Chunk Data Generation ---
function generateChunkDataCPU(chunkX, chunkY, chunkZ) {
    const data = new Uint16Array(CHUNK_SIZE*CHUNK_SIZE*CHUNK_SIZE).fill(0);
    const set = (x,y,z,t,a=0) => { if(x>=0&&x<32&&y>=0&&y<32&&z>=0&&z<32) data[y*1024+z*32+x] = packBlock(t, a); };
    const { densityScale, densityThreshold, worldBounds, hollowRadius, biomes, rarityTable } = worldParams;
    const AIR_ID = BLOCK.AIR, STONE_ID = BLOCK.STONE, BASALT_ID = BLOCK.BASALT;

    const wormMask = carveWorms(chunkX, chunkY, chunkZ, worldParams.numericalSeed + chunkX + chunkY + chunkZ);

    for (let y=0; y<32; y++) for (let x=0; x<32; x++) for (let z=0; z<32; z++) {
        const globalX = chunkX*32+x, globalY = chunkY*32+y, globalZ = chunkZ*32+z;
        if (Math.abs(globalX) > worldBounds || Math.abs(globalY) > worldBounds || Math.abs(globalZ) > worldBounds) continue;
        if (wormMask[y*1024+z*32+x] === 1) { set(x,y,z, AIR_ID); continue; }

        let density = noise.density(globalX/densityScale, globalY/densityScale, globalZ/densityScale);
        if (biomes.has('SKY')) density += noise.island(globalX/40, globalY/30, globalZ/40) * 1.5 - 0.75;

        let blockID = AIR_ID;
        if (biomes.has('HOLLOW')) {
            if (Math.sqrt(globalX*globalX+globalY*globalY+globalZ*globalZ) < hollowRadius) { set(x,y,z, AIR_ID); continue; }
            if (density > densityThreshold) blockID = STONE_ID;
        } else if (density > densityThreshold) {
            blockID = biomes.has('VOLCANIC') ? BASALT_ID : STONE_ID;
        }

        if (blockID === STONE_ID && globalY < worldBounds*0.2) {
            const depthKm = getDepthKm(globalX, globalY, globalZ, worldBounds);
            const matHash = xxh64(globalX, xxh64(globalY, globalZ ^ worldParams.numericalSeed));
            blockID = chooseBlockWithDepth(matHash, depthKm, rarityTable, noise.rand);
        }
        set(x,y,z, blockID);
    }
    return data;
}

// --- Post Processing ---
function postProcessChunkData(data, chunkX, chunkY, chunkZ) {
    // Block IDs used in this function
    const { AIR, STONE, DIRT, GRASS, SAND, WATER, BASALT, OBSIDIAN, LAVA, MUSHROOM_STEM, MUSHROOM_GLOW, WOOD, LEAVES, GEM_ORE } = BLOCK;
    const get = (x,y,z) => (x<0||x>31||y<0||y>31||z<0||z>31) ? AIR : unpackBlock(data[y*1024+z*32+x]).id;
    const set = (x,y,z,t) => { if(x>=0&&x<32&&y>=0&&y<32&&z>=0&&z<32) data[y*1024+z*32+x] = packBlock(t, 0); };

    const facePositions = [ { dir: [-1,0,0] }, { dir: [1,0,0] }, { dir: [0,-1,0] }, { dir: [0,1,0] }, { dir: [0,0,-1] }, { dir: [0,0,1] } ];
    const { liquidCoreSize, biomes } = worldParams;

    for (let x=0; x<32; x++) for (let z=0; z<32; z++) for (let y=0; y<32; y++) {
        const gX=chunkX*32+x, gY=chunkY*32+y, gZ=chunkZ*32+z;

        if (liquidCoreSize > 0 && Math.abs(gX)<liquidCoreSize && Math.abs(gY)<liquidCoreSize && Math.abs(gZ)<liquidCoreSize && get(x,y,z)===AIR) {
            if (noise.waterCave(gX/50,gY/50,gZ/50) < 0.6) { set(x,y,z, biomes.has('VOLCANIC') ? LAVA : WATER); continue; }
        }

        const currentBlock = get(x,y,z);
        if (currentBlock === AIR || currentBlock === WATER || currentBlock === LAVA) continue;

        let surfaceNormal = null, isInnerSurface = false;
        for(const face of facePositions) if (get(x+face.dir[0], y+face.dir[1], z+face.dir[2]) === AIR) {
            surfaceNormal = face.dir;
            if (Math.sqrt((gX+surfaceNormal[0])**2 + (gY+surfaceNormal[1])**2 + (gZ+surfaceNormal[2])**2) < Math.sqrt(gX**2+gY**2+gZ**2)) isInnerSurface = true;
            break;
        }

        if (surfaceNormal) {
            if (isInnerSurface && biomes.has('HOLLOW')) {
                if (currentBlock === STONE && noise.rand() < 0.05) set(x,y,z, GEM_ORE);
            } else {
                if (currentBlock === STONE || currentBlock === DIRT) {
                    if (biomes.has('TERRA')||biomes.has('ALIEN')||biomes.has('SKY')) set(x,y,z, GRASS);
                    else if (biomes.has('VOLCANIC')||biomes.has('HOLLOW')) set(x,y,z, OBSIDIAN);
                    else if (biomes.has('TROPICAL')) set(x,y,z, SAND);
                }
                if (get(x,y,z)===GRASS && worldParams.treeChance && noise.feature(gX/10,gZ/10)>0.7) {
                    const h=4+Math.floor(noise.rand()*3);
                    for(let i=1;i<=h;i++) set(x+surfaceNormal[0]*i, y+surfaceNormal[1]*i, z+surfaceNormal[2]*i, WOOD);
                    const r=2, tX=x+surfaceNormal[0]*h, tY=y+surfaceNormal[1]*h, tZ=z+surfaceNormal[2]*h;
                    for(let ly=-r;ly<=r;ly++)for(let lx=-r;lx<=r;lx++)for(let lz=-r;lz<=r;lz++) if(lx*lx+ly*ly+lz*lz<=r*r) set(tX+lx,tY+ly,tZ+lz,LEAVES);
                }
                if ((currentBlock===STONE||currentBlock===BASALT) && biomes.has('ALIEN') && noise.feature(gX/8,gZ/8)>0.6) {
                    const h=3+Math.floor(noise.rand()*4);
                    for(let i=1;i<=h;i++) set(x+surfaceNormal[0]*i,y+surfaceNormal[1]*i,z+surfaceNormal[2]*i,MUSHROOM_STEM);
                    const r=1+Math.floor(noise.rand()*2), tX=x+surfaceNormal[0]*h, tY=y+surfaceNormal[1]*h, tZ=z+surfaceNormal[2]*h;
                    for(let ly=-r;ly<=r;ly++)for(let lx=-r;lx<=r;lx++)for(let lz=-r;lz<=r;lz++) if(lx*lx+ly*ly+lz*lz<=r*r) set(tX+lx,tY+ly,tZ+lz,MUSHROOM_GLOW);
                }
            }
        }
    }
    return data;
}

// --- Greedy Meshing ---
function buildGreedyMesh(chunkData) {
    const geometries = {};
    const physicsVertices = [];
    const physicsIndices = [];
    const size = CHUNK_SIZE;
    const AIR_ID = BLOCK.AIR;
    const WATER_ID = BLOCK.WATER;
    const LEAVES_ID = BLOCK.LEAVES;

    const getBlock = (x, y, z) => (x<0||x>=size||y<0||y>=size||z<0||z>=size) ? AIR_ID : unpackBlock(chunkData[y*size*size+z*size+x]).id;

    for (let d = 0; d < 3; ++d) {
        const u = (d + 1) % 3;
        const v = (d + 2) % 3;
        const x = [0, 0, 0];
        const q = [0, 0, 0];
        const mask = new Int32Array(size * size);
        q[d] = 1;

        for (x[d] = -1; x[d] < size;) {
            let n = 0;
            for (x[v] = 0; x[v] < size; ++x[v]) for (x[u] = 0; x[u] < size; ++x[u]) {
                const currentBlock = (x[d] >= 0) ? getBlock(x[0], x[1], x[2]) : AIR_ID;
                const nextBlock = (x[d] < size - 1) ? getBlock(x[0] + q[0], x[1] + q[1], x[2] + q[2]) : AIR_ID;
                const currentIsTransparent = currentBlock === AIR_ID || currentBlock === WATER_ID || currentBlock === LEAVES_ID;
                const nextIsTransparent = nextBlock === AIR_ID || nextBlock === WATER_ID || nextBlock === LEAVES_ID;
                mask[n++] = (currentIsTransparent === nextIsTransparent) ? 0 : (currentIsTransparent ? nextBlock : -currentBlock);
            }
            x[d]++;
            n = 0;
            for (let j = 0; j < size; ++j) for (let i = 0; i < size;) {
                if (mask[n] !== 0) {
                    const currentMask = mask[n];
                    let w = 1;
                    while (i + w < size && mask[n + w] === currentMask) w++;
                    let h = 1, done = false;
                    while (j + h < size) {
                        for (let k = 0; k < w; ++k) if (mask[n + k + h * size] !== currentMask) { done = true; break; }
                        if (done) break;
                        h++;
                    }
                    x[u] = i; x[v] = j;
                    const du = [0,0,0], dv = [0,0,0];
                    du[u] = w; dv[v] = h;
                    const blockId = Math.abs(currentMask);

                    const p = [x[0], x[1], x[2]];
                    const positions = [
                        p[0], p[1], p[2],
                        p[0] + du[0], p[1] + du[1], p[2] + du[2],
                        p[0] + dv[0], p[1] + dv[1], p[2] + dv[2],
                        p[0] + du[0] + dv[0], p[1] + du[1] + dv[1], p[2] + du[2] + dv[2]
                    ];
                    const idx = physicsVertices.length / 3;
                    positions.forEach(pv => physicsVertices.push(pv));
                    const indices = (currentMask > 0) ? [0, 2, 1, 1, 2, 3] : [0, 1, 2, 2, 1, 3];
                    indices.forEach(ind => physicsIndices.push(idx + ind));

                    if (!geometries[blockId]) geometries[blockId] = { positions: [], indices: [] };
                    const geo = geometries[blockId];
                    const geoIdx = geo.positions.length / 3;
                    positions.forEach(pos => geo.positions.push(pos));
                    indices.forEach(ind => geo.indices.push(geoIdx + ind));

                    for (let l = 0; l < h; ++l) for (let k = 0; k < w; ++k) mask[n + k + l * size] = 0;
                    i += w; n += w;
                } else { i++; n++; }
            }
        }
    }
    return { geometries, physicsVertices, physicsIndices };
}

// --- Message Handler ---
self.onmessage = (e) => {
    const { type, payload } = e.data;
    if (type === 'init') {
        const { numericalSeed, params } = payload;
        params.biomes = new Set(params.biomes);
        worldParams = params;
        initBlockRegistry(numericalSeed);
        noise.density = createNoise3D(seededRandom(numericalSeed + 2));
        noise.island = createNoise3D(seededRandom(numericalSeed + 3));
        noise.feature = createNoise2D(seededRandom(numericalSeed + 4));
        noise.cave = createNoise3D(seededRandom(numericalSeed + 5));
        noise.waterCave = createNoise3D(seededRandom(numericalSeed + 6));
        noise.rand = seededRandom(numericalSeed + 7);
    } else if (type === 'generate') {
        const { chunkX, chunkY, chunkZ } = payload;
        const processedData = postProcessChunkData(generateChunkDataCPU(chunkX, chunkY, chunkZ), chunkX, chunkY, chunkZ);
        const { geometries, physicsVertices, physicsIndices } = buildGreedyMesh(processedData);

        const transferables = [new Float32Array(physicsVertices).buffer, new Uint32Array(physicsIndices).buffer];
        for(const id in geometries) {
            transferables.push(new Float32Array(geometries[id].positions).buffer, new Uint32Array(geometries[id].indices).buffer);
        }

        self.postMessage({ type: 'result', payload: { chunkX, chunkY, chunkZ, geometries, physicsVertices: new Float32Array(physicsVertices), physicsIndices: new Uint32Array(physicsIndices) } }, transferables);
    }
};
