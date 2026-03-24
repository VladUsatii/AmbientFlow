# AmbientFlow

I can't focus, so I built a really good ambient music tool that reads my brainwaves and establishes salient musical patterns to keep me engaged. At the moment, I measure frontier metrics, and EEG code is not deployed yet (for obvious reasons).

### Getting Started

To run this and finally be able to focus, just do

```bash
pip install -r requirements.txt
uvicorn app:app --reload --host 127.0.0.1 --port 8000
```

Boom. Open it up in `127.0.0.1:8000` and press `Play`. Infinite focus-mode ambience for free, constantly changing waveform.