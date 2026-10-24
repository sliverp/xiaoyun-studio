"""Loopback OpenAI-compatible transcription service using SenseVoice INT8."""
import asyncio
import subprocess
import numpy as np
import sherpa_onnx
import uvicorn
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from starlette.concurrency import run_in_threadpool

app = FastAPI(title='Xiaoyun Studio SenseVoice transcription')
recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
    model='/models/model.int8.onnx', tokens='/models/tokens.txt',
    num_threads=2, use_itn=True, language='auto', provider='cpu',
)
lock = asyncio.Lock()


def decode(audio: bytes) -> str:
    """Decode at most one minute of audio without enabling network protocols."""
    try:
        result = subprocess.run(
            ['ffmpeg', '-v', 'error', '-protocol_whitelist', 'pipe', '-i', 'pipe:0',
             '-t', '60', '-f', 'f32le', '-acodec', 'pcm_f32le', '-ar', '16000', '-ac', '1', 'pipe:1'],
            input=audio, capture_output=True, timeout=20, check=True,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise HTTPException(status_code=400, detail='Invalid or unsupported audio') from error
    samples = np.frombuffer(result.stdout, dtype=np.float32)
    if len(samples) == 0:
        return ''
    stream = recognizer.create_stream()
    stream.accept_waveform(16000, samples)
    recognizer.decode_stream(stream)
    return stream.result.text.strip()


@app.post('/v1/audio/transcriptions')
async def transcribe(file: UploadFile = File(...), model: str = Form('sensevoice')):
    if model not in ('sensevoice', 'whisper-1'):
        raise HTTPException(status_code=400, detail='Unknown transcription model')
    audio = await file.read(16 * 1024 * 1024 + 1)
    if len(audio) > 16 * 1024 * 1024:
        raise HTTPException(status_code=413, detail='Audio exceeds 16 MiB')
    async with lock:
        text = await run_in_threadpool(decode, audio)
    return {'text': text}


@app.get('/health')
async def health():
    return {'status': 'ok', 'device': 'cpu', 'model': 'SenseVoice INT8', 'models_loaded': ['sensevoice']}


if __name__ == '__main__':
    uvicorn.run(app, host='0.0.0.0', port=10095)
