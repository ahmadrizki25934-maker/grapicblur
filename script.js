const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const errorMsg = document.getElementById("error-message");

// ===== PERFORMANCE OPTIMIZATION & RE-ALIGNMENT LOOP =====
function processAndRender(timestamp) {
    // Hitung FPS global
    fps = Math.round(1000 / (timestamp - lastTime));
    lastTime = timestamp;

    // Animasi Scanline Global
    scanLineY = (scanLineY + 2) % canvas.height;
    if (pulseDirection === 1) {
        pulseScale += 0.005;
        if (pulseScale >= 1.05) pulseDirection = -1;
    } else {
        pulseScale -= 0.005;
        if (pulseScale <= 0.95) pulseDirection = 1;
    }

    // Mengunci ukuran canvas agar 100% pas menimpa elemen video asli
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 1. CYBER HUD BACKGROUND: Grid Transparan Seluruh Layar
    ctx.strokeStyle = "rgba(0, 255, 128, 0.04)";
    ctx.lineWidth = 1;
    const gridSize = 40;
    for (let x = 0; x < canvas.width; x += gridSize) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += gridSize) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }

    // Tampilkan Global FPS HUD
    ctx.fillStyle = "rgba(0, 255, 128, 0.8)";
    ctx.font = "bold 14px monospace";
    ctx.fillText(`SYS_FPS: ${fps} | VISION_MODE: ACTIVE`, 20, 30);

    // 2. FACE PROCESSING (Smoothing, Pixelate & Cyber Box)
    let faceFoundThisFrame = false;
    if (latestFaceResults && latestFaceResults.detections && latestFaceResults.detections.length > 0) {
        faceFoundThisFrame = true;
        const rawFace = latestFaceResults.detections[0];
        const bbox = rawFace.boundingBox;
        
        const lerpFactor = 0.2;
        smoothState.face.box.xCenter += (bbox.xCenter - smoothState.face.box.xCenter) * lerpFactor;
        smoothState.face.box.yCenter += (bbox.yCenter - smoothState.face.box.yCenter) * lerpFactor;
        smoothState.face.box.width += (bbox.width - smoothState.face.box.width) * lerpFactor;
        smoothState.face.box.height += (bbox.height - smoothState.face.box.height) * lerpFactor;
        smoothState.face.confidence = rawFace.score[0];
        smoothState.face.active = true;
        smoothState.face.fade = Math.min(1, smoothState.face.fade + 0.1);
    } else {
        smoothState.face.fade = Math.max(0, smoothState.face.fade - 0.05);
        if (smoothState.face.fade === 0) smoothState.face.active = false;
    }

    if (smoothState.face.active) {
        ctx.save();
        ctx.globalAlpha = smoothState.face.fade;

        const fW = smoothState.face.box.width * canvas.width;
        const fH = smoothState.face.box.height * canvas.height;
        const fX = (smoothState.face.box.xCenter * canvas.width) - fW / 2;
        const fY = (smoothState.face.box.yCenter * canvas.height) - fH / 2;

        // Efek Pixelate pada Area Wajah Terdeteksi (Diselaraskan dengan orientasi mirror)
        const sampleSize = 14;
        for (let y = Math.max(0, fY); y < Math.min(canvas.height, fY + fH); y += sampleSize) {
            for (let x = Math.max(0, fX); x < Math.min(canvas.width, fX + fW); x += sampleSize) {
                const mirrorX = canvas.width - x - sampleSize; 
                if (mirrorX >= 0 && mirrorX < canvas.width) {
                    ctx.drawImage(video, mirrorX, y, sampleSize, sampleSize, x, y, sampleSize, sampleSize);
                }
            }
        }

        ctx.strokeStyle = `rgba(255, 255, 255, ${0.4 * pulseScale})`;
        ctx.lineWidth = 2;
        ctx.strokeRect(fX, fY, fW, fH);

        ctx.fillStyle = "#ffffff";
        ctx.font = "11px monospace";
        ctx.fillText(`[FACE DETECTED]`, fX, fY - 35);
        ctx.fillText(`CONF: ${Math.round(smoothState.face.confidence * 100)}%`, fX, fY - 22);
        ctx.fillText(`STATUS: TARGET LOCKED`, fX, fY - 10);
        ctx.restore();
    }

    // 3. HANDS PROCESSING & DYNAMIC SELECTION BOX RE-ALIGNMENT
    let detectedIndices = new Set();
    if (latestHandResults && latestHandResults.multiHandLandmarks) {
        latestHandResults.multiHandLandmarks.forEach((landmarks, idx) => {
            const classification = latestHandResults.multiHandedness[idx];
            const sideLabel = classification.label === "Left" ? "RIGHT" : "LEFT";
            const confidence = classification.score;

            let state = smoothState.hands[idx] || smoothState.hands[0];
            state.active = true;
            state.label = sideLabel;
            state.confidence = confidence;
            state.gesture = recognizeGesture(landmarks);
            detectedIndices.add(idx);

            // Jitter-free Adaptive Smoothing via LERP
            for (let i = 0; i < 21; i++) {
                const dx = Math.abs(landmarks[i].x - state.landmarks[i].x);
                const dynamicLerp = dx > 0.05 ? 0.45 : 0.20;
                state.landmarks[i].x += (landmarks[i].x - state.landmarks[i].x) * dynamicLerp;
                state.landmarks[i].y += (landmarks[i].y - state.landmarks[i].y) * dynamicLerp;
                state.landmarks[i].z += (landmarks[i].z - state.landmarks[i].z) * dynamicLerp;
            }
            state.fade = Math.min(1, state.fade + 0.15);
        });
    }

    for (let i = 0; i < smoothState.hands.length; i++) {
        if (!detectedIndices.has(i)) {
            smoothState.hands[i].fade = Math.max(0, smoothState.hands[i].fade - 0.08);
            if (smoothState.hands[i].fade === 0) smoothState.hands[i].active = false;
        }
    }

    smoothState.hands.forEach((hand) => {
        if (!hand.active) return;

        ctx.save();
        ctx.globalAlpha = hand.fade;

        // Garis Sambungan Tangan (Hijau Neon Cyber)
        ctx.strokeStyle = "rgba(0, 255, 128, 0.8)";
        ctx.shadowBlur = 10;
        ctx.shadowColor = "rgba(0, 255, 128, 0.5)";
        ctx.lineWidth = 3;
        
        HAND_CONNECTIONS.forEach(([startIdx, endIdx]) => {
            const p1 = hand.landmarks[startIdx];
            const p2 = hand.landmarks[endIdx];
            ctx.beginPath();
            ctx.moveTo(p1.x * canvas.width, p1.y * canvas.height);
            ctx.lineTo(p2.x * canvas.width, p2.y * canvas.height);
            ctx.stroke();
        });

        // Titik Landmark (Merah Neon Cyber)
        ctx.shadowBlur = 12;
        ctx.shadowColor = "rgba(255, 50, 50, 0.8)";
        hand.landmarks.forEach((lm) => {
            ctx.fillStyle = "rgba(255, 51, 51, 0.9)";
            ctx.beginPath();
            ctx.arc(lm.x * canvas.width, lm.y * canvas.height, 5 * pulseScale, 0, 2 * Math.PI);
            ctx.fill();
        });

        // Informasi Realtime HUD di Dekat Pergelangan Tangan
        const wristPos = hand.landmarks[0];
        ctx.shadowBlur = 0;
        ctx.fillStyle = "rgba(0, 255, 128, 0.9)";
        ctx.font = "bold 11px monospace";
        const hX = wristPos.x * canvas.width + 15;
        let hY = wristPos.y * canvas.height;

        ctx.fillText(`// ${hand.label} HAND`, hX, hY);
        ctx.fillText(`GESTURE: ${hand.gesture}`, hX, hY + 14);
        ctx.fillText(`CONF   : ${Math.round(hand.confidence * 100)}%`, hX, hY + 28);
        ctx.fillText(`POS_X  : ${Math.round(wristPos.x * canvas.width)}`, hX, hY + 42);
        ctx.fillText(`POS_Y  : ${Math.round(wristPos.y * canvas.height)}`, hX, hY + 66);
        ctx.fillText(`STATUS : ENGAGED`, hX, hY + 70);

        // ===== AI SELECTION BOX RE-ORIENTATION & STRETCH FIX =====
        const thumb = hand.landmarks[4];
        const index = hand.landmarks[8];
        
        // Murni mengikuti posisi ujung jari secara realtime tanpa batasan aspek rasio kaku
        const targetLeft = Math.min(thumb.x, index.x) * canvas.width;
        const targetRight = Math.max(thumb.x, index.x) * canvas.width;
        const targetTop = Math.min(thumb.y, index.y) * canvas.height;
        const targetBottom = Math.max(thumb.y, index.y) * canvas.height;

        // LERP Kotak Seleksi (Sangat halus mengikuti stretch pergerakan memanjang/melebar)
        const boxLerp = 0.25;
        const sb = smoothState.selectionBox;
        sb.left += (targetLeft - sb.left) * boxLerp;
        sb.right += (targetRight - sb.right) * boxLerp;
        sb.top += (targetTop - sb.top) * boxLerp;
        sb.bottom += (targetBottom - sb.bottom) * boxLerp;
        sb.active = true;
        sb.fade = Math.min(1, sb.fade + 0.1);

        ctx.restore();
    });

    let handStillActive = smoothState.hands.some(h => h.active);
    if (!handStillActive) {
        smoothState.selectionBox.fade = Math.max(0, smoothState.selectionBox.fade - 0.1);
        if (smoothState.selectionBox.fade === 0) smoothState.selectionBox.active = false;
    }

    if (smoothState.selectionBox.active) {
        ctx.save();
        ctx.globalAlpha = smoothState.selectionBox.fade;
        
        const sb = smoothState.selectionBox;
        const boxWidth = sb.right - sb.left;
        const boxHeight = sb.bottom - sb.top;

        // Kotak hanya dirender jika jarak jari memanjang (bisa di-stretch secara fleksibel)
        if (boxWidth > 2 && boxHeight > 2) {
            // A. DYNAMIC STRATCH BLUR AREA
            ctx.save();
            ctx.beginPath();
            ctx.rect(sb.left, sb.top, boxWidth, boxHeight);
            ctx.clip();
            
            ctx.save();
            ctx.scale(-1, 1);
            ctx.filter = "blur(12px) brightness(1.1) contrast(1.1)";
            ctx.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
            ctx.restore();
            
            // B. SCAN LINE EFFECT
            ctx.fillStyle = "rgba(0, 255, 128, 0.08)";
            ctx.fillRect(sb.left, sb.top, boxWidth, boxHeight);
            
            ctx.strokeStyle = "rgba(0, 255, 128, 0.5)";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            const currentScanY = sb.top + (scanLineY % boxHeight);
            ctx.moveTo(sb.left, currentScanY);
            ctx.lineTo(sb.right, currentScanY);
            ctx.stroke();
            ctx.restore();

            // C. HUD CORNER BOX FORMAT
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 3;
            ctx.shadowBlur = 10;
            ctx.shadowColor = "rgba(255, 255, 255, 0.8)";
            // Ukuran siku dinamis mendeteksi besar kecilnya ukuran stretch box
            const lineLen = Math.min(15, boxWidth * 0.3, boxHeight * 0.3);

            // Kiri Atas
            ctx.beginPath();
            ctx.moveTo(sb.left, sb.top + lineLen); ctx.lineTo(sb.left, sb.top); ctx.lineTo(sb.left + lineLen, sb.top);
            ctx.stroke();
            // Kanan Atas
            ctx.beginPath();
            ctx.moveTo(sb.right, sb.top + lineLen); ctx.lineTo(sb.right, sb.top); ctx.lineTo(sb.right - lineLen, sb.top);
            ctx.stroke();
            // Kiri Bawah
            ctx.beginPath();
            ctx.moveTo(sb.left, sb.bottom - lineLen); ctx.lineTo(sb.left, sb.bottom); ctx.lineTo(sb.left + lineLen, sb.bottom);
            ctx.stroke();
            // Kanan Bawah
            ctx.beginPath();
            ctx.moveTo(sb.right, sb.bottom - lineLen); ctx.lineTo(sb.right, sb.bottom); ctx.lineTo(sb.right - lineLen, sb.bottom);
            ctx.stroke();
            
            ctx.shadowBlur = 0;
            ctx.fillStyle = "#ffffff";
            ctx.font = "bold 10px monospace";
            ctx.fillText(`AI_VISION_TARGET [W:${Math.round(boxWidth)} H:${Math.round(boxHeight)}]`, sb.left, sb.top - 8);
        }
        ctx.restore();
    }

    requestAnimationFrame(processAndRender);
}
