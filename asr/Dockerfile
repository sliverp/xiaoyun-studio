FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 ca-certificates && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir sherpa-onnx==1.13.7 numpy==2.5.3 fastapi==0.135.1 uvicorn==0.42.0 python-multipart==0.0.22
COPY server.py download.py /app/
ENV OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 PYTHONUNBUFFERED=1
CMD ["sh", "-c", "python /app/download.py && python /app/server.py"]
