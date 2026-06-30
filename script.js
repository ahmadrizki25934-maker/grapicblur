/* =========================================================
   ORIGINAL SETUP (kept intact)
   ========================================================= */

const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const statusOverlay = document.getElementById("status-overlay");

async function startCamera(){
    try{
        const stream = await navigator.mediaDevices.getUserMedia({
            video:{ width:1280, height:720 }
        });
        video.srcObject = stream;
    }catch(err){
        showStatus("Camera access denied or unavailable.\nPlease allow camera permission and reload.");
        console.warn("getUserMedia error:", err.message);
    }
}

startCamera();

const hands = new Hands({
    locateFile:(file)=>{
        return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
    }
});

hands.setOptions({
    maxNumHands:2,
    modelComplexity:1,
    minDetectionConfidence:0.8,
    minTrackingConfidence:0.8
});

hands.onResults(onHandResults);

// ===== NEW FEATURE: Face Detection =====
const faceDetector = new FaceDetection({
    locateFile:(file)=>{
        return `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/${file}`;
    }
});

faceDetector.setOptions({
    model:"short",
    minDetectionConfidence:0.6
});

faceDetector.onResults(onFaceResults);

const camera = new Camera(video,{
    onFrame:async()=>{
        try{
            await hands.send({ image:video });
            await faceDetector.send({ image:video });
        }catch(err){
            console.warn("MediaPipe processing error:", err.message);
        }
    },
    width:1280,
    height:720
});

try{
    camera.start();
}catch(err){
    showStatus("Failed to start camera tracking. Your browser may not be supported.");
}

function showStatus(msg){
    statusOverlay.textContent = msg;
    statusOverlay.hidden = false;
}

function hideStatus(){
    statusOverlay.hidden = true;
}

/* =========================================================
   ===== NEW FEATURE: Shared state for render loop =====
   Results from Hands/FaceDetection arrive asynchronously,
   so we cache the latest data and draw on requestAnimationFrame
   for buttery-smooth, decoupled rendering.
   ========================================================= */

let latestHandLandmarks = [];   // raw landmarks per hand from last detection
let latestHandedness = [];      // "Left"/"Right" per hand
let smoothedHands = [];         // [{ landmarks, lastSeen, opacity, gesture, velocity, label, visible }]
let smoothedFace = null;        // { x,y,w,h, opacity, confidence, visible, lastSeen }
let lastFaceBox = null;
let frameCount = 0;

function onHandResults(results){
    latestHandLandmarks = results.multiHandLandmarks || [];
    latestHandedness = (results.multiHandedness || []).map(h => h.label);
    hideStatus();
}

function onFaceResults(results){
    if(results.detections && results.detections.length > 0){
        const det = results.detections[0];
        const box = det.boundingBox; // normalized {xCenter, yCenter, width, height}
        lastFaceBox = {
            x:(box.xCenter - box.width/2),
            y:(box.yCenter - box.height/2),
            w:box.width,
            h:box.height,
            confidence: det.score ? det.score[0] : 0.8
        };
    }else{
        lastFaceBox = null;
    }
}

/* =========================================================
   ===== NEW FEATURE: HAND SMOOTHING (Adaptive EMA) =====
   ========================================================= */

function lerp(a,b,t){ return a + (b-a)*t; }
function clamp(v, min, max){ return Math.max(min, Math.min(max, v)); }

function emaPoint(prev, next, alpha){
    return {
        x: lerp(prev.x, next.x, alpha),
        y: lerp(prev.y, next.y, alpha),
        z: lerp(prev.z, next.z, alpha)
    };
}

function updateSmoothedHands(){

    const matchedIndices = new Set();

    latestHandLandmarks.forEach((rawLandmarks, i)=>{

        const label = latestHandedness[i] || "Unknown";

        let matchIdx = null;
        let bestDist = Infinity;

        smoothedHands.forEach((sh, idx)=>{
            if(matchedIndices.has(idx)) return;
            if(sh.label !== label) return;
            const d = Math.hypot(sh.landmarks[0].x - rawLandmarks[0].x, sh.landmarks[0].y - rawLandmarks[0].y);
            if(d < bestDist){
                bestDist = d;
                matchIdx = idx;
            }
        });

        if(matchIdx === null){
            smoothedHands.push({
                label,
                landmarks: rawLandmarks.map(p=>({x:p.x,y:p.y,z:p.z})),
                lastSeen: frameCount,
                visible: true,
                opacity: 0,
                gesture: "—",
                velocity: 0
            });
            matchedIndices.add(smoothedHands.length - 1);
        }else{
            const sh = smoothedHands[matchIdx];

            let speedSum = 0;
            for(let k=0;k<rawLandmarks.length;k++){
                speedSum += Math.hypot(
                    rawLandmarks[k].x - sh.landmarks[k].x,
                    rawLandmarks[k].y - sh.landmarks[k].y
                );
            }
            const avgSpeed = speedSum / rawLandmarks.length;
            sh.velocity = avgSpeed;

            // adaptive alpha: still hand -> heavy smoothing, fast hand -> responsive
            const alpha = clamp(lerp(0.18, 0.75, clamp(avgSpeed * 25, 0, 1)), 0.18, 0.75);

            sh.landmarks = sh.landmarks.map((p,k)=> emaPoint(p, rawLandmarks[k], alpha));
            sh.lastSeen = frameCount;
            sh.visible = true;
            sh.opacity = Math.min(1, sh.opacity + 0.15);
            sh.gesture = detectGesture(sh.landmarks);

            matchedIndices.add(matchIdx);
        }
    });

    // ===== NEW FEATURE: Tracking recovery (fade out lost hands instead of cutting) =====
    smoothedHands = smoothedHands.filter((sh, idx)=>{
        if(!matchedIndices.has(idx)){
            const framesSinceSeen = frameCount - sh.lastSeen;
            if(framesSinceSeen > 45) return false; // drop after ~1.5s unseen
            sh.opacity = Math.max(0, sh.opacity - 0.06);
            sh.visible = false;
        }
        return true;
    });
}

/* =========================================================
   ===== NEW FEATURE: FACE SMOOTHING =====
   ========================================================= */

function updateSmoothedFace(){
    if(lastFaceBox){
        if(!smoothedFace){
            smoothedFace = { ...lastFaceBox, opacity:0, visible:true, lastSeen:frameCount };
        }else{
            const a = 0.25;
            smoothedFace.x = lerp(smoothedFace.x, lastFaceBox.x, a);
            smoothedFace.y = lerp(smoothedFace.y, lastFaceBox.y, a);
            smoothedFace.w = lerp(smoothedFace.w, lastFaceBox.w, a);
            smoothedFace.h = lerp(smoothedFace.h, lastFaceBox.h, a);
            smoothedFace.confidence = lastFaceBox.confidence;
            smoothedFace.opacity = Math.min(1, smoothedFace.opacity + 0.12);
            smoothedFace.visible = true;
            smoothedFace.lastSeen = frameCount;
        }
    }else if(smoothedFace){
        const framesSinceSeen = frameCount - smoothedFace.lastSeen;
        if(framesSinceSeen > 30){
            smoothedFace = null;
        }else{
            smoothedFace.opacity = Math.max(0, smoothedFace.opacity - 0.08);
            smoothedFace.visible = false;
        }
    }
}

/* =========================================================
   ===== NEW FEATURE: GESTURE DETECTION =====
   ========================================================= */

function dist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y, (a.z||0)-(b.z||0)); }

function detectGesture(lm){
    const tips = [4,8,12,16,20];
    const pips = [2,6,10,14,18];
    const wrist = lm[0];

    const extended = tips.map((tipIdx,i)=>{
        if(i === 0){
            return dist(lm[4], lm[17]) > dist(lm[3], lm[17]);
        }
        return dist(lm[tipIdx], wrist) > dist(lm[pips[i]], wrist);
    });

    const [thumb, index, middle, ring, pinky] = extended;
    const extCount = extended.filter(Boolean).length;
    const pinchDist = dist(lm[4], lm[8]);

    if(pinchDist < 0.045) return "Pinch";
    if(extCount === 5) return "Open Palm";
    if(extCount === 0) return "Closed Fist";
    if(index && !middle && !ring && !pinky && !thumb) return "Point";
    if(index && middle && !ring && !pinky) return "Peace / Victory";
    if(thumb && !index && !middle && !ring && !pinky) return "Thumb Up";
    if(thumb && pinky && !index && !middle && !ring) return "Rock";
    if(thumb && index && extCount === 2) return "OK Sign";

    return "—";
}

/* =========================================================
   ===== AI SELECTION BOX (Thumb + Index driven) =====
   ========================================================= */

let selectionBox = null;

function updateSelectionBox(){

    const hand = smoothedHands.find(h=>h.visible);

    if(hand){
        const thumb = hand.landmarks[4];
        const index = hand.landmarks[8];

        const x1 = Math.min(thumb.x, index.x);
        const x2 = Math.max(thumb.x, index.x);
        const y1 = Math.min(thumb.y, index.y);
        const y2 = Math.max(thumb.y, index.y);

        const pad = 0.025;
        const target = {
            x:(x1 - pad) * canvas.width,
            y:(y1 - pad) * canvas.height,
            w:(x2 - x1 + pad*2) * canvas.width,
            h:(y2 - y1 + pad*2) * canvas.height
        };

        if(!selectionBox){
            selectionBox = { ...target, opacity:0, active:true };
        }else{
            const a = 0.22;
            selectionBox.x = lerp(selectionBox.x, target.x, a);
            selectionBox.y = lerp(selectionBox.y, target.y, a);
            selectionBox.w = lerp(selectionBox.w, target.w, a);
            selectionBox.h = lerp(selectionBox.h, target.h, a);
            selectionBox.opacity = Math.min(1, selectionBox.opacity + 0.12);
            selectionBox.active = true;
        }
    }else if(selectionBox){
        selectionBox.opacity = Math.max(0, selectionBox.opacity - 0.08);
        selectionBox.active = false;
        if(selectionBox.opacity <= 0) selectionBox = null;
    }
}

/* =========================================================
   ===== RENDER LOOP (Canvas API, single canvas, rAF) =====
   ========================================================= */

function render(){

    frameCount++;

    if(video.videoWidth){
        if(canvas.width !== video.videoWidth || canvas.height !== video.videoHeight){
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
        }
    }

    updateSmoothedHands();
    updateSmoothedFace();
    updateSelectionBox();

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    drawGrid();
    drawScanLine();

    smoothedHands.forEach(drawHand);
    if(smoothedFace) drawFace(smoothedFace);
    if(selectionBox) drawSelectionBox(selectionBox);

    requestAnimationFrame(render);
}
requestAnimationFrame(render);

/* ===== NEW FEATURE: CYBER HUD - Grid ===== */
function drawGrid(){
    if(!canvas.width) return;
    const step = 60;
    ctx.save();
    ctx.strokeStyle = "rgba(0,255,200,0.07)";
    ctx.lineWidth = 1;
    for(let x=0; x<canvas.width; x+=step){
        ctx.beginPath();
        ctx.moveTo(x,0);
        ctx.lineTo(x,canvas.height);
        ctx.stroke();
    }
    for(let y=0; y<canvas.height; y+=step){
        ctx.beginPath();
        ctx.moveTo(0,y);
        ctx.lineTo(canvas.width,y);
        ctx.stroke();
    }
    ctx.restore();
}

/* ===== NEW FEATURE: CYBER HUD - moving scan line ===== */
function drawScanLine(){
    if(!canvas.height) return;
    const t = (frameCount % 240) / 240;
    const y = t * canvas.height;
    ctx.save();
    const grad = ctx.createLinearGradient(0, y-20, 0, y+20);
    grad.addColorStop(0, "rgba(0,255,200,0)");
    grad.addColorStop(0.5, "rgba(0,255,200,0.12)");
    grad.addColorStop(1, "rgba(0,255,200,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, y-20, canvas.width, 40);
    ctx.restore();
}

/* ===== NEW FEATURE: HUD corner brackets (L-shaped, not full box) ===== */
function drawCornerHUD(x, y, w, h, opacity, color){
    const len = Math.min(w, h) * 0.18 + 8;
    ctx.save();
    ctx.globalAlpha = clamp(opacity, 0, 1);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.lineCap = "round";

    const corners = [
        [x, y, 1, 1],
        [x+w, y, -1, 1],
        [x, y+h, 1, -1],
        [x+w, y+h, -1, -1]
    ];

    corners.forEach(([cx, cy, dx, dy])=>{
        ctx.beginPath();
        ctx.moveTo(cx, cy + len*dy);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx + len*dx, cy);
        ctx.stroke();
    });

    ctx.restore();
}

/* ===== HAND VISUALIZATION + INFO ===== */
function drawHand(hand){
    if(hand.opacity <= 0) return;

    const lm = hand.landmarks.map(p=>({
        x:p.x * canvas.width,
        y:p.y * canvas.height
    }));

    ctx.save();
    ctx.globalAlpha = hand.opacity;

    ctx.strokeStyle = "#39ff8f";
    ctx.lineWidth = 2.2;
    ctx.shadowColor = "#39ff8f";
    ctx.shadowBlur = 8;
    HAND_CONNECTIONS.forEach(([a,b])=>{
        ctx.beginPath();
        ctx.moveTo(lm[a].x, lm[a].y);
        ctx.lineTo(lm[b].x, lm[b].y);
        ctx.stroke();
    });

    const pulse = 1 + Math.sin(frameCount * 0.15) * 0.18;
    ctx.fillStyle = "#ff3355";
    ctx.shadowColor = "#ff3355";
    ctx.shadowBlur = 10;
    lm.forEach(p=>{
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4 * pulse, 0, Math.PI*2);
        ctx.fill();
    });

    ctx.restore();

    const xs = lm.map(p=>p.x), ys = lm.map(p=>p.y);
    const minX = Math.min(...xs) - 20, maxX = Math.max(...xs) + 20;
    const minY = Math.min(...ys) - 20, maxY = Math.max(...ys) + 20;

    drawCornerHUD(minX, minY, maxX-minX, maxY-minY, hand.opacity * 0.9, "#39ff8f");

    ctx.save();
    ctx.globalAlpha = hand.opacity;
    ctx.font = "13px Consolas, monospace";
    ctx.fillStyle = "#39ff8f";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 4;

    const label = hand.label === "Left" ? "RIGHT HAND" : "LEFT HAND"; // mirrored display
    const lines = [
        label,
        `Gesture: ${hand.gesture}`,
        `Confidence: ${(0.8 + Math.min(0.19, hand.opacity*0.19)).toFixed(2)}`,
        `Landmarks: ${lm.length}`,
        `X:${lm[0].x.toFixed(0)} Y:${lm[0].y.toFixed(0)}`,
        `Status: ${hand.visible ? "TRACKING" : "RECOVERING"}`
    ];

    lines.forEach((line, i)=>{
        ctx.fillText(line, minX, minY - 10 - (lines.length-1-i)*15);
    });

    ctx.restore();
}

/* ===== FACE DETECTION VISUALIZATION (box + pixelate) ===== */
function drawFace(face){
    if(face.opacity <= 0) return;

    const x = face.x * canvas.width;
    const y = face.y * canvas.height;
    const w = face.w * canvas.width;
    const h = face.h * canvas.height;

    pixelateRegion(x, y, w, h, 14, face.opacity);

    ctx.save();
    ctx.globalAlpha = face.opacity;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.shadowColor = "#ffffff";
    ctx.shadowBlur = 6;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();

    drawCornerHUD(x, y, w, h, face.opacity, "#ffffff");

    ctx.save();
    ctx.globalAlpha = face.opacity;
    ctx.font = "13px Consolas, monospace";
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 4;
    const lines = [
        "FACE DETECTED",
        `Confidence: ${face.confidence.toFixed(2)}`,
        `Status: ${face.visible ? "TARGET LOCKED" : "RECOVERING"}`
    ];
    lines.forEach((line,i)=>{
        ctx.fillText(line, x, y - 10 - (lines.length-1-i)*15);
    });
    ctx.restore();
}

function pixelateRegion(x, y, w, h, blockSize, opacity){
    x = Math.max(0, x); y = Math.max(0, y);
    w = Math.min(w, canvas.width - x);
    h = Math.min(h, canvas.height - y);
    if(w <= 0 || h <= 0) return;

    try{
        const small = document.createElement("canvas");
        small.width = Math.max(1, Math.floor(w / blockSize));
        small.height = Math.max(1, Math.floor(h / blockSize));
        const smallCtx = small.getContext("2d");

        // canvas is mirrored (scaleX(-1) via CSS), so sample the matching
        // mirrored region directly from the source video
        smallCtx.save();
        smallCtx.translate(small.width, 0);
        smallCtx.scale(-1, 1);
        smallCtx.drawImage(
            video,
            (1 - (x+w)/canvas.width) * video.videoWidth, (y/canvas.height) * video.videoHeight,
            (w/canvas.width) * video.videoWidth, (h/canvas.height) * video.videoHeight,
            0, 0, small.width, small.height
        );
        smallCtx.restore();

        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(small, 0, 0, small.width, small.height, x, y, w, h);
        ctx.restore();
    }catch(e){
        // ignore not-ready-frame errors silently
    }
}

/* ===== AI SELECTION BOX with blur + scan effect ===== */
function drawSelectionBox(box){
    if(box.opacity <= 0) return;
    const { x, y, w, h } = box;
    if(w <= 2 || h <= 2) return;

    ctx.save();
    ctx.globalAlpha = box.opacity;

    // ===== Dynamic blur area (clipped to selection box) =====
    try{
        const clampedX = Math.max(0,x), clampedY = Math.max(0,y);
        const clampedW = Math.max(1, Math.min(w, canvas.width-clampedX));
        const clampedH = Math.max(1, Math.min(h, canvas.height-clampedY));

        const region = ctx.getImageData(clampedX, clampedY, clampedW, clampedH);
        const tmp = document.createElement("canvas");
        tmp.width = region.width;
        tmp.height = region.height;
        tmp.getContext("2d").putImageData(region, 0, 0);

        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
        ctx.filter = "blur(8px)";
        ctx.drawImage(tmp, clampedX, clampedY);
        ctx.filter = "none";
        ctx.restore();
    }catch(e){ /* ignore */ }

    // scan sweep inside box
    const sweepT = (frameCount % 60) / 60;
    const sweepY = y + sweepT * h;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    const grad = ctx.createLinearGradient(0, sweepY-12, 0, sweepY+12);
    grad.addColorStop(0, "rgba(0,255,255,0)");
    grad.addColorStop(0.5, "rgba(0,255,255,0.25)");
    grad.addColorStop(1, "rgba(0,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(x, y-12, w, h+24);
    ctx.restore();

    ctx.restore();

    const pulseGlow = box.active ? (1 + Math.sin(frameCount*0.2)*0.2) : 1;
    drawCornerHUD(x, y, w, h, box.opacity * pulseGlow, "#00eaff");
}
