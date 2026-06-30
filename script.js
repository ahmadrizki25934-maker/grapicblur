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
   ===== FIX: Cover-fit transform =====
   The <video> uses CSS object-fit:cover, which crops the
   stream to fill the container. MediaPipe landmarks are
   normalized (0..1) against the FULL, uncropped video frame.
   If we just draw at landmark*canvas.width, the drawing
   ignores the crop and drifts off the visible hand.

   Fix: size the canvas to the container's actual on-screen
   pixel size (not the raw video resolution), then compute the
   same "cover" scale/offset the browser applies to the video,
   and map every landmark through it before drawing. This keeps
   the overlay glued to the hand inside the visible frame.
   ========================================================= */

let coverTransform = { scale:1, offsetX:0, offsetY:0, videoW:1, videoH:1 };

function updateCanvasSizeAndTransform(){
    const container = canvas.parentElement;
    const cw = container.clientWidth;
    const ch = container.clientHeight;

    if(canvas.width !== cw || canvas.height !== ch){
        canvas.width = cw;
        canvas.height = ch;
    }

    const vw = video.videoWidth || cw;
    const vh = video.videoHeight || ch;

    // "cover" scale = the larger of the two ratios, so the video
    // fully fills the container (cropping the overflow), matching
    // exactly what CSS object-fit:cover does to the <video>.
    const scale = Math.max(cw / vw, ch / vh);
    const offsetX = (cw - vw * scale) / 2;
    const offsetY = (ch - vh * scale) / 2;

    coverTransform = { scale, offsetX, offsetY, videoW:vw, videoH:vh };
}

// landmark (normalized 0..1, relative to full video frame) -> canvas pixel
function toCanvasPoint(landmark){
    const { scale, offsetX, offsetY, videoW, videoH } = coverTransform;
    return {
        x: landmark.x * videoW * scale + offsetX,
        y: landmark.y * videoH * scale + offsetY
    };
}

// inverse: canvas pixel -> raw video pixel (used for sampling pixelate/blur source)
function canvasPointToVideoPixel(x, y){
    const { scale, offsetX, offsetY } = coverTransform;
    return {
        x: (x - offsetX) / scale,
        y: (y - offsetY) / scale
    };
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
   ===== AI SELECTION BOX (4-corner flexible quad) =====
   Corners follow exactly 4 tracked points:
     left index tip, left thumb tip, right thumb tip, right index tip
   This makes a flexible 4-sided shape (not a fixed rectangle)
   that deforms naturally as both hands move, while always
   keeping 4 sides / 4 corners locked to those fingertips.
   ========================================================= */

let selectionQuad = null; // { points:[{x,y}x4], opacity, active }

function updateSelectionBox(){

    const leftHand = smoothedHands.find(h => h.visible && h.label === "Left");
    const rightHand = smoothedHands.find(h => h.visible && h.label === "Right");

    if(leftHand && rightHand){

        // fixed point identity + order -> stable quad winding, no flicker
        const targetPoints = [
            toCanvasPoint(leftHand.landmarks[8]),  // left index tip
            toCanvasPoint(leftHand.landmarks[4]),  // left thumb tip
            toCanvasPoint(rightHand.landmarks[4]), // right thumb tip
            toCanvasPoint(rightHand.landmarks[8])  // right index tip
        ];

        if(!selectionQuad){
            selectionQuad = { points: targetPoints.map(p=>({...p})), opacity:0, active:true };
        }else{
            const a = 0.25; // smoothing toward target (on top of landmark EMA already applied)
            selectionQuad.points = selectionQuad.points.map((p,i)=>({
                x: lerp(p.x, targetPoints[i].x, a),
                y: lerp(p.y, targetPoints[i].y, a)
            }));
            selectionQuad.opacity = Math.min(1, selectionQuad.opacity + 0.12);
            selectionQuad.active = true;
        }
    }else if(selectionQuad){
        selectionQuad.opacity = Math.max(0, selectionQuad.opacity - 0.08);
        selectionQuad.active = false;
        if(selectionQuad.opacity <= 0) selectionQuad = null;
    }
}

/* =========================================================
   ===== RENDER LOOP (Canvas API, single canvas, rAF) =====
   ========================================================= */

function render(){

    frameCount++;

    updateCanvasSizeAndTransform();

    updateSmoothedHands();
    updateSmoothedFace();
    updateSelectionBox();

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    drawGrid();
    drawScanLine();

    smoothedHands.forEach(drawHand);
    if(smoothedFace) drawFace(smoothedFace);
    if(selectionQuad) drawSelectionQuad(selectionQuad);

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

    const lm = hand.landmarks.map(p => toCanvasPoint(p));

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

    const topLeft = toCanvasPoint({ x: face.x, y: face.y });
    const bottomRight = toCanvasPoint({ x: face.x + face.w, y: face.y + face.h });
    const x = topLeft.x;
    const y = topLeft.y;
    const w = bottomRight.x - topLeft.x;
    const h = bottomRight.y - topLeft.y;

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

        // The whole <canvas> element is mirrored once via CSS (scaleX(-1)),
        // same as the <video>. So we draw/sample in the SAME unmirrored
        // coordinate space as the video - no manual flip needed here.
        const srcTopLeft = canvasPointToVideoPixel(x, y);
        const srcBottomRight = canvasPointToVideoPixel(x + w, y + h);

        smallCtx.drawImage(
            video,
            srcTopLeft.x, srcTopLeft.y,
            srcBottomRight.x - srcTopLeft.x, srcBottomRight.y - srcTopLeft.y,
            0, 0, small.width, small.height
        );

        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(small, 0, 0, small.width, small.height, x, y, w, h);
        ctx.restore();
    }catch(e){
        // ignore not-ready-frame errors silently
    }
}

/* ===== AI SELECTION QUAD: flexible 4-sided shape, blur follows its sides ===== */
function drawSelectionQuad(quad){
    if(quad.opacity <= 0) return;
    const pts = quad.points;

    // bounding box only used to limit how much pixel data we touch (perf),
    // the actual blur/scan are clipped to the quad PATH so they hug the sides
    const xs = pts.map(p=>p.x), ys = pts.map(p=>p.y);
    const minX = Math.max(0, Math.floor(Math.min(...xs)) - 4);
    const minY = Math.max(0, Math.floor(Math.min(...ys)) - 4);
    const maxX = Math.min(canvas.width, Math.ceil(Math.max(...xs)) + 4);
    const maxY = Math.min(canvas.height, Math.ceil(Math.max(...ys)) + 4);
    const bw = maxX - minX, bh = maxY - minY;
    if(bw <= 2 || bh <= 2) return;

    function quadPath(){
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        ctx.lineTo(pts[1].x, pts[1].y);
        ctx.lineTo(pts[2].x, pts[2].y);
        ctx.lineTo(pts[3].x, pts[3].y);
        ctx.closePath();
    }

    ctx.save();
    ctx.globalAlpha = quad.opacity;

    // ===== Lightweight shape-following blur =====
    // Only sample/blur the small bounding-box region (cheap), then clip
    // the result to the exact quad path so the blur hugs every side and
    // re-shapes itself live as the fingertips move.
    try{
        const region = ctx.getImageData(minX, minY, bw, bh);
        const tmp = document.createElement("canvas");
        tmp.width = bw;
        tmp.height = bh;
        tmp.getContext("2d").putImageData(region, 0, 0);

        ctx.save();
        quadPath();
        ctx.clip();
        ctx.filter = "blur(6px)";
        ctx.drawImage(tmp, minX, minY);
        ctx.filter = "none";
        ctx.restore();
    }catch(e){ /* ignore */ }

    // scan sweep, clipped to the same quad path
    const sweepT = (frameCount % 60) / 60;
    const sweepY = minY + sweepT * bh;
    ctx.save();
    quadPath();
    ctx.clip();
    const grad = ctx.createLinearGradient(0, sweepY-12, 0, sweepY+12);
    grad.addColorStop(0, "rgba(0,255,255,0)");
    grad.addColorStop(0.5, "rgba(0,255,255,0.22)");
    grad.addColorStop(1, "rgba(0,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(minX, minY-12, bw, bh+24);
    ctx.restore();

    // thin outline along the 4 sides so the shape itself reads clearly
    ctx.save();
    quadPath();
    ctx.strokeStyle = "rgba(0,234,255,0.5)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    ctx.restore();

    // L-shaped HUD bracket at each of the 4 fingertip corners, each one
    // drawn along its two adjacent sides so it always matches the shape
    const pulseGlow = quad.active ? (1 + Math.sin(frameCount*0.2)*0.2) : 1;
    drawQuadCornerHUD(pts, quad.opacity * pulseGlow, "#00eaff");
}

function drawQuadCornerHUD(pts, opacity, color){
    ctx.save();
    ctx.globalAlpha = clamp(opacity, 0, 1);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.lineCap = "round";

    const n = pts.length;
    for(let i=0;i<n;i++){
        const cur = pts[i];
        const prev = pts[(i-1+n)%n];
        const next = pts[(i+1)%n];

        const toPrev = { x: prev.x - cur.x, y: prev.y - cur.y };
        const toNext = { x: next.x - cur.x, y: next.y - cur.y };
        const lenPrev = Math.hypot(toPrev.x, toPrev.y) || 1;
        const lenNext = Math.hypot(toNext.x, toNext.y) || 1;

        const bracketLen = Math.min(lenPrev, lenNext) * 0.35 + 6;

        const p1 = { x: cur.x + (toPrev.x/lenPrev)*bracketLen, y: cur.y + (toPrev.y/lenPrev)*bracketLen };
        const p2 = { x: cur.x + (toNext.x/lenNext)*bracketLen, y: cur.y + (toNext.y/lenNext)*bracketLen };

        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(cur.x, cur.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
    }

    ctx.restore();
}
