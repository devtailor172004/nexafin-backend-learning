import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button } from './ui.jsx';

/**
 * Camera liveness test for the KYC review screen.
 *
 * Flow: start camera → run test (3s countdown + 6 captured frames) →
 * heuristic score (brightness range + frame-to-frame motion) → save result
 * to the backend as KYC liveness evidence.
 *
 * This is a demo/testing liveness check that runs fully in the browser —
 * no third-party SDK is involved.
 */
const FRAME_COUNT = 6;
const FRAME_INTERVAL_MS = 450;
const COUNTDOWN_SECONDS = 3;

const analyze = (frames) => {
    // frames: [{ dataUrl, brightness, diff }] — diff vs previous frame
    if (frames.length < 2) return { score: 0, passed: false, brightness: 0, motion: 0 };

    const brightness = frames.reduce((sum, f) => sum + f.brightness, 0) / frames.length;
    const diffs = frames.slice(1).map((f) => f.diff);
    const motion = diffs.reduce((sum, d) => sum + d, 0) / diffs.length;

    const brightOk = brightness >= 30 && brightness <= 230;
    const brightnessScore = brightOk ? 40 : 0;
    const motionScore = Math.min(40, Math.round(motion * 40));
    const completenessScore = frames.length >= FRAME_COUNT ? 20 : 0;

    const score = Math.min(100, brightnessScore + motionScore + completenessScore);
    return { score, passed: score >= 70, brightness: Math.round(brightness), motion: Number(motion.toFixed(2)) };
};

const measureFrame = (video, previousData) => {
    const width = video.videoWidth || 320;
    const height = video.videoHeight || 240;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, width, height);

    // Brightness + motion measured on a down-sampled copy for speed
    const sample = document.createElement('canvas');
    sample.width = 64;
    sample.height = 48;
    const sctx = sample.getContext('2d');
    sctx.drawImage(canvas, 0, 0, 64, 48);
    const pixels = sctx.getImageData(0, 0, 64, 48).data;

    let brightnessSum = 0;
    const gray = new Array(64 * 48);
    for (let i = 0, p = 0; i < pixels.length; i += 4, p += 1) {
        const value = (pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114);
        gray[p] = value;
        brightnessSum += value;
    }

    let diff = 0;
    if (previousData) {
        let total = 0;
        for (let p = 0; p < gray.length; p += 1) total += Math.abs(gray[p] - previousData[p]);
        diff = total / gray.length;
    }

    return { dataUrl: canvas.toDataURL('image/jpeg', 0.85), brightness: brightnessSum / gray.length, diff, gray };
};

export default function LivenessCheck({ onSave, savedAt }) {
    const videoRef = useRef(null);
    const streamRef = useRef(null);
    const [cameraOn, setCameraOn] = useState(false);
    const [cameraError, setCameraError] = useState(null);
    const [running, setRunning] = useState(false);
    const [countdown, setCountdown] = useState(null);
    const [progress, setProgress] = useState('');
    const [result, setResult] = useState(null);
    const [capturedSelfie, setCapturedSelfie] = useState(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    const stopCamera = useCallback(() => {
        if (streamRef.current) {
            streamRef.current.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
        }
        setCameraOn(false);
    }, []);

    useEffect(() => stopCamera, [stopCamera]);

    const startCamera = async () => {
        setCameraError(null);
        try {
            if (!navigator.mediaDevices?.getUserMedia) {
                throw new Error('Camera API not available in this browser.');
            }
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
                audio: false
            });
            streamRef.current = stream;
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                await videoRef.current.play().catch(() => {});
            }
            setCameraOn(true);
            setResult(null);
            setSaved(false);
        } catch (err) {
            setCameraError(err.message || 'Camera permission denied.');
        }
    };

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const runTest = async () => {
        if (!cameraOn || running) return;
        setRunning(true);
        setResult(null);
        setSaved(false);
        setCapturedSelfie(null);
        try {
            for (let s = COUNTDOWN_SECONDS; s > 0; s -= 1) {
                setCountdown(s);
                await sleep(1000);
            }
            setCountdown(null);

            const frames = [];
            let previousGray = null;
            for (let i = 0; i < FRAME_COUNT; i += 1) {
                setProgress(`Capturing frame ${i + 1} of ${FRAME_COUNT}…`);
                const measured = measureFrame(videoRef.current, previousGray);
                previousGray = measured.gray;
                frames.push({ dataUrl: measured.dataUrl, brightness: measured.brightness, diff: measured.diff });
                setCapturedSelfie(measured.dataUrl);
                if (i < FRAME_COUNT - 1) await sleep(FRAME_INTERVAL_MS);
            }

            setProgress('Analysing…');
            const analysis = analyze(frames);
            const finalResult = {
                ...analysis,
                frames: frames.length,
                captureMs: COUNTDOWN_SECONDS * 1000 + FRAME_COUNT * FRAME_INTERVAL_MS,
                challenge: 'multi-frame motion + exposure',
                selfie: frames[frames.length - 1].dataUrl
            };
            setResult(finalResult);
        } finally {
            setProgress('');
            setCountdown(null);
            setRunning(false);
        }
    };

    const save = async () => {
        if (!result || !onSave) return;
        setSaving(true);
        try {
            await onSave(result);
            setSaved(true);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
                <div>
                    <p className="text-xs font-semibold text-slate-300">Liveness check (camera)</p>
                    <p className="text-xs text-slate-400">
                        Starts the webcam, captures 6 frames over ~3s and scores brightness + motion. Demo/testing only — runs in your browser.
                    </p>
                </div>
                <Badge value={result ? (result.passed ? 'VERIFIED' : 'PENDING') : (savedAt ? 'VERIFIED' : 'PENDING')} />
            </div>

            <div className="relative overflow-hidden rounded-xl border border-slate-800 bg-black/60">
                <video
                    ref={videoRef}
                    muted
                    playsInline
                    autoPlay
                    className={`mx-auto h-48 w-full max-w-sm object-cover ${cameraOn ? '' : 'hidden'}`}
                />
                {!cameraOn && (
                    <div className="flex h-48 flex-col items-center justify-center gap-2 text-center text-xs text-slate-400">
                        <span className="text-2xl">📷</span>
                        <p>Camera is off</p>
                        {cameraError && <p className="max-w-xs text-rose-300">{cameraError}</p>}
                    </div>
                )}

                {countdown !== null && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                        <span className="text-5xl font-bold text-white">{countdown}</span>
                    </div>
                )}

                {capturedSelfie && (
                    <img
                        src={capturedSelfie}
                        alt="Last captured frame"
                        className="absolute bottom-2 right-2 h-16 w-12 rounded border border-slate-600 object-cover"
                    />
                )}

                {progress && (
                    <div className="absolute inset-x-0 bottom-0 bg-black/70 px-3 py-1 text-center text-xs text-sky-300">
                        {progress}
                    </div>
                )}
            </div>

            {result && (
                <div className={`space-y-1 rounded-lg border p-3 text-xs ${result.passed ? 'border-emerald-900/60 bg-emerald-950/30 text-emerald-200' : 'border-amber-900/60 bg-amber-950/30 text-amber-200'}`}>
                    <p className="font-semibold">
                        {result.passed ? 'Liveness PASSED' : 'Liveness needs review'} — score {result.score}/100
                    </p>
                    <p>Brightness {result.brightness} (needs 30–230) · Motion {result.motion} px · {result.frames} frames captured</p>
                </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
                {!cameraOn ? (
                    <Button type="button" variant="secondary" onClick={startCamera}>Start camera</Button>
                ) : (
                    <>
                        <Button type="button" onClick={runTest} disabled={running}>
                            {running ? 'Running…' : 'Run liveness test'}
                        </Button>
                        <Button type="button" variant="ghost" onClick={stopCamera} disabled={running}>Stop camera</Button>
                    </>
                )}
                {result && onSave && (
                    <Button type="button" variant="secondary" onClick={save} disabled={saving || saved}>
                        {saved ? 'Saved ✓' : saving ? 'Saving…' : 'Save result to KYC'}
                    </Button>
                )}
            </div>

            {saved && (
                <p className="text-xs text-emerald-300">Liveness evidence saved — it now appears under Documents in the journey.</p>
            )}
        </div>
    );
}
