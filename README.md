# language-audio-app

Create bilingual audio lessons from French articles, prompts, or pasted passages.

## Development setup

The project is a full-stack app with a Flask backend and a React (Vite) frontend. Run them separately so you can iterate on each side without rebuilding the other.

### Backend (Flask)

The backend exposes REST endpoints on port **3030**. It relies on the OpenAI API for translation and text-to-speech synthesis.

1. Export your OpenAI API key before starting the server:

   ```bash
   export OPENAI_API_KEY="sk-..."
   ```

2. Create and activate a virtual environment, install dependencies, and launch the API:

   ```bash
   cd backend
   python -m venv .venv
   source .venv/bin/activate  # Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   python app.py
   ```

Available endpoints:

| Method | Path                 | Description |
| ------ | -------------------- | ----------- |
| POST   | `/api/fetch-text`    | Fetches French text from a URL, prompt, or pasted text. |
| POST   | `/api/generate-audio` | Splits confirmed text into sentences, translates to English, and returns base64 encoded French/English audio per sentence. |
| GET    | `/api/health`        | Lightweight health probe. |

### Frontend (React + Vite)

The Vite dev server (default port 5173) proxies requests to the Flask API.

```
cd frontend
npm install
npm run dev
```

When the dev server starts, open the printed URL (usually <http://localhost:5173>). The UI lets you:

- Pull French text from a URL, paste your own text, or ask ChatGPT to generate a passage.
- Edit and confirm the text before synthesizing.
- Generate per-sentence French audio, English translations, and English audio.
- Play the lesson with sentence-level navigation, toggleable subtitles, and a “Study” mode that replays the current sentence FR → EN → FR.

## Project structure

```
backend/
  app.py
  requirements.txt
frontend/
  index.html
  package.json
  public/
  src/
    App.jsx
    main.jsx
    styles.css
  vite.config.js
```
