const video = document.getElementById("video");
const canvas = document.getElementById("canvas");

const ctx = canvas.getContext("2d");

async function startCamera(){

    const stream = await navigator.mediaDevices.getUserMedia({

        video:true

    });

    video.srcObject = stream;

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

    minDetectionConfidence:0.7,

    minTrackingConfidence:0.7

});

hands.onResults(onResults);

const camera = new Camera(video,{

    onFrame:async()=>{

        await hands.send({

            image:video

        });

    },

    width:1280,

    height:720

});

camera.start();

function onResults(results){

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    ctx.clearRect(0,0,canvas.width,canvas.height);

    if(results.multiHandLandmarks){

        for(const landmarks of results.multiHandLandmarks){

            drawConnectors(
                ctx,
                landmarks,
                HAND_CONNECTIONS,
                {
                    color:"#ffffff",
                    lineWidth:2
                }
            );

            drawLandmarks(
                ctx,
                landmarks,
                {
                    color:"#00ffff",
                    fillColor:"#ffffff",
                    radius:5
                }
            );

        }

    }

    // ====== Dynamic AI Finger Frame (new feature) ======
    const now = performance.now();
    const dt = FingerFrame.state.lastTimestamp
        ? now - FingerFrame.state.lastTimestamp
        : 16;
    FingerFrame.state.lastTimestamp = now;

    FingerFrame.updatePoints(results, dt);
    FingerFrame.updateOpacity(dt);
    FingerFrame.draw(now);

}

/* ============================================================
   DYNAMIC AI FINGER FRAME
   - Tracks 4 landmarks only: Left Index(8), Left Thumb(4),
     Right Index(8), Right Thumb(4)
   - Builds a 4-point polygon HUD frame between them
   - Adaptive EMA smoothing per point
   - Fade in/out when hands are lost/regained
   - Polygon-clipped real-time pixel blur inside the frame
   - Futuristic L-shaped glowing corner brackets
   - Subtle pulse glow + scanline sweep animation
   This module is self-contained and does not touch the
   existing hand tracking / camera / landmark drawing logic.
   ============================================================ */

const FingerFrame = (() => {

    // ---- low-res offscreen canvas used to create the pixel/blur effect ----
    const pixelCanvas = document.createElement("canvas");
    const pixelCtx = pixelCanvas.getContext("2d");

    // how many destination pixels each "block" of the pixelation covers
    const PIXEL_BLOCK_SIZE = 16;

    function createPointState(){
        return {
            x: 0, y: 0,      // raw landmark position (last seen)
            sx: 0, sy: 0,    // smoothed position (what we actually draw)
            visible: false,  // detected in the current frame
            initialized: false
        };
    }

    const state = {
        points: {
            leftIndex: createPointState(),
            leftThumb: createPointState(),
            rightIndex: createPointState(),
            rightThumb: createPointState()
        },
        groupOpacity: 0,     // 0..1 fade for the whole frame
        lastTimestamp: null
    };

    function applyPoint(pointState, rawX, rawY){
        pointState.visible = true;
        pointState.x = rawX;
        pointState.y = rawY;

        if(!pointState.initialized){
            pointState.sx = rawX;
            pointState.sy = rawY;
            pointState.initialized = true;
            return;
        }

        // --- Adaptive smoothing (EMA) ---
        // slow movement -> small alpha -> heavier smoothing
        // fast movement -> larger alpha -> more responsive, less smoothing
        const dist = Math.hypot(rawX - pointState.sx, rawY - pointState.sy);
        const speedFactor = Math.min(dist / 40, 1); // 0 = slow, 1 = fast
        const alpha = 0.12 + speedFactor * 0.45;

        pointState.sx += (rawX - pointState.sx) * alpha;
        pointState.sy += (rawY - pointState.sy) * alpha;
    }

    function updatePoints(results){
        const pts = state.points;

        pts.leftIndex.visible = false;
        pts.leftThumb.visible = false;
        pts.rightIndex.visible = false;
        pts.rightThumb.visible = false;

        if(!results.multiHandLandmarks || !results.multiHandedness) return;

        for(let i = 0; i < results.multiHandLandmarks.length; i++){

            const landmarks = results.multiHandLandmarks[i];
            const handednessInfo = results.multiHandedness[i];
            if(!landmarks || !handednessInfo) continue;

            const label = handednessInfo.label; // "Left" or "Right"

            const thumbTip = landmarks[4];
            const indexTip = landmarks[8];
            if(!thumbTip || !indexTip) continue;

            const thumbX = thumbTip.x * canvas.width;
            const thumbY = thumbTip.y * canvas.height;
            const indexX = indexTip.x * canvas.width;
            const indexY = indexTip.y * canvas.height;

            if(label === "Left"){
                applyPoint(pts.leftThumb, thumbX, thumbY);
                applyPoint(pts.leftIndex, indexX, indexY);
            } else if(label === "Right"){
                applyPoint(pts.rightThumb, thumbX, thumbY);
                applyPoint(pts.rightIndex, indexX, indexY);
            }
        }
    }

    function updateOpacity(dt){
        const pts = state.points;
        const allVisible =
            pts.leftIndex.visible && pts.leftIndex.initialized &&
            pts.leftThumb.visible && pts.leftThumb.initialized &&
            pts.rightIndex.visible && pts.rightIndex.initialized &&
            pts.rightThumb.visible && pts.rightThumb.initialized;

        const target = allVisible ? 1 : 0;
        const fadeDurationMs = 320; // within the 250-400ms target
        const step = dt / fadeDurationMs;

        if(state.groupOpacity < target){
            state.groupOpacity = Math.min(target, state.groupOpacity + step);
        } else if(state.groupOpacity > target){
            state.groupOpacity = Math.max(target, state.groupOpacity - step);
        }
    }

    function getCorners(){
        const pts = state.points;
        return {
            topLeft:     { x: pts.leftIndex.sx,  y: pts.leftIndex.sy  },
            topRight:    { x: pts.rightIndex.sx, y: pts.rightIndex.sy },
            bottomRight: { x: pts.rightThumb.sx, y: pts.rightThumb.sy },
            bottomLeft:  { x: pts.leftThumb.sx,  y: pts.leftThumb.sy  }
        };
    }

    function buildFramePath(corners){
        ctx.beginPath();
        ctx.moveTo(corners.topLeft.x, corners.topLeft.y);
        ctx.lineTo(corners.topRight.x, corners.topRight.y);
        ctx.lineTo(corners.bottomRight.x, corners.bottomRight.y);
        ctx.lineTo(corners.bottomLeft.x, corners.bottomLeft.y);
        ctx.closePath();
    }

    function drawPixelatedRegion(corners, opacity){
        if(!video.videoWidth || !video.videoHeight) return;

        const lowW = Math.max(2, Math.floor(canvas.width / PIXEL_BLOCK_SIZE));
        const lowH = Math.max(2, Math.floor(canvas.height / PIXEL_BLOCK_SIZE));

        if(pixelCanvas.width !== lowW) pixelCanvas.width = lowW;
        if(pixelCanvas.height !== lowH) pixelCanvas.height = lowH;

        // downscale the live video into a tiny canvas
        pixelCtx.imageSmoothingEnabled = true;
        pixelCtx.drawImage(video, 0, 0, lowW, lowH);

        ctx.save();
        ctx.globalAlpha = opacity;
        buildFramePath(corners);
        ctx.clip(); // restrict drawing to the dynamic polygon only

        // upscale back without smoothing -> pixelation / sensor effect
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(pixelCanvas, 0, 0, lowW, lowH, 0, 0, canvas.width, canvas.height);

        ctx.restore();
    }

    function drawConnectingLines(corners, opacity){
        ctx.save();
        ctx.globalAlpha = opacity;
        buildFramePath(corners);
        ctx.strokeStyle = "rgba(255,255,255,0.32)";
        ctx.lineWidth = 1;
        ctx.shadowColor = "rgba(0,255,255,0.45)";
        ctx.shadowBlur = 6;
        ctx.stroke();
        ctx.restore();
    }

    function normalize(dx, dy){
        const len = Math.hypot(dx, dy) || 1;
        return { x: dx / len, y: dy / len };
    }

    function drawCornerBracket(p, neighborA, neighborB, length, opacity, glowPulse){
        const dirA = normalize(neighborA.x - p.x, neighborA.y - p.y);
        const dirB = normalize(neighborB.x - p.x, neighborB.y - p.y);

        const lenA = Math.min(length, Math.hypot(neighborA.x - p.x, neighborA.y - p.y) * 0.5);
        const lenB = Math.min(length, Math.hypot(neighborB.x - p.x, neighborB.y - p.y) * 0.5);

        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2.4;
        ctx.lineCap = "round";
        ctx.shadowColor = "#00ffff";
        ctx.shadowBlur = 8 + glowPulse * 7;

        ctx.beginPath();
        ctx.moveTo(p.x + dirA.x * lenA, p.y + dirA.y * lenA);
        ctx.lineTo(p.x, p.y);
        ctx.lineTo(p.x + dirB.x * lenB, p.y + dirB.y * lenB);
        ctx.stroke();
        ctx.restore();
    }

    function drawCornerBrackets(corners, opacity, timestampNow){
        const minX = Math.min(corners.topLeft.x, corners.topRight.x, corners.bottomLeft.x, corners.bottomRight.x);
        const maxX = Math.max(corners.topLeft.x, corners.topRight.x, corners.bottomLeft.x, corners.bottomRight.x);
        const minY = Math.min(corners.topLeft.y, corners.topRight.y, corners.bottomLeft.y, corners.bottomRight.y);
        const maxY = Math.max(corners.topLeft.y, corners.topRight.y, corners.bottomLeft.y, corners.bottomRight.y);

        const frameSize = Math.max(20, Math.min(maxX - minX, maxY - minY));
        const bracketLength = Math.min(60, Math.max(14, frameSize * 0.18));

        // gentle pulse breathing glow, 0..1
        const glowPulse = 0.5 + 0.5 * Math.sin(timestampNow / 450);

        drawCornerBracket(corners.topLeft, corners.topRight, corners.bottomLeft, bracketLength, opacity, glowPulse);
        drawCornerBracket(corners.topRight, corners.topLeft, corners.bottomRight, bracketLength, opacity, glowPulse);
        drawCornerBracket(corners.bottomRight, corners.topRight, corners.bottomLeft, bracketLength, opacity, glowPulse);
        drawCornerBracket(corners.bottomLeft, corners.topLeft, corners.bottomRight, bracketLength, opacity, glowPulse);
    }

    function drawScanLine(corners, timestampNow, opacity){
        const minY = Math.min(corners.topLeft.y, corners.topRight.y, corners.bottomLeft.y, corners.bottomRight.y);
        const maxY = Math.max(corners.topLeft.y, corners.topRight.y, corners.bottomLeft.y, corners.bottomRight.y);
        const minX = Math.min(corners.topLeft.x, corners.topRight.x, corners.bottomLeft.x, corners.bottomRight.x);
        const maxX = Math.max(corners.topLeft.x, corners.topRight.x, corners.bottomLeft.x, corners.bottomRight.x);

        if(maxY <= minY || maxX <= minX) return;

        const cycleMs = 2200;
        const progress = (timestampNow % cycleMs) / cycleMs;
        const lineY = minY + (maxY - minY) * progress;

        ctx.save();
        ctx.globalAlpha = opacity * 0.35;
        buildFramePath(corners);
        ctx.clip();

        const gradient = ctx.createLinearGradient(0, lineY - 3, 0, lineY + 3);
        gradient.addColorStop(0, "rgba(0,255,255,0)");
        gradient.addColorStop(0.5, "rgba(0,255,255,0.9)");
        gradient.addColorStop(1, "rgba(0,255,255,0)");

        ctx.fillStyle = gradient;
        ctx.fillRect(minX, lineY - 3, maxX - minX, 6);
        ctx.restore();
    }

    function draw(timestampNow){
        const opacity = state.groupOpacity;
        if(opacity <= 0.001) return;

        const corners = getCorners();

        drawPixelatedRegion(corners, opacity);
        drawScanLine(corners, timestampNow, opacity);
        drawConnectingLines(corners, opacity);
        drawCornerBrackets(corners, opacity, timestampNow);
    }

    return {
        state,
        updatePoints,
        updateOpacity,
        draw
    };

})();
