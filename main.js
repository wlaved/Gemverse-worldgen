import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createNoise2D, createNoise3D } from 'https://cdn.skypack.dev/simplex-noise';

// --- DOM Elements ---
const seedInput = document.getElementById('seedInput');
const generateButton = document.getElementById('generateButton');
const worldInfo = document.getElementById('worldInfo');
const loader = document.getElementById('loader');
const canvasContainer = document.getElementById('canvas-container');
const worldCanvas = document.getElementById('worldCanvas');
const controlsOverlay = document.getElementById('controls-overlay');
const toggleCustomButton = document.getElementById('toggleCustomButton');
const customOptions = document.getElementById('customOptions');
const worldTypeSelect = document.getElementById('worldTypeSelect');
const worldSizeSelect = document.getElementById('worldSizeSelect');
const gpuStatus = document.getElementById('gpuStatus');

// --- Worker ---
const worker = new Worker('worker.js', { type: 'module' });
let pendingChunks = new Set();


// --- Helper Functions (Main Thread) ---
function createSeedFromString(str) { let h=0; for(let i=0;i<str.length;i++)h=((h<<5)-h)+str.charCodeAt(i),h|=0; return h; }
function seededRandom(s) { return function() { s = Math.sin(s) * 10000; return s - Math.floor(s); } }

// --- Constants ---
const CHUNK_SIZE = 32;
const VIEW_DISTANCE = 1;
const CENTER_BOX_HALF_SIZE = 10.5;

// --- Physics Collision Groups ---
const GROUP_PLAYER = 1;
const GROUP_WALL = 2;
const GROUP_WORLD = 4;

// --- Block Registry (Main Thread) ---
const MAX_BLOCK_ID = 0xFFF;
let rev = new Array(MAX_BLOCK_ID + 1);
let BLOCK = {};

// --- Core Engine Vars ---
let scene, camera, renderer, cannonWorld, playerBody, gravityGridLines, controls;
let clock = new THREE.Clock();
let currentSeedString = 'Arcadia';
let worldChunks = {};
let noise = {};
let worldParams = {};
let worldMaterials = {};
let lastPlayerChunk = {x: null, y: null, z: null};
let chunkUpdateInterval = 0;
let isWorldReady = false;

// --- Player Control Vars ---
let currentUp = new THREE.Vector3(0,1,0);
const targetUp = new THREE.Vector3(0,1,0);

// --- Block Registry Functions (Main Thread) ---
function initBlockRegistry(seed64) {
    BLOCK = {};
    const staples = ['AIR','STONE','DIRT','GRASS','SAND','WATER','LAVA','BASALT','OBSIDIAN','WOOD','LEAVES','GOLD_ORE','GEM_ORE','MUSHROOM_STEM','MUSHROOM_GLOW'];
    staples.forEach((name,i)=>{
        BLOCK[name] = i;
        rev[i] = {
            name,
            baseH: (Math.abs(seed64+i)*17) % 360 / 360,
            baseS: 0.5,
            baseL: 0.5,
            emissive: (name.includes('GLOW') || name.includes('LAVA') || name.includes('GEM')) ? 1 : 0,
            transparent: (name.includes('WATER') || name.includes('LEAVES')) ? 1 : 0,
        };
    });
}


// --- Controls Class ---
class Controls {
    constructor(camera, playerBody, worldCanvas) {
        this.camera = camera;
        this.playerBody = playerBody;
        this.worldCanvas = worldCanvas;
        this.pitch = 0;
        this.yaw = 0;
        this.isFlying = false;
        this.canJump = false;
        this.keys = {};
        this.forwardVec = new THREE.Vector3();
        this.rightVec = new THREE.Vector3();
        this.worldVelocity = new THREE.Vector3();
    }

    init() {
        window.addEventListener('keydown', (e) => this.onKeyDown(e));
        window.addEventListener('keyup', (e) => this.onKeyUp(e));
        this.worldCanvas.addEventListener('mousedown', () => this.hideOverlay());
    }

    onKeyDown(e) {
        this.keys[e.code] = true;
        this.hideOverlay();
        if (e.code === 'KeyF') this.isFlying = !this.isFlying;
        if (e.code === 'Space' && !this.isFlying && this.canJump) {
            const upVec = new CANNON.Vec3(currentUp.x, currentUp.y, currentUp.z);
            this.playerBody.velocity.vadd(upVec.scale(6), this.playerBody.velocity);
            this.canJump = false;
        }
    }

    onKeyUp(e) {
        this.keys[e.code] = false;
    }

    hideOverlay() {
        controlsOverlay.classList.remove('visible');
    }

    handleLook(delta) {
        const lookSpeed = 1.5 * delta;
        if (this.keys.ArrowUp) this.pitch += lookSpeed;
        if (this.keys.ArrowDown) this.pitch -= lookSpeed;
        if (this.keys.ArrowLeft) this.yaw += lookSpeed;
        if (this.keys.ArrowRight) this.yaw -= lookSpeed;
        this.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.pitch));
    }

    update(delta) {
        this.handleLook(delta);
        const speed = 5;
        const moveX = (this.keys.KeyD ? 1 : 0) - (this.keys.KeyA ? 1 : 0);
        const moveZ = (this.keys.KeyW ? 1 : 0) - (this.keys.KeyS ? 1 : 0);

        const upQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0), currentUp);
        const yawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), this.yaw);
        const pitchQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0), this.pitch);
        this.camera.quaternion.copy(upQuat).multiply(yawQuat).multiply(pitchQuat);

        this.camera.getWorldDirection(this.forwardVec);
        this.rightVec.crossVectors(this.forwardVec, currentUp).normalize();
        const forwardOnPlane = new THREE.Vector3().crossVectors(currentUp, this.rightVec);

        this.worldVelocity.set(0,0,0).add(forwardOnPlane.multiplyScalar(moveZ)).add(this.rightVec.multiplyScalar(moveX));
        if (this.worldVelocity.length() > 0) this.worldVelocity.normalize().multiplyScalar(speed);

        const upVec = new CANNON.Vec3(currentUp.x, currentUp.y, currentUp.z);
        let v_comp = new CANNON.Vec3();
        if (!this.isFlying) v_comp = upVec.scale(this.playerBody.velocity.dot(upVec));

        this.playerBody.velocity.copy(new CANNON.Vec3(this.worldVelocity.x, this.worldVelocity.y, this.worldVelocity.z).vadd(v_comp));

        if (this.isFlying) {
            const fly_v = new CANNON.Vec3(currentUp.x, currentUp.y, currentUp.z).scale(((this.keys.Space?1:0) - (this.keys.ShiftLeft?1:0)) * speed);
            this.playerBody.velocity.copy(this.worldVelocity).vadd(fly_v, this.playerBody.velocity);
        } else {
            this.canJump = cannonWorld.raycastClosest(this.playerBody.position, this.playerBody.position.vsub(upVec.scale(1.1)), {}, new CANNON.RaycastResult());
        }
    }
}


// --- Initialization ---
async function init() {
    gpuStatus.textContent = "World generation running in background.";
    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x87CEEB, CHUNK_SIZE*VIEW_DISTANCE*2, CHUNK_SIZE*(VIEW_DISTANCE*2+1));
    camera = new THREE.PerspectiveCamera(75, canvasContainer.clientWidth/canvasContainer.clientHeight, 0.1, 1000);
    renderer = new THREE.WebGLRenderer({ canvas: worldCanvas, antialias: true });

    const ambientLight = new THREE.AmbientLight(0xb0c0d0, 1.5);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 2.5);
    directionalLight.position.set(1, 1, 0.5).normalize();
    scene.add(directionalLight);

    cannonWorld = new CANNON.World();
    cannonWorld.gravity.set(0,0,0);

    playerBody = new CANNON.Body({ mass: 5, fixedRotation: true, linearDamping: 0.01 });
    playerBody.addShape(new CANNON.Cylinder(0.4, 0.4, 1.0, 8));
    playerBody.addShape(new CANNON.Sphere(0.4), new CANNON.Vec3(0, -0.5, 0));
    playerBody.collisionFilterGroup = GROUP_PLAYER;
    playerBody.collisionFilterMask = GROUP_WALL | GROUP_WORLD;
    cannonWorld.addBody(playerBody);

    initControls();
    createGravityGridLines();
    createCenterPlanes();
    window.addEventListener('resize', onWindowResize);
    onWindowResize();
    animate();
}

function initControls() {
    controls = new Controls(camera, playerBody, worldCanvas);
    controls.init();
}

function onWindowResize() {
    if (camera && renderer) {
        const width = canvasContainer.clientWidth;
        const height = canvasContainer.clientHeight;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height);
    }
}

// --- Chunk Management & Worker ---
function updateChunks() { /* ... unchanged ... */ }
worker.onmessage = (e) => { /* ... unchanged ... */ };


// --- Main World Functions ---
function updateWorldInfo(seed, { x, y, z }) { /* ... unchanged ... */ }
function generateWorldMaterials() { /* ... unchanged ... */ }
function getWorldParams(seed, overrides = {}) { /* ... unchanged ... */ }

function getBlockIdAtGlobal(globalX, globalY, globalZ) {
    const { densityScale, densityThreshold, worldBounds, hollowRadius, biomes } = worldParams;
    if (Math.abs(globalX) > worldBounds || Math.abs(globalY) > worldBounds || Math.abs(globalZ) > worldBounds) return BLOCK.AIR;
    let density = noise.density(globalX / densityScale, globalY / densityScale, globalZ / densityScale);
    if (biomes.has('SKY')) density += noise.island(globalX / 40, globalY / 30, globalZ / 40) * 1.5 - 0.75;
    let blockID = BLOCK.AIR;
    if (biomes.has('HOLLOW')) {
        if (Math.sqrt(globalX*globalX + globalY*globalY + globalZ*globalZ) < hollowRadius) return BLOCK.AIR;
        if (density > densityThreshold) blockID = BLOCK.STONE;
    } else if (density > densityThreshold) {
        blockID = biomes.has('VOLCANIC') ? BLOCK.BASALT : BLOCK.STONE;
    }
    if (blockID !== BLOCK.AIR && noise.cave(globalX / 25, globalY / 25, globalZ / 25) > 0.65) blockID = BLOCK.AIR;
    return blockID;
}

function findSafeSpawn(worldBounds) {
    for (let y = Math.floor(worldBounds); y > -worldBounds; y--) {
        const blockId = getBlockIdAtGlobal(0, y, 0);
        if (blockId !== BLOCK.AIR && blockId !== BLOCK.WATER && blockId !== BLOCK.LAVA) return { x: 0, y: y + 2, z: 0 };
    }
    console.warn("No solid ground found at (0,y,0). Spawning at center box.");
    return { x: 0, y: CENTER_BOX_HALF_SIZE + 2, z: 0 };
}


// --- Main ---
async function startNewWorld(seed, overrides) {
    try {
        currentSeedString = seed;
        loader.style.display = 'flex';
        isWorldReady = false;
        controlsOverlay.classList.add('visible');
        controls.isFlying = false;

        for(const chunkId in worldChunks) {
            if (worldChunks[chunkId].group) scene.remove(worldChunks[chunkId].group);
            if (worldChunks[chunkId].body) cannonWorld.remove(worldChunks[chunkId].body);
            worldChunks[chunkId].group?.children.forEach(c => c.geometry?.dispose());
        }
        worldChunks = {};
        pendingChunks.clear();
        lastPlayerChunk = {x: null, y: null, z: null};

        const numericalSeed = createSeedFromString(seed);
        initBlockRegistry(numericalSeed);
        worldParams = getWorldParams(seed, overrides);
        if (worldParams) {
            worldParams.numericalSeed = numericalSeed;
            const transferableParams = { ...worldParams, biomes: Array.from(worldParams.biomes) };
            worker.postMessage({ type: 'init', payload: { numericalSeed, params: transferableParams } });
        }

        noise.density = createNoise3D(seededRandom(numericalSeed + 2));
        noise.island = createNoise3D(seededRandom(numericalSeed + 3));
        noise.cave = createNoise3D(seededRandom(numericalSeed + 5));

        worldMaterials = generateWorldMaterials();
        scene.background = new THREE.Color(worldParams.biomes.has('VOLCANIC') || worldParams.biomes.has('HOLLOW') ? 0x111827 : 0x87CEEB);
        scene.fog.color.copy(scene.background);
        camera.up.set(0,1,0);
        currentUp.set(0,1,0);
        controls.pitch = 0;
        controls.yaw = 0;

        const spawnPoint = findSafeSpawn(worldParams.worldBounds);
        playerBody.position.set(spawnPoint.x, spawnPoint.y, spawnPoint.z);
        playerBody.velocity.set(0,0,0);
        playerBody.angularVelocity.set(0,0,0);

        isWorldReady = true;
        updateChunks();
    } catch (error) {
        console.error("Error starting new world:", error);
        loader.style.display = 'none';
    }
}


// --- Animation Loop ---
function animate() {
    requestAnimationFrame(animate);
    const delta = Math.min(clock.getDelta(), 0.1);
    if (delta <= 0 || !isWorldReady) return;

    const pos = playerBody.position;
    const inDeadZone = Math.abs(pos.x)<CENTER_BOX_HALF_SIZE && Math.abs(pos.y)<CENTER_BOX_HALF_SIZE && Math.abs(pos.z)<CENTER_BOX_HALF_SIZE;
    if (!inDeadZone) {
        const {x,y,z} = pos;
        if (Math.abs(y)>=Math.abs(x) && Math.abs(y)>=Math.abs(z)) targetUp.set(0,Math.sign(y)||1,0);
        else if (Math.abs(x)>=Math.abs(y) && Math.abs(x)>=Math.abs(z)) targetUp.set(Math.sign(x)||1,0,0);
        else targetUp.set(0,0,Math.sign(z)||1);
        currentUp.lerp(targetUp, 0.1).normalize();
    }

    if (!controls.isFlying) {
        playerBody.applyForce(new CANNON.Vec3(-targetUp.x*100, -targetUp.y*100, -targetUp.z*100), pos);
        playerBody.collisionFilterMask = controls.keys.ShiftLeft ? (GROUP_PLAYER|GROUP_WORLD) : (GROUP_PLAYER|GROUP_WALL|GROUP_WORLD);
    } else {
        playerBody.collisionFilterMask = GROUP_PLAYER | GROUP_WORLD;
    }

    cannonWorld.step(1/60, delta, 10);
    controls.update(delta);
    camera.position.copy(pos);
    chunkUpdateInterval = (chunkUpdateInterval+delta) % 0.25;
    if(chunkUpdateInterval < delta) updateChunks();
    renderer.render(scene, camera);
}

function createGravityGridLines() {
    const size = CENTER_BOX_HALF_SIZE * 2;
    const halfSize = CENTER_BOX_HALF_SIZE;
    const gridMaterial = new THREE.MeshLambertMaterial({
        color: 0x00ffff,
        emissive: 0x00ffff,
        transparent: true,
        opacity: 0.2,
        side: THREE.DoubleSide,
        depthWrite: false
    });

    gravityGridLines = new THREE.Group();
    const planeGeometry = new THREE.PlaneGeometry(size, size);

    const planes = [
        { pos: [halfSize, 0, 0], rot: [0, Math.PI/2, 0] }, { pos: [-halfSize, 0, 0], rot: [0, -Math.PI/2, 0] },
        { pos: [0, halfSize, 0], rot: [-Math.PI/2, 0, 0] }, { pos: [0, -halfSize, 0], rot: [Math.PI/2, 0, 0] },
        { pos: [0, 0, halfSize], rot: [0, 0, 0] }, { pos: [0, 0, -halfSize], rot: [0, Math.PI, 0] }
    ];

    planes.forEach(p => {
        const plane = new THREE.Mesh(planeGeometry, gridMaterial);
        plane.position.set(...p.pos);
        plane.rotation.set(...p.rot);
        gravityGridLines.add(plane);
    });

    scene.add(gravityGridLines);
}

function createCenterPlanes() { /* ... unchanged ... */ }


// --- Event Listeners ---
toggleCustomButton.addEventListener('click', () => { /* ... unchanged ... */ });
generateButton.addEventListener('click', handleGenerateClick);
seedInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleGenerateClick(); });

function handleGenerateClick() {
    let seed = seedInput.value.trim() || Math.random().toString(36).substring(2, 10);
    seedInput.value = seed;
    startNewWorld(seed, { worldType: worldTypeSelect.value, worldSize: worldSizeSelect.value });
}

// --- Start ---
init().then(() => startNewWorld('Olympus')).catch(err => {
    console.error("Initialization failed:", err);
    gpuStatus.textContent = "Error during initialization.";
});
